import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import fsp from 'node:fs/promises';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  materializeReleaseSource,
  prepareReleaseSourceArtifact
} from '../src/release-preparation.mjs';

const execFileAsync=promisify(execFile);
const BUILT_AT='2026-08-20T08:00:00.000Z';
const PROJECT_ROOT=fileURLToPath(new URL('..',import.meta.url));

async function git(root,args){
  const result=await execFileAsync('git',args,{
    cwd:root,
    encoding:'utf8',
    env:{...process.env,LC_ALL:'C'}
  });
  return result.stdout.trim();
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-release-preparation-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const repositoryRoot=path.join(root,'repository');
  const destinationRoot=path.join(root,'prepared-release');
  await fsp.mkdir(repositoryRoot);
  await git(repositoryRoot,['init','-q']);
  await git(repositoryRoot,['config','user.name','Release Fixture']);
  await git(repositoryRoot,['config','user.email','release-fixture@example.invalid']);
  await fsp.mkdir(path.join(repositoryRoot,'public'),{recursive:true});
  await fsp.mkdir(path.join(repositoryRoot,'harness'),{recursive:true});
  await fsp.writeFile(path.join(repositoryRoot,'.node-version'),'24.19.0\n');
  await fsp.writeFile(path.join(repositoryRoot,'package.json'),JSON.stringify({
    name:'release-fixture',
    version:'3.0.0',
    packageManager:'npm@11.17.0'
  },null,2)+'\n');
  await fsp.writeFile(path.join(repositoryRoot,'package-lock.json'),'committed-root-lock\n');
  await fsp.writeFile(path.join(repositoryRoot,'harness','package-lock.json'),'committed-harness-lock\n');
  await fsp.writeFile(path.join(repositoryRoot,'public','index.html'),'<h1>committed</h1>\n');
  await fsp.writeFile(path.join(repositoryRoot,'run.command'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await git(repositoryRoot,['add','.']);
  await git(repositoryRoot,['commit','-qm','release fixture']);
  const candidateCommit=await git(repositoryRoot,['rev-parse','HEAD']);
  return{root,repositoryRoot,destinationRoot,candidateCommit};
}

function sha256(value){
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function syncDirectoryForTest(directory,{mode=null}={}){
  const handle=await fsp.open(directory,'r');
  try{
    if(mode!==null)await handle.chmod(mode);
    await handle.sync();
  }finally{
    await handle.close();
  }
}

function synchronizedDirectoryLabel(directory){
  const segments=directory.split(path.sep);
  const appIndex=segments.lastIndexOf('app');
  if(appIndex>=0)return segments.slice(appIndex).join('/');
  if(path.basename(directory)==='metadata')return'metadata';
  if(path.basename(directory).startsWith('.prepared-release.staging-'))return'staging';
  return'parent';
}

async function waitForOutput(stream,needle,timeoutMs=5000){
  let output='';
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{
      cleanup();
      reject(new Error(`Timed out waiting for child output: ${needle}`));
    },timeoutMs);
    const onData=chunk=>{
      output+=chunk.toString('utf8');
      if(output.includes(needle)){
        cleanup();
        resolve(output);
      }
    };
    const onEnd=()=>{
      cleanup();
      reject(new Error(`Child exited before output: ${needle}`));
    };
    function cleanup(){
      clearTimeout(timeout);
      stream.off('data',onData);
      stream.off('end',onEnd);
    }
    stream.on('data',onData);
    stream.on('end',onEnd);
  });
}

