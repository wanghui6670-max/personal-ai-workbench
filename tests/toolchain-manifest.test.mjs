import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TOOLCHAIN_MANIFEST_ALGORITHM,
  createToolchainManifest,
  validateToolchainManifest,
  verifyToolchainManifest
} from '../src/toolchain-manifest.mjs';

const COMMANDS=[
  {id:'root-install',argv:['npm','ci','--ignore-scripts','--no-audit','--no-fund'],status:'passed'},
  {id:'harness-install',argv:['npm','ci','--prefix','harness','--ignore-scripts','--no-audit','--no-fund'],status:'passed'},
  {id:'root-tests',argv:['npm','test'],status:'passed'},
  {id:'full-verify',argv:['npm','run','verify'],status:'passed'}
];

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-toolchain-manifest-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const nodeExecutable=path.join(root,'node-real');
  const npmReal=path.join(root,'npm-cli.js');
  const npmExecutable=path.join(root,'npm');
  await fsp.writeFile(nodeExecutable,'node-binary\n',{mode:0o755});
  await fsp.writeFile(npmReal,'npm-cli\n',{mode:0o755});
  await fsp.symlink(npmReal,npmExecutable);
  return{root,nodeExecutable,npmExecutable,npmReal};
}

test('toolchain manifest binds exact executable bytes, versions, platform, and passed command contract',async t=>{
  const {root,nodeExecutable,npmExecutable}=await fixture(t);
  const manifest=await createToolchainManifest({
    nodeExecutable,
    npmExecutable,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    platform:'darwin',
    arch:'arm64',
    commands:COMMANDS
  });
  assert.deepEqual(manifest,{
    schemaVersion:1,
    algorithm:TOOLCHAIN_MANIFEST_ALGORITHM,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    platform:'darwin',
    arch:'arm64',
    executables:{
      node:{
        bytes:12,
        sha256:'sha256:6c8bd861dba24475269605b10aa36ae7ba674d769acd1ed7464c8e93345ee10d'
      },
      npm:{
        bytes:8,
        sha256:'sha256:a2e6d32e896e1b209498b0095a53243110acaacb369b47cf23d5d8271e181fc9'
      }
    },
    commands:COMMANDS,
    manifestSha256:manifest.manifestSha256
  });
  assert.match(manifest.manifestSha256,/^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(manifest).includes(root),false);
  assert.doesNotMatch(JSON.stringify(manifest),/duration|mtime|environment|executablePath/i);
  assert.deepEqual(validateToolchainManifest(structuredClone(manifest)),manifest);
  assert.deepEqual(await verifyToolchainManifest({
    nodeExecutable,
    npmExecutable,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    platform:'darwin',
    arch:'arm64'
  },structuredClone(manifest)),manifest);
  assert.equal(Object.isFrozen(manifest),true);
  assert.equal(Object.isFrozen(manifest.commands),true);
});

test('toolchain verification rejects executable or runtime identity drift',async t=>{
  const {nodeExecutable,npmExecutable,npmReal}=await fixture(t);
  const manifest=await createToolchainManifest({
    nodeExecutable,
    npmExecutable,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    platform:'darwin',
    arch:'arm64',
    commands:COMMANDS
  });
  await fsp.writeFile(npmReal,'npm-cli changed\n');
  await assert.rejects(verifyToolchainManifest({
    nodeExecutable,
    npmExecutable,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    platform:'darwin',
    arch:'arm64'
  },manifest),error=>error.code==='TOOLCHAIN_MANIFEST_MISMATCH');

  await assert.rejects(verifyToolchainManifest({
    nodeExecutable,
    npmExecutable,
    nodeVersion:'24.19.1',
    npmVersion:'11.17.0',
    platform:'darwin',
    arch:'arm64'
  },manifest),error=>error.code==='TOOLCHAIN_MANIFEST_MISMATCH');
});

test('toolchain manifest rejects failed, duplicate, unsafe, and tampered command records',async t=>{
  const {nodeExecutable,npmExecutable}=await fixture(t);
  const base={
    nodeExecutable,
    npmExecutable,
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    platform:'darwin',
    arch:'arm64'
  };
  for(const commands of [
    [{id:'root-install',argv:['npm','ci'],status:'failed'}],
    [COMMANDS[0],COMMANDS[0]],
    [{id:'unsafe',argv:['node','/private/script.mjs'],status:'passed'}],
    [{id:'unsafe',argv:['node','ok\0bad'],status:'passed'}]
  ])await assert.rejects(createToolchainManifest({...base,commands}),error=>error.code==='TOOLCHAIN_MANIFEST_INVALID');

  const manifest=await createToolchainManifest({...base,commands:COMMANDS});
  const extra=structuredClone(manifest);
  extra.nodePath='/private/node';
  assert.throws(()=>validateToolchainManifest(extra),error=>error.code==='TOOLCHAIN_MANIFEST_INVALID');

  const tampered=structuredClone(manifest);
  tampered.executables.node.sha256=`sha256:${'0'.repeat(64)}`;
  assert.throws(()=>validateToolchainManifest(tampered),error=>error.code==='TOOLCHAIN_MANIFEST_INVALID');
});
