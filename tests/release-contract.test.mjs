import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createReleaseContract,
  readReleaseRequirements,
  validateReleaseContract
} from '../src/release-contract.mjs';

const CANDIDATE='0123456789abcdef0123456789abcdef01234567';
const PROJECT_ROOT=fileURLToPath(new URL('..',import.meta.url));

function sha256(value){
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function fixture(t,{
  productVersion='3.0.0',
  nodeVersion='24.19.0',
  npmVersion='11.17.0',
  rootLock='{"name":"root","lockfileVersion":3}\n',
  harnessLock='{"name":"harness","lockfileVersion":3}\n'
}={}){
  const projectRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-release-contract-'));
  t.after(()=>fsp.rm(projectRoot,{recursive:true,force:true}));
  await fsp.mkdir(path.join(projectRoot,'harness'),{recursive:true});
  await fsp.writeFile(path.join(projectRoot,'.node-version'),`${nodeVersion}\n`);
  await fsp.writeFile(path.join(projectRoot,'package.json'),JSON.stringify({
    name:'fixture',
    version:productVersion,
    packageManager:`npm@${npmVersion}`
  }));
  await fsp.writeFile(path.join(projectRoot,'package-lock.json'),rootLock);
  await fsp.writeFile(path.join(projectRoot,'harness','package-lock.json'),harnessLock);
  return{projectRoot,rootLock,harnessLock};
}

async function create(projectRoot,overrides={}){
  return createReleaseContract({
    projectRoot,
    candidateCommit:CANDIDATE,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    ...overrides
  });
}

test('release requirements derive exact Node, npm, and product versions only from authoritative metadata',async t=>{
  const {projectRoot}=await fixture(t);
  const requirements=await readReleaseRequirements(projectRoot);
  assert.deepEqual(requirements,{
    productVersion:'3.0.0',
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });
  assert.equal(Object.isFrozen(requirements),true);

  await fsp.writeFile(path.join(projectRoot,'.node-version'),'v24.19.0\n');
  await assert.rejects(readReleaseRequirements(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_NODE_REQUIREMENT_INVALID');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  await fsp.writeFile(path.join(projectRoot,'.node-version'),'24.19.0\n');
  await fsp.writeFile(path.join(projectRoot,'package.json'),JSON.stringify({
    name:'fixture',version:'v3.0.0',packageManager:'npm@11.17.0'
  }));
  await assert.rejects(readReleaseRequirements(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_PRODUCT_VERSION_INVALID');
    return true;
  });

  await fsp.writeFile(path.join(projectRoot,'package.json'),JSON.stringify({
    name:'fixture',version:'3.0.0',packageManager:'npm@^11.17.0'
  }));
  await assert.rejects(readReleaseRequirements(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_NPM_REQUIREMENT_INVALID');
    return true;
  });
});

test('release requirements are metadata-derived rather than hard-coded to the current R1 versions',async t=>{
  const {projectRoot}=await fixture(t,{
    productVersion:'7.8.9-rc.1',
    nodeVersion:'25.1.2',
    npmVersion:'10.9.9'
  });
  assert.deepEqual(await readReleaseRequirements(projectRoot),{
    productVersion:'7.8.9-rc.1',
    nodeVersion:'25.1.2',
    npmVersion:'10.9.9'
  });
  const contract=await create(projectRoot,{
    nodeVersion:'25.1.2',
    npmVersion:'10.9.9'
  });
  assert.equal(contract.nodeVersion,'25.1.2');
  assert.equal(contract.npmVersion,'10.9.9');
});

test('real repository metadata must exactly match the Node and npm selected by PATH',async()=>{
  const actualNpm=execFileSync('npm',['--version'],{
    encoding:'utf8',
    env:process.env
  }).trim();
  const requirements=await readReleaseRequirements(PROJECT_ROOT);
  assert.equal(requirements.nodeVersion,process.versions.node);
  assert.equal(requirements.npmVersion,actualNpm);
  const contract=await createReleaseContract({
    projectRoot:PROJECT_ROOT,
    candidateCommit:CANDIDATE,
    nodeVersion:process.versions.node,
    npmVersion:actualNpm
  });
  assert.equal(contract.nodeVersion,'24.19.0');
  assert.equal(contract.npmVersion,'11.17.0');
});

test('release contract accepts only the exact authoritative runtime toolchain',async t=>{
  const {projectRoot}=await fixture(t);
  assert.equal((await create(projectRoot)).nodeVersion,'24.19.0');

  await assert.rejects(create(projectRoot,{nodeVersion:'26.7.0'}),error=>{
    assert.equal(error.code,'RELEASE_NODE_VERSION_MISMATCH');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });
  await assert.rejects(create(projectRoot,{npmVersion:'11.19.0'}),error=>{
    assert.equal(error.code,'RELEASE_NPM_VERSION_MISMATCH');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });
});

test('release contract rejects every candidate commit that is not a complete lowercase SHA',async t=>{
  const {projectRoot}=await fixture(t);
  for(const candidateCommit of [
    CANDIDATE.slice(0,-1),
    `${CANDIDATE}0`,
    CANDIDATE.toUpperCase(),
    `g${CANDIDATE.slice(1)}`,
    `sha:${CANDIDATE}`,
    '',
    null
  ]){
    await assert.rejects(create(projectRoot,{candidateCommit}),error=>{
      assert.equal(error.code,'RELEASE_CANDIDATE_INVALID');
      assert.equal(error.message.includes(projectRoot),false);
      return true;
    });
  }
});

test('release contract is deterministic, deeply immutable, and contains only portable release evidence',async t=>{
  const {projectRoot,rootLock,harnessLock}=await fixture(t);
  const first=await create(projectRoot);
  const second=await create(projectRoot);
  assert.deepEqual(first,{
    schemaVersion:1,
    productVersion:'3.0.0',
    candidateCommit:CANDIDATE,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    rootLockSha256:sha256(rootLock),
    harnessLockSha256:sha256(harnessLock)
  });
  assert.deepEqual(second,first);
  assert.equal(Object.isFrozen(first),true);
  const serialized=JSON.stringify(first);
  assert.equal(serialized.includes(projectRoot),false);
  assert.doesNotMatch(serialized,/projectRoot|mtime|mode|permission|env|secret/i);
  assert.deepEqual(Object.keys(first),[
    'schemaVersion',
    'productVersion',
    'candidateCommit',
    'nodeVersion',
    'npmVersion',
    'rootLockSha256',
    'harnessLockSha256'
  ]);
});

test('contract validation fails closed on extra fields and recomputes both lock digests',async t=>{
  const {projectRoot}=await fixture(t);
  const contract=await create(projectRoot);
  const validated=await validateReleaseContract(contract,{
    projectRoot,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  });
  assert.deepEqual(validated,contract);
  assert.equal(Object.isFrozen(validated),true);

  await assert.rejects(validateReleaseContract({...contract,projectRoot}, {
    projectRoot,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  }),error=>{
    assert.equal(error.code,'RELEASE_CONTRACT_INVALID');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  const hiddenExtra={...contract};
  Object.defineProperty(hiddenExtra,'hidden',{value:'unsupported',enumerable:false});
  await assert.rejects(validateReleaseContract(hiddenExtra,{
    projectRoot,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  }),error=>error.code==='RELEASE_CONTRACT_INVALID');

  const symbolExtra={...contract,[Symbol('unsupported')]:'value'};
  await assert.rejects(validateReleaseContract(symbolExtra,{
    projectRoot,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  }),error=>error.code==='RELEASE_CONTRACT_INVALID');

  const accessor={...contract};
  Object.defineProperty(accessor,'npmVersion',{enumerable:true,get:()=>contract.npmVersion});
  await assert.rejects(validateReleaseContract(accessor,{
    projectRoot,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  }),error=>error.code==='RELEASE_CONTRACT_INVALID');

  await fsp.writeFile(path.join(projectRoot,'package-lock.json'),'tampered root lock\n');
  await assert.rejects(validateReleaseContract(contract,{
    projectRoot,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  }),error=>{
    assert.equal(error.code,'RELEASE_ROOT_LOCK_MISMATCH');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  const fresh=await create(projectRoot);
  await fsp.writeFile(path.join(projectRoot,'harness','package-lock.json'),'tampered harness lock\n');
  await assert.rejects(validateReleaseContract(fresh,{
    projectRoot,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0'
  }),error=>{
    assert.equal(error.code,'RELEASE_HARNESS_LOCK_MISMATCH');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });
});

test('lock evidence rejects missing files, directories, and symlinks without leaking the project root',async t=>{
  const {projectRoot}=await fixture(t);
  const rootLock=path.join(projectRoot,'package-lock.json');
  await fsp.unlink(rootLock);
  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_ROOT_LOCK_MISSING');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  await fsp.mkdir(rootLock);
  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_ROOT_LOCK_NOT_REGULAR');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  await fsp.rmdir(rootLock);
  const target=path.join(projectRoot,'root-lock-target.json');
  await fsp.writeFile(target,'target\n');
  await fsp.symlink(target,rootLock);
  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_ROOT_LOCK_SYMLINK');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  await fsp.unlink(rootLock);
  await fsp.writeFile(rootLock,'root restored\n');
  const harnessLock=path.join(projectRoot,'harness','package-lock.json');
  await fsp.unlink(harnessLock);
  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_HARNESS_LOCK_MISSING');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  await fsp.mkdir(harnessLock);
  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_HARNESS_LOCK_NOT_REGULAR');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  await fsp.rmdir(harnessLock);
  await fsp.symlink(target,harnessLock);
  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_HARNESS_LOCK_SYMLINK');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });
});

test('release snapshot rejects a symlink project root and symlink Harness directory',async t=>{
  const {projectRoot}=await fixture(t);
  const linkedRoot=`${projectRoot}-linked`;
  await fsp.symlink(projectRoot,linkedRoot);
  t.after(()=>fsp.rm(linkedRoot,{force:true}));
  await assert.rejects(create(linkedRoot),error=>{
    assert.equal(error.code,'RELEASE_PROJECT_ROOT_SYMLINK');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });

  const harness=path.join(projectRoot,'harness');
  const harnessTarget=path.join(projectRoot,'harness-target');
  await fsp.rename(harness,harnessTarget);
  await fsp.symlink(harnessTarget,harness);
  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_HARNESS_DIRECTORY_SYMLINK');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });
});

test('release snapshot rejects a cross-file mutation between its initial read and unified recheck',async t=>{
  const {projectRoot}=await fixture(t);
  const originalOpen=fsp.open.bind(fsp);
  let openCount=0;
  t.mock.method(fsp,'open',async(...args)=>{
    openCount+=1;
    if(openCount===5){
      fs.writeFileSync(path.join(projectRoot,'package-lock.json'),'changed between passes\n');
    }
    return originalOpen(...args);
  });

  await assert.rejects(create(projectRoot),error=>{
    assert.equal(error.code,'RELEASE_SNAPSHOT_CHANGED');
    assert.equal(error.message.includes(projectRoot),false);
    return true;
  });
  assert.ok(openCount>=5);
});