test('prepared source artifact is bound to the fixed commit rather than the dirty checkout',async t=>{
  const {repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  await fsp.writeFile(path.join(repositoryRoot,'.node-version'),'26.7.0\n');
  await fsp.writeFile(path.join(repositoryRoot,'package.json'),JSON.stringify({
    name:'dirty-fixture',
    version:'9.9.9',
    packageManager:'npm@11.19.0'
  })+'\n');
  await fsp.writeFile(path.join(repositoryRoot,'package-lock.json'),'dirty-root-lock\n');
  await fsp.writeFile(path.join(repositoryRoot,'public','index.html'),'<h1>dirty</h1>\n');
  await fsp.writeFile(path.join(repositoryRoot,'public','preview.html'),'<h1>untracked</h1>\n');

  const result=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });

  assert.equal(result.artifactPath,destinationRoot);
  assert.equal(await fsp.readFile(path.join(destinationRoot,'app','public','index.html'),'utf8'),'<h1>committed</h1>\n');
  await assert.rejects(fsp.access(path.join(destinationRoot,'app','public','preview.html')),error=>error.code==='ENOENT');
  assert.equal(result.sourceManifest.candidateCommit,candidateCommit);
  assert.equal(result.releaseContract.candidateCommit,candidateCommit);
  assert.equal(result.releaseContract.productVersion,'3.0.0');
  assert.equal(result.releaseContract.nodeVersion,'24.19.0');
  assert.equal(result.releaseContract.npmVersion,'11.17.0');
  assert.equal(result.releaseContract.rootLockSha256,sha256('committed-root-lock\n'));
  assert.equal(result.staticManifest.commit,candidateCommit);
  assert.equal(result.staticManifest.productVersion,'3.0.0');
  assert.equal(result.staticManifest.builtAt,BUILT_AT);
  assert.deepEqual(result.staticManifest.staticAssets.assets.map(asset=>asset.path),['index.html']);
  assert.equal((await fsp.stat(path.join(destinationRoot,'app','run.command'))).mode&0o111,0o111);

  for(const [name,value] of [
    ['source-manifest.json',result.sourceManifest],
    ['release-contract.json',result.releaseContract],
    ['static-manifest.json',result.staticManifest]
  ]){
    const serialized=await fsp.readFile(path.join(destinationRoot,'metadata',name),'utf8');
    assert.deepEqual(JSON.parse(serialized),value);
    assert.equal(serialized.endsWith('\n'),true);
    assert.equal(serialized.includes(repositoryRoot),false);
    assert.equal(serialized.includes(destinationRoot),false);
  }
});

test('materialized source tampering blocks promotion and removes the private staging directory',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      materializeSource:async options=>{
        await materializeReleaseSource(options);
        const {appRoot}=options;
        await fsp.writeFile(path.join(appRoot,'public','index.html'),'<h1>tampered</h1>\n');
      }
    }),
    error=>error.code==='RELEASE_SOURCE_MATERIALIZATION_MISMATCH'
  );

  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
  const leftovers=(await fsp.readdir(root)).filter(name=>name.startsWith('.prepared-release.'));
  assert.deepEqual(leftovers,[]);
});

test('release preparation CLI emits a structured summary without absolute paths',async t=>{
  const {repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  const result=await execFileAsync(process.execPath,[
    path.join(PROJECT_ROOT,'scripts','release-prepare.mjs'),
    '--repository-root',repositoryRoot,
    '--candidate-commit',candidateCommit,
    '--destination-root',destinationRoot,
    '--built-at',BUILT_AT
  ],{
    cwd:PROJECT_ROOT,
    encoding:'utf8',
    env:{...process.env,LC_ALL:'C'}
  });
  const summary=JSON.parse(result.stdout);
  assert.deepEqual(summary,{
    ok:true,
    candidateCommit,
    productVersion:'3.0.0',
    sourceFileCount:6,
    staticAssetCount:1,
    sourceManifestSha256:summary.sourceManifestSha256,
    staticManifestSha256:summary.staticManifestSha256
  });
  assert.match(summary.sourceManifestSha256,/^sha256:[a-f0-9]{64}$/);
  assert.match(summary.staticManifestSha256,/^sha256:[a-f0-9]{64}$/);
  assert.equal(result.stdout.includes(repositoryRoot),false);
  assert.equal(result.stdout.includes(destinationRoot),false);
});

test('prepared source verification accepts globally sorted nested paths',async t=>{
  const {repositoryRoot,destinationRoot}=await fixture(t);
  await fsp.mkdir(path.join(repositoryRoot,'alpha'));
  await fsp.writeFile(path.join(repositoryRoot,'alpha.txt'),'sibling\n');
  await fsp.writeFile(path.join(repositoryRoot,'alpha','child.txt'),'child\n');
  await git(repositoryRoot,['add','alpha.txt','alpha/child.txt']);
  await git(repositoryRoot,['commit','-qm','add nested ordering fixture']);
  const candidateCommit=await git(repositoryRoot,['rev-parse','HEAD']);

  const result=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });

  assert.equal(await fsp.readFile(path.join(result.artifactPath,'app','alpha.txt'),'utf8'),'sibling\n');
  assert.equal(await fsp.readFile(path.join(result.artifactPath,'app','alpha','child.txt'),'utf8'),'child\n');
});

