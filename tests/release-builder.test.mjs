import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {buildReleaseArtifact} from '../src/release-builder.mjs';
import {validateReleaseIdentity} from '../src/release-identity.mjs';
import {validateRuntimeManifest} from '../src/runtime-manifest.mjs';
import {validateToolchainManifest} from '../src/toolchain-manifest.mjs';

const execFileAsync=promisify(execFile);
const BUILT_AT='2026-08-20T10:00:00.000Z';
const PROJECT_ROOT=fileURLToPath(new URL('..',import.meta.url));

async function git(root,args){
  const result=await execFileAsync('git',args,{
    cwd:root,
    encoding:'utf8',
    env:{...process.env,LC_ALL:'C'}
  });
  return result.stdout.trim();
}

function lockfile(name,version){
  return`${JSON.stringify({
    name,
    version,
    lockfileVersion:3,
    requires:true,
    packages:{'':{name,version}}
  },null,2)}\n`;
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-release-builder-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const repositoryRoot=path.join(root,'repository');
  const releasesRoot=path.join(root,'releases');
  await fsp.mkdir(repositoryRoot);
  await fsp.mkdir(releasesRoot);
  await git(repositoryRoot,['init','-q']);
  await git(repositoryRoot,['config','user.name','Release Builder Fixture']);
  await git(repositoryRoot,['config','user.email','release-builder@example.invalid']);
  await fsp.mkdir(path.join(repositoryRoot,'public'));
  await fsp.mkdir(path.join(repositoryRoot,'harness'));
  await fsp.writeFile(path.join(repositoryRoot,'.node-version'),'24.19.0\n');
  await fsp.writeFile(path.join(repositoryRoot,'package.json'),`${JSON.stringify({
    name:'release-builder-fixture',
    version:'3.0.0',
    private:true,
    type:'module',
    packageManager:'npm@11.17.0',
    scripts:{
      test:'node -e "process.stdout.write(\\"root-tests-ok\\\\n\\")"',
      verify:'node -e "process.stdout.write(\\"verify-ok\\\\n\\")"'
    }
  },null,2)}\n`);
  await fsp.writeFile(
    path.join(repositoryRoot,'package-lock.json'),
    lockfile('release-builder-fixture','3.0.0')
  );
  await fsp.writeFile(path.join(repositoryRoot,'harness','package.json'),`${JSON.stringify({
    name:'release-builder-harness-fixture',
    version:'1.0.0',
    private:true,
    type:'module'
  },null,2)}\n`);
  await fsp.writeFile(
    path.join(repositoryRoot,'harness','package-lock.json'),
    lockfile('release-builder-harness-fixture','1.0.0')
  );
  await fsp.writeFile(path.join(repositoryRoot,'public','index.html'),'<h1>committed release</h1>\n');
  await fsp.writeFile(path.join(repositoryRoot,'server.mjs'),'export const ready=true;\n');
  await git(repositoryRoot,['add','.']);
  await git(repositoryRoot,['commit','-qm','release builder fixture']);
  const candidateCommit=await git(repositoryRoot,['rev-parse','HEAD']);
  const npmExecutable=(await execFileAsync('/usr/bin/which',['npm'],{
    encoding:'utf8',
    env:process.env
  })).stdout.trim();
  return{root,repositoryRoot,releasesRoot,candidateCommit,npmExecutable};
}

function buildOptions(value){
  return{
    repositoryRoot:value.repositoryRoot,
    candidateCommit:value.candidateCommit,
    releasesRoot:value.releasesRoot,
    builtAt:BUILT_AT,
    nodeExecutable:process.execPath,
    npmExecutable:value.npmExecutable,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    platform:process.platform,
    arch:process.arch
  };
}

test('release builder runs dual cold installs and gates before immutable releaseId promotion',async t=>{
  const value=await fixture(t);
  await fsp.writeFile(path.join(value.repositoryRoot,'public','index.html'),'<h1>dirty checkout</h1>\n');
  await fsp.writeFile(path.join(value.repositoryRoot,'public','preview.html'),'<h1>untracked</h1>\n');

  const result=await buildReleaseArtifact(buildOptions(value));
  assert.equal(result.artifactPath,path.join(await fsp.realpath(value.releasesRoot),result.releaseId));
  assert.equal(result.releaseId,result.releaseIdentity.releaseId);
  assert.match(result.releaseId,/^release-v1-[a-f0-9]{64}$/);
  assert.equal(await fsp.readFile(path.join(result.artifactPath,'app','public','index.html'),'utf8'),'<h1>committed release</h1>\n');
  await assert.rejects(
    fsp.access(path.join(result.artifactPath,'app','public','preview.html')),
    error=>error.code==='ENOENT'
  );

  const metadataRoot=path.join(result.artifactPath,'metadata');
  assert.deepEqual((await fsp.readdir(metadataRoot)).sort(),[
    'release-contract.json',
    'release-identity.json',
    'runtime-manifest.json',
    'source-manifest.json',
    'static-manifest.json',
    'toolchain-manifest.json'
  ]);
  const releaseIdentity=validateReleaseIdentity(JSON.parse(
    await fsp.readFile(path.join(metadataRoot,'release-identity.json'),'utf8')
  ));
  const runtimeManifest=validateRuntimeManifest(JSON.parse(
    await fsp.readFile(path.join(metadataRoot,'runtime-manifest.json'),'utf8')
  ));
  const toolchainManifest=validateToolchainManifest(JSON.parse(
    await fsp.readFile(path.join(metadataRoot,'toolchain-manifest.json'),'utf8')
  ));
  assert.deepEqual(releaseIdentity,result.releaseIdentity);
  assert.equal(runtimeManifest.candidateCommit,value.candidateCommit);
  assert.deepEqual(toolchainManifest.commands.map(command=>command.id),[
    'root-install','harness-install','root-tests','full-verify'
  ]);
  assert.deepEqual(
    (await fsp.readdir(value.releasesRoot)).filter(name=>name.startsWith('.release-build-')),
    []
  );
});

