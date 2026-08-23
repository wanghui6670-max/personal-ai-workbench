import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RUNTIME_TREE_ALGORITHM,
  createRuntimeManifest,
  validateRuntimeManifest,
  verifyRuntimeManifest
} from '../src/runtime-manifest.mjs';

const CANDIDATE='0123456789abcdef0123456789abcdef01234567';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-runtime-manifest-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app');
  await fsp.mkdir(path.join(appRoot,'node_modules','.bin'),{recursive:true});
  await fsp.mkdir(path.join(appRoot,'empty'));
  await fsp.writeFile(path.join(appRoot,'index.mjs'),'export default 1;\n',{mode:0o644});
  await fsp.writeFile(path.join(appRoot,'node_modules','runner.mjs'),'#!/usr/bin/env node\n',{mode:0o755});
  await fsp.symlink('../runner.mjs',path.join(appRoot,'node_modules','.bin','runner'));
  return{root,appRoot};
}

test('runtime manifest canonically covers files, executable state, directories, and internal symlinks',async t=>{
  const {root,appRoot}=await fixture(t);
  const manifest=await createRuntimeManifest(appRoot,{
    candidateCommit:CANDIDATE,
    platform:'darwin',
    arch:'arm64'
  });
  assert.equal(manifest.schemaVersion,1);
  assert.equal(manifest.candidateCommit,CANDIDATE);
  assert.equal(manifest.platform,'darwin');
  assert.equal(manifest.arch,'arm64');
  assert.equal(manifest.runtimeTree.algorithm,RUNTIME_TREE_ALGORITHM);
  assert.match(manifest.runtimeTree.manifestSha256,/^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(manifest.runtimeTree.entries.map(entry=>entry.path),[
    'empty',
    'index.mjs',
    'node_modules',
    'node_modules/.bin',
    'node_modules/.bin/runner',
    'node_modules/runner.mjs'
  ]);
  assert.deepEqual(
    manifest.runtimeTree.entries.find(entry=>entry.path==='empty'),
    {path:'empty',type:'directory'}
  );
  assert.deepEqual(
    manifest.runtimeTree.entries.find(entry=>entry.path==='index.mjs'),
    {
      path:'index.mjs',
      type:'file',
      bytes:18,
      sha256:'sha256:96909e1dce85ca534fd8881f6c8369a8a87e06df5a4bf81ef44a72db195b0704',
      executable:false
    }
  );
  assert.equal(
    manifest.runtimeTree.entries.find(entry=>entry.path==='node_modules/runner.mjs').executable,
    true
  );
  assert.deepEqual(
    manifest.runtimeTree.entries.find(entry=>entry.path==='node_modules/.bin/runner'),
    {path:'node_modules/.bin/runner',type:'symlink',target:'../runner.mjs'}
  );
  assert.equal(manifest.runtimeTree.entryCount,6);
  assert.equal(manifest.runtimeTree.fileCount,2);
  assert.equal(manifest.runtimeTree.totalBytes,38);
  assert.equal(JSON.stringify(manifest).includes(root),false);
  assert.doesNotMatch(JSON.stringify(manifest),/mtime|ctime|permission|absolute/i);
  assert.deepEqual(validateRuntimeManifest(structuredClone(manifest)),manifest);
  assert.deepEqual(await verifyRuntimeManifest(appRoot,structuredClone(manifest)),manifest);
  assert.equal(Object.isFrozen(manifest),true);
  assert.equal(Object.isFrozen(manifest.runtimeTree.entries),true);
});

test('runtime verification rejects changed, extra, and hard-linked files',async t=>{
  const {root,appRoot}=await fixture(t);
  const manifest=await createRuntimeManifest(appRoot,{
    candidateCommit:CANDIDATE,
    platform:'darwin',
    arch:'arm64'
  });

  await fsp.writeFile(path.join(appRoot,'index.mjs'),'export default 2;\n');
  await assert.rejects(verifyRuntimeManifest(appRoot,manifest),error=>error.code==='RUNTIME_MANIFEST_MISMATCH');
  await fsp.writeFile(path.join(appRoot,'index.mjs'),'export default 1;\n');

  await fsp.writeFile(path.join(appRoot,'extra.txt'),'extra\n');
  await assert.rejects(verifyRuntimeManifest(appRoot,manifest),error=>error.code==='RUNTIME_MANIFEST_MISMATCH');
  await fsp.unlink(path.join(appRoot,'extra.txt'));

  const outside=path.join(root,'outside-hardlink');
  await fsp.writeFile(outside,'export default 1;\n');
  await fsp.unlink(path.join(appRoot,'index.mjs'));
  await fsp.link(outside,path.join(appRoot,'index.mjs'));
  await assert.rejects(createRuntimeManifest(appRoot,{
    candidateCommit:CANDIDATE,
    platform:'darwin',
    arch:'arm64'
  }),error=>error.code==='RUNTIME_HARDLINK_FORBIDDEN');
});

test('runtime manifest rejects symlinks that escape the app root',async t=>{
  const {root,appRoot}=await fixture(t);
  const outside=path.join(root,'outside.txt');
  await fsp.writeFile(outside,'outside\n');
  await fsp.symlink(outside,path.join(appRoot,'node_modules','.bin','outside'));

  await assert.rejects(createRuntimeManifest(appRoot,{
    candidateCommit:CANDIDATE,
    platform:'darwin',
    arch:'arm64'
  }),error=>error.code==='RUNTIME_SYMLINK_FORBIDDEN');
});

test('runtime manifest validation rejects tampering and unsupported fields',async t=>{
  const {appRoot}=await fixture(t);
  const manifest=await createRuntimeManifest(appRoot,{
    candidateCommit:CANDIDATE,
    platform:'darwin',
    arch:'arm64'
  });
  const wrongDigest=structuredClone(manifest);
  wrongDigest.runtimeTree.manifestSha256=`sha256:${'0'.repeat(64)}`;
  assert.throws(()=>validateRuntimeManifest(wrongDigest),error=>error.code==='RUNTIME_MANIFEST_INVALID');

  const extra=structuredClone(manifest);
  extra.appRoot='/private/runtime';
  assert.throws(()=>validateRuntimeManifest(extra),error=>error.code==='RUNTIME_MANIFEST_INVALID');

  const invalidEntry=structuredClone(manifest);
  invalidEntry.runtimeTree.entries[0].mode=0o755;
  assert.throws(()=>validateRuntimeManifest(invalidEntry),error=>error.code==='RUNTIME_MANIFEST_INVALID');
});