test('prepared source rejects hardlinks before chmod or promotion',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  const outside=path.join(root,'outside-hardlink');
  await fsp.writeFile(outside,'<h1>committed</h1>\n',{mode:0o600});

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      materializeSource:async options=>{
        await materializeReleaseSource(options);
        const target=path.join(options.appRoot,'public','index.html');
        await fsp.unlink(target);
        await fsp.link(outside,target);
      }
    }),
    error=>error.code==='RELEASE_SOURCE_LINK_COUNT'
  );

  assert.equal((await fsp.stat(outside)).mode&0o7777,0o600);
  assert.equal(await fsp.readFile(outside,'utf8'),'<h1>committed</h1>\n');
  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
});

test('destination ancestor symlinks cannot place a prepared artifact inside the repository',async t=>{
  const {root,repositoryRoot,candidateCommit}=await fixture(t);
  const physicalParent=path.join(repositoryRoot,'untracked-output','nested');
  const linkedParent=path.join(root,'linked-output');
  await fsp.mkdir(physicalParent,{recursive:true});
  await fsp.symlink(path.join(repositoryRoot,'untracked-output'),linkedParent);
  const destinationRoot=path.join(linkedParent,'nested','prepared-release');

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    }),
    error=>error.code==='RELEASE_OUTPUT_INSIDE_REPOSITORY'
  );
  await assert.rejects(
    fsp.access(path.join(physicalParent,'prepared-release')),
    error=>error.code==='ENOENT'
  );
});

test('prepared source omits the tracked empty data layout marker',async t=>{
  const {repositoryRoot,destinationRoot}=await fixture(t);
  await fsp.mkdir(path.join(repositoryRoot,'data'));
  await fsp.writeFile(path.join(repositoryRoot,'data','.gitkeep'),'');
  await git(repositoryRoot,['add','data/.gitkeep']);
  await git(repositoryRoot,['commit','-qm','add empty data layout marker']);
  const candidateCommit=await git(repositoryRoot,['rev-parse','HEAD']);

  const result=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });

  assert.equal(result.sourceManifest.sourceTree.files.some(file=>file.path.startsWith('data/')),false);
  await assert.rejects(fsp.access(path.join(result.artifactPath,'app','data')),error=>error.code==='ENOENT');
});

test('prepared source rejects an extra empty directory injected during materialization',async t=>{
  const {repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      materializeSource:async options=>{
        await materializeReleaseSource(options);
        await fsp.mkdir(path.join(options.appRoot,'untracked-empty-directory'));
      }
    }),
    error=>error.code==='RELEASE_TRACKED_DIRECTORIES_MISMATCH'
  );
  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
});

