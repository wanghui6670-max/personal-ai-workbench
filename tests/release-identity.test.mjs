import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  RELEASE_ID_ALGORITHM,
  createReleaseIdentity,
  validateReleaseIdentity
} from '../src/release-identity.mjs';

const INPUT={
  productVersion:'3.0.0',
  candidateCommit:'0123456789abcdef0123456789abcdef01234567',
  builtAt:'2026-08-20T08:09:10.123Z',
  nodeVersion:'24.19.0',
  npmVersion:'11.17.0',
  manifests:{
    source:`sha256:${'1'.repeat(64)}`,
    contract:`sha256:${'2'.repeat(64)}`,
    static:`sha256:${'3'.repeat(64)}`,
    runtime:`sha256:${'4'.repeat(64)}`,
    toolchain:`sha256:${'5'.repeat(64)}`
  }
};

function expectedId(input){
  const hash=crypto.createHash('sha256');
  hash.update(`${RELEASE_ID_ALGORITHM}\n`,'utf8');
  hash.update(JSON.stringify([
    input.productVersion,
    input.candidateCommit,
    input.builtAt,
    input.nodeVersion,
    input.npmVersion,
    input.manifests.source,
    input.manifests.contract,
    input.manifests.static,
    input.manifests.runtime,
    input.manifests.toolchain
  ]),'utf8');
  hash.update('\n','utf8');
  return`release-v1-${hash.digest('hex')}`;
}

test('release identity deterministically binds all five manifests and exact build inputs',()=>{
  const identity=createReleaseIdentity(INPUT);
  assert.deepEqual(identity,{
    schemaVersion:1,
    releaseId:expectedId(INPUT),
    productVersion:'3.0.0',
    candidateCommit:'0123456789abcdef0123456789abcdef01234567',
    builtAt:'2026-08-20T08:09:10.123Z',
    nodeVersion:'24.19.0',
    npmVersion:'11.17.0',
    manifests:{...INPUT.manifests}
  });
  assert.equal(Object.isFrozen(identity),true);
  assert.equal(Object.isFrozen(identity.manifests),true);
  assert.deepEqual(createReleaseIdentity(structuredClone(INPUT)),identity);
  assert.deepEqual(validateReleaseIdentity(structuredClone(identity)),identity);
});

test('release identity changes when any manifest or exact build input changes',()=>{
  const base=createReleaseIdentity(INPUT);
  const variants=[
    {...INPUT,productVersion:'3.0.1'},
    {...INPUT,candidateCommit:'1123456789abcdef0123456789abcdef01234567'},
    {...INPUT,builtAt:'2026-08-20T08:09:11.123Z'},
    {...INPUT,nodeVersion:'24.19.1'},
    {...INPUT,npmVersion:'11.17.1'},
    ...Object.keys(INPUT.manifests).map(key=>({
      ...INPUT,
      manifests:{...INPUT.manifests,[key]:`sha256:${'a'.repeat(64)}`}
    }))
  ];
  for(const variant of variants){
    assert.notEqual(createReleaseIdentity(variant).releaseId,base.releaseId);
  }
});

test('release identity validation rejects tampering, extra fields, and non-canonical values',()=>{
  const identity=createReleaseIdentity(INPUT);
  for(const candidate of [
    {...identity,releaseId:`release-v1-${'0'.repeat(64)}`},
    {...identity,candidateCommit:identity.candidateCommit.toUpperCase()},
    {...identity,builtAt:'2026-08-20T16:09:10+08:00'},
    {...identity,nodeVersion:'v24.19.0'},
    {...identity,npmVersion:'11.17'},
    {...identity,manifests:{...identity.manifests,source:'sha256:invalid'}},
    {...identity,unexpected:true},
    {...identity,manifests:{...identity.manifests,unexpected:`sha256:${'f'.repeat(64)}`}}
  ])assert.throws(()=>validateReleaseIdentity(candidate),error=>error.code==='RELEASE_IDENTITY_INVALID');

  const hidden={...identity};
  Object.defineProperty(hidden,'hidden',{value:true,enumerable:false});
  assert.throws(()=>validateReleaseIdentity(hidden),error=>error.code==='RELEASE_IDENTITY_INVALID');

  const symbol={...identity,[Symbol('hidden')]:true};
  assert.throws(()=>validateReleaseIdentity(symbol),error=>error.code==='RELEASE_IDENTITY_INVALID');
});