test('release builder command failure leaves no formal or hidden release and permits retry',async t=>{
  const value=await fixture(t);
  let failed=false;
  await assert.rejects(
    buildReleaseArtifact(buildOptions(value),{
      runBuildCommand:async command=>{
        if(command.id==='harness-install'){
          failed=true;
          throw Object.assign(new Error('injected disk full'),{code:'ENOSPC'});
        }
      }
    }),
    error=>error.code==='RELEASE_BUILD_COMMAND_FAILED'&&
      error.stage==='build'&&error.causeCode==='ENOSPC'
  );
  assert.equal(failed,true);
  assert.deepEqual(await fsp.readdir(value.releasesRoot),[]);

  const retried=await buildReleaseArtifact(buildOptions(value),{
    runBuildCommand:async()=>{}
  });
  assert.equal(retried.artifactPath,path.join(await fsp.realpath(value.releasesRoot),retried.releaseId));
});

test('release builder rejects source mutation performed by a successful build command',async t=>{
  const value=await fixture(t);
  await assert.rejects(
    buildReleaseArtifact(buildOptions(value),{
      runBuildCommand:async command=>{
        if(command.id==='root-tests'){
          await fsp.writeFile(path.join(command.appRoot,'public','index.html'),'<h1>mutated by tests</h1>\n');
        }
      }
    }),
    error=>error.code==='RELEASE_SOURCE_POST_BUILD_MISMATCH'&&error.stage==='verify'
  );
  assert.deepEqual(await fsp.readdir(value.releasesRoot),[]);
});

test('release builder recovers a complete intermediate after final promotion failure without rerunning commands',async t=>{
  const value=await fixture(t);
  let promotionInjected=false;
  await assert.rejects(
    buildReleaseArtifact(buildOptions(value),{
      runBuildCommand:async()=>{},
      promoteFinal:async()=>{
        promotionInjected=true;
        throw Object.assign(new Error('injected promotion I/O failure'),{code:'EIO'});
      }
    }),
    error=>error.code==='RELEASE_FINAL_PROMOTION_FAILED'&&
      error.stage==='promote'&&error.causeCode==='EIO'
  );
  assert.equal(promotionInjected,true);
  const leftovers=(await fsp.readdir(value.releasesRoot))
    .filter(name=>name.startsWith('.release-build-'));
  assert.equal(leftovers.length,1);

  let commandsRerun=false;
  const recovered=await buildReleaseArtifact(buildOptions(value),{
    runBuildCommand:async()=>{commandsRerun=true;}
  });
  assert.equal(commandsRerun,false);
  assert.equal(recovered.reused,false);
  assert.equal(recovered.artifactPath,path.join(await fsp.realpath(value.releasesRoot),recovered.releaseId));
  assert.deepEqual(
    (await fsp.readdir(value.releasesRoot)).filter(name=>name.startsWith('.release-build-')),
    []
  );
});

test('release build CLI returns a path-free structured release summary',async t=>{
  const value=await fixture(t);
  const result=await execFileAsync(process.execPath,[
    path.join(PROJECT_ROOT,'scripts','release-build.mjs'),
    '--repository-root',value.repositoryRoot,
    '--candidate-commit',value.candidateCommit,
    '--releases-root',value.releasesRoot,
    '--built-at',BUILT_AT
  ],{
    cwd:PROJECT_ROOT,
    encoding:'utf8',
    env:{...process.env,LC_ALL:'C'}
  });
  const summary=JSON.parse(result.stdout);
  assert.deepEqual(summary,{
    ok:true,
    releaseId:summary.releaseId,
    candidateCommit:value.candidateCommit,
    productVersion:'3.0.0',
    sourceFileCount:7,
    runtimeEntryCount:summary.runtimeEntryCount,
    staticAssetCount:1,
    reused:false
  });
  assert.match(summary.releaseId,/^release-v1-[a-f0-9]{64}$/);
  assert.equal(Number.isSafeInteger(summary.runtimeEntryCount),true);
  assert.equal(result.stdout.includes(value.root),false);
  assert.equal(result.stdout.includes(value.repositoryRoot),false);
  assert.equal(result.stdout.includes(value.releasesRoot),false);
});