test('prepared source rejects a destination ancestor swap and cleans the physical staging area',async t=>{
  const {root,repositoryRoot,candidateCommit}=await fixture(t);
  const safeOutputRoot=path.join(root,'safe-output');
  const repositoryOutputRoot=path.join(repositoryRoot,'untracked-output');
  const linkedOutputRoot=path.join(root,'linked-output');
  await fsp.mkdir(path.join(safeOutputRoot,'nested'),{recursive:true});
  await fsp.mkdir(path.join(repositoryOutputRoot,'nested'),{recursive:true});
  await fsp.symlink(safeOutputRoot,linkedOutputRoot);
  const destinationRoot=path.join(linkedOutputRoot,'nested','prepared-release');
  let physicalStaging=null;

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      materializeSource:async options=>{
        await materializeReleaseSource(options);
        physicalStaging=await fsp.realpath(path.dirname(options.appRoot));
        await fsp.unlink(linkedOutputRoot);
        await fsp.symlink(repositoryOutputRoot,linkedOutputRoot);
      }
    }),
    error=>error.code==='RELEASE_OUTPUT_PARENT_CHANGED'
  );

  assert.ok(physicalStaging);
  await assert.rejects(fsp.access(physicalStaging),error=>error.code==='ENOENT');
  await assert.rejects(
    fsp.access(path.join(safeOutputRoot,'nested','prepared-release')),
    error=>error.code==='ENOENT'
  );
  await assert.rejects(
    fsp.access(path.join(repositoryOutputRoot,'nested','prepared-release')),
    error=>error.code==='ENOENT'
  );
  assert.deepEqual(
    (await fsp.readdir(path.join(safeOutputRoot,'nested')))
      .filter(name=>name.startsWith('.prepared-release.')),
    []
  );
  assert.deepEqual(
    (await fsp.readdir(path.join(repositoryOutputRoot,'nested')))
      .filter(name=>name.startsWith('.prepared-release.')),
    []
  );
});

test('prepared source rejects a file swapped to a symlink during verification without chmodding the target',async t=>{
  const {root,repositoryRoot,destinationRoot}=await fixture(t);
  const targetBytes='stable target bytes\n';
  await fsp.writeFile(path.join(repositoryRoot,'000-target.txt'),targetBytes);
  await git(repositoryRoot,['add','.']);
  await git(repositoryRoot,['commit','-qm','add verification race fixture']);
  const candidateCommit=await git(repositoryRoot,['rev-parse','HEAD']);
  const externalFile=path.join(root,'external-target.txt');
  await fsp.writeFile(externalFile,targetBytes,{mode:0o600});

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      afterSourceInventory:async ({appRoot})=>{
        const target=path.join(appRoot,'000-target.txt');
        await fsp.unlink(target);
        await fsp.symlink(externalFile,target);
      }
    }),
    error=>error.code==='RELEASE_SOURCE_CHANGED_DURING_VERIFY'
  );

  assert.equal((await fsp.stat(externalFile)).mode&0o777,0o600);
  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
});

test('prepared source synchronizes every app directory from leaves to root before promotion',async t=>{
  const {repositoryRoot,destinationRoot}=await fixture(t);
  const nested=path.join(repositoryRoot,'public','assets','icons');
  await fsp.mkdir(nested,{recursive:true});
  await fsp.writeFile(path.join(nested,'mark.svg'),'<svg/>\n');
  await git(repositoryRoot,['add','.']);
  await git(repositoryRoot,['commit','-qm','add nested release asset']);
  const candidateCommit=await git(repositoryRoot,['rev-parse','HEAD']);
  const synchronized=[];

  await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  },{
    syncDirectory:async (directory,options)=>{
      synchronized.push(synchronizedDirectoryLabel(directory));
      await syncDirectoryForTest(directory,options);
    }
  });

  const appDirectories=synchronized.filter(label=>label==='app'||label.startsWith('app/'));
  assert.deepEqual(appDirectories,[
    'app/public/assets/icons',
    'app/public/assets',
    'app/harness',
    'app/public',
    'app'
  ]);
  assert.deepEqual(synchronized.slice(-3),['metadata','staging','parent']);
});

test('prepared source directory sync failure prevents promotion, cleans state, and permits retry',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  let injected=false;
  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      syncDirectory:async (directory,options)=>{
        if(synchronizedDirectoryLabel(directory)==='app/public'){
          injected=true;
          throw Object.assign(new Error('injected directory sync failure'),{code:'EIO'});
        }
        await syncDirectoryForTest(directory,options);
      }
    }),
    error=>error.code==='RELEASE_SOURCE_SYNC_FAILED'
  );
  assert.equal(injected,true);
  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
  assert.deepEqual(
    (await fsp.readdir(root)).filter(name=>name.startsWith('.prepared-release.')),
    []
  );

  const retried=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });
  assert.equal(retried.artifactPath,destinationRoot);
});

test('parent sync failure after rename rolls back the promoted directory and permits retry',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  let parentSyncAttempts=0;

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      syncDirectory:async (directory,options)=>{
        if(synchronizedDirectoryLabel(directory)==='parent'&&parentSyncAttempts++===0){
          throw Object.assign(new Error('injected parent sync failure'),{code:'EIO'});
        }
        await syncDirectoryForTest(directory,options);
      }
    }),
    error=>error.code==='RELEASE_PROMOTION_SYNC_FAILED'&&error.stage==='promote'
  );

  assert.equal(parentSyncAttempts,2);
  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
  assert.deepEqual(
    (await fsp.readdir(root)).filter(name=>name.startsWith('.prepared-release.')),
    []
  );

  const retried=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });
  assert.equal(retried.artifactPath,destinationRoot);
});

test('atomic promotion does not replace an empty destination created after the final absence check',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  let competingIdentity=null;

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      beforePromotion:async ({destination})=>{
        await fsp.mkdir(destination);
        const stat=await fsp.lstat(destination,{bigint:true});
        competingIdentity={dev:stat.dev,ino:stat.ino};
      }
    }),
    error=>error.code==='RELEASE_OUTPUT_EXISTS'&&error.stage==='promote'
  );

  assert.ok(competingIdentity);
  const preserved=await fsp.lstat(destinationRoot,{bigint:true});
  assert.equal(preserved.dev,competingIdentity.dev);
  assert.equal(preserved.ino,competingIdentity.ino);
  assert.deepEqual(await fsp.readdir(destinationRoot),[]);
  assert.deepEqual(
    (await fsp.readdir(root)).filter(name=>name.startsWith('.prepared-release.')),
    []
  );

  await fsp.rmdir(destinationRoot);
  const retried=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });
  assert.equal(retried.artifactPath,destinationRoot);
});

test('build lock records process identity and nonce while a concurrent preparation is rejected',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  let releaseMaterialization;
  let markMaterializationReached;
  const materializationReached=new Promise(resolve=>{markMaterializationReached=resolve;});
  const materializationBlocked=new Promise(resolve=>{releaseMaterialization=resolve;});
  const first=prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  },{
    materializeSource:async options=>{
      await materializeReleaseSource(options);
      markMaterializationReached();
      await materializationBlocked;
    }
  });

  await materializationReached;
  const lockPath=path.join(root,'.prepared-release.prepare.lock');
  try{
    const serialized=await fsp.readFile(lockPath,'utf8');
    const record=JSON.parse(serialized);
    assert.deepEqual(Object.keys(record).sort(),[
      'createdAt',
      'nonce',
      'pid',
      'processStartIdentity',
      'schemaVersion',
      'stagingName'
    ]);
    assert.equal(record.schemaVersion,1);
    assert.equal(record.pid,process.pid);
    assert.match(record.processStartIdentity,/\S/);
    assert.match(record.nonce,/^[a-f0-9]{32}$/);
    assert.equal(record.stagingName,`.prepared-release.staging-${record.nonce}`);
    assert.equal((await fsp.stat(lockPath)).mode&0o777,0o600);

    await assert.rejects(
      prepareReleaseSourceArtifact({
        repositoryRoot,
        candidateCommit,
        destinationRoot,
        builtAt:BUILT_AT,
        nodeVersion:'24.19.0',
        npmVersion:'11.17.0'
      }),
      error=>error.code==='RELEASE_BUILD_BUSY'
    );
  }finally{
    releaseMaterialization();
  }
  await first;
  await assert.rejects(fsp.access(lockPath),error=>error.code==='ENOENT');
});

test('stale build lock recovers its bound orphan staging directory',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  const nonce='0123456789abcdef0123456789abcdef';
  const stagingName=`.prepared-release.staging-${nonce}`;
  const lockPath=path.join(root,'.prepared-release.prepare.lock');
  const orphanStaging=path.join(root,stagingName);
  await fsp.mkdir(orphanStaging,{mode:0o700});
  await fsp.writeFile(path.join(orphanStaging,'orphan'),'stale\n');
  await fsp.writeFile(lockPath,`${JSON.stringify({
    schemaVersion:1,
    pid:2147483647,
    processStartIdentity:'stale-process-start',
    nonce,
    createdAt:'2026-08-20T00:00:00.000Z',
    stagingName
  },null,2)}\n`,{mode:0o600});

  const result=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });

  assert.equal(result.artifactPath,destinationRoot);
  await assert.rejects(fsp.access(orphanStaging),error=>error.code==='ENOENT');
  await assert.rejects(fsp.access(lockPath),error=>error.code==='ENOENT');
  assert.deepEqual(
    (await fsp.readdir(root)).filter(name=>name.startsWith('.prepared-release.')),
    []
  );
});

test('staging cleanup failure preserves the primary error and leaves recoverable lock state',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  let cleanupInjected=false;

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      materializeSource:async options=>{
        await materializeReleaseSource(options);
        await fsp.writeFile(path.join(options.appRoot,'public','index.html'),'<h1>tampered</h1>\n');
      },
      removeStaging:async (directory,options)=>{
        if(!cleanupInjected){
          cleanupInjected=true;
          throw Object.assign(new Error('injected cleanup failure'),{code:'EACCES'});
        }
        await fsp.rm(directory,options);
      }
    }),
    error=>error.code==='RELEASE_SOURCE_MATERIALIZATION_MISMATCH'&&
      error.stage==='verify'&&
      Array.isArray(error.cleanupErrors)&&
      error.cleanupErrors.length===1&&
      error.cleanupErrors[0]==='RELEASE_STAGING_CLEANUP_FAILED'
  );

  assert.equal(cleanupInjected,true);
  assert.equal((await fsp.readdir(root)).some(name=>name.endsWith('.prepare.lock')),true);
  assert.equal((await fsp.readdir(root)).some(name=>name.includes('.staging-')),true);

  const retried=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });
  assert.equal(retried.artifactPath,destinationRoot);
  assert.deepEqual(
    (await fsp.readdir(root)).filter(name=>name.startsWith('.prepared-release.')),
    []
  );
});

test('lock lifecycle synchronizes the parent and reports post-commit release-sync failure as a warning',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  const purposes=[];
  const result=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  },{
    syncLockParent:async (directory,options)=>{
      purposes.push(options.purpose);
      if(options.purpose==='release'){
        throw Object.assign(new Error('injected lock release sync failure'),{code:'EIO'});
      }
      await syncDirectoryForTest(directory,options);
    }
  });

  assert.deepEqual(purposes,['acquire','release']);
  assert.deepEqual(result.cleanupWarnings,['RELEASE_BUILD_LOCK_RELEASE_SYNC_FAILED']);
  assert.equal(await fsp.readFile(path.join(destinationRoot,'app','public','index.html'),'utf8'),'<h1>committed</h1>\n');
  await assert.rejects(
    fsp.access(path.join(root,'.prepared-release.prepare.lock')),
    error=>error.code==='ENOENT'
  );
});

test('prepared source rejects a parent directory swapped to a symlink before touching external files',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  const externalPublic=path.join(root,'external-public');
  const externalIndex=path.join(externalPublic,'index.html');
  await fsp.mkdir(externalPublic);
  await fsp.writeFile(externalIndex,'<h1>committed</h1>\n',{mode:0o600});

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      afterSourceInventory:async ({appRoot})=>{
        const publicRoot=path.join(appRoot,'public');
        await fsp.rename(publicRoot,path.join(appRoot,'public-displaced'));
        await fsp.symlink(externalPublic,publicRoot);
      }
    }),
    error=>error.code==='RELEASE_SOURCE_CHANGED_DURING_VERIFY'
  );

  assert.equal((await fsp.stat(externalIndex)).mode&0o777,0o600);
  assert.equal(await fsp.readFile(externalIndex,'utf8'),'<h1>committed</h1>\n');
  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
});

test('prepared source rejects a real directory replacement after final source verification',async t=>{
  const {repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  let replacementIdentity=null;

  await assert.rejects(
    prepareReleaseSourceArtifact({
      repositoryRoot,
      candidateCommit,
      destinationRoot,
      builtAt:BUILT_AT,
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      afterFinalSourceVerify:async ({appRoot})=>{
        const publicRoot=path.join(appRoot,'public');
        await fsp.rename(publicRoot,path.join(appRoot,'public-displaced'));
        await fsp.mkdir(publicRoot);
        await fsp.writeFile(path.join(publicRoot,'index.html'),'<h1>committed</h1>\n',{mode:0o644});
        const stat=await fsp.lstat(publicRoot,{bigint:true});
        replacementIdentity={dev:stat.dev,ino:stat.ino};
      }
    }),
    error=>error.code==='RELEASE_SOURCE_CHANGED_DURING_VERIFY'
  );

  assert.ok(replacementIdentity);
  await assert.rejects(fsp.access(destinationRoot),error=>error.code==='ENOENT');
});

test('a killed preparation releases the kernel lock and its orphan staging is recovered on retry',async t=>{
  const {root,repositoryRoot,destinationRoot,candidateCommit}=await fixture(t);
  const moduleUrl=new URL('../src/release-preparation.mjs',import.meta.url).href;
  const childScript=`
    const {prepareReleaseSourceArtifact,materializeReleaseSource}=await import(process.argv[1]);
    await prepareReleaseSourceArtifact({
      repositoryRoot:process.argv[2],
      candidateCommit:process.argv[3],
      destinationRoot:process.argv[4],
      builtAt:process.argv[5],
      nodeVersion:'24.19.0',
      npmVersion:'11.17.0'
    },{
      materializeSource:async options=>{
        await materializeReleaseSource(options);
        process.stdout.write('MATERIALIZED\\n');
        await new Promise(()=>setInterval(()=>{},1000));
      }
    });
  `;
  const child=spawn(process.execPath,[
    '--input-type=module',
    '-e',childScript,
    moduleUrl,
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    BUILT_AT
  ],{
    cwd:PROJECT_ROOT,
    env:{...process.env,LC_ALL:'C'},
    stdio:['ignore','pipe','pipe']
  });
  t.after(()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  });

  await waitForOutput(child.stdout,'MATERIALIZED');
  assert.equal((await fsp.readdir(root)).some(name=>name.endsWith('.prepare.lock')),true);
  assert.equal((await fsp.readdir(root)).some(name=>name.includes('.staging-')),true);
  child.kill('SIGKILL');
  const [exitCode,signal]=await once(child,'exit');
  assert.equal(exitCode,null);
  assert.equal(signal,'SIGKILL');

  const retried=await prepareReleaseSourceArtifact({
    repositoryRoot,
    candidateCommit,
    destinationRoot,
    builtAt:BUILT_AT,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });
  assert.equal(retried.artifactPath,destinationRoot);
  assert.deepEqual(
    (await fsp.readdir(root)).filter(name=>name.startsWith('.prepared-release.')),
    []
  );
});
