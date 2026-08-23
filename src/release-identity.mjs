import crypto from 'node:crypto';

export const RELEASE_ID_ALGORITHM='sha256-release-identity-v1';

const COMMIT_RE=/^[a-f0-9]{40}$/;
const SHA256_RE=/^sha256:[a-f0-9]{64}$/;
const RELEASE_ID_RE=/^release-v1-[a-f0-9]{64}$/;
const EXACT_VERSION_RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER_RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const BUILT_AT_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const INPUT_KEYS=[
  'builtAt',
  'candidateCommit',
  'manifests',
  'nodeVersion',
  'npmVersion',
  'productVersion'
];
const IDENTITY_KEYS=[
  'builtAt',
  'candidateCommit',
  'manifests',
  'nodeVersion',
  'npmVersion',
  'productVersion',
  'releaseId',
  'schemaVersion'
];
const MANIFEST_KEYS=['contract','runtime','source','static','toolchain'];

function fail(){
  throw Object.assign(new Error('Release identity is invalid.'),{
    code:'RELEASE_IDENTITY_INVALID'
  });
}

function plainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function exactDataObject(value,keys){
  if(!plainObject(value))fail();
  const ownKeys=Reflect.ownKeys(value);
  if(ownKeys.some(key=>typeof key!=='string'))fail();
  const actual=[...ownKeys].sort();
  const expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index]))fail();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(expected.some(key=>!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key],'value')))fail();
}

function canonicalBuiltAt(value){
  if(typeof value!=='string'||!BUILT_AT_RE.test(value))fail();
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime()))fail();
  const canonical=parsed.toISOString();
  if(value!==canonical&&!(canonical.endsWith('.000Z')&&value===canonical.replace('.000Z','Z')))fail();
  return value;
}

function normalizeInput(value,{identity=false}={}){
  exactDataObject(value,identity?IDENTITY_KEYS:INPUT_KEYS);
  if(identity&&value.schemaVersion!==1)fail();
  if(typeof value.productVersion!=='string'||!SEMVER_RE.test(value.productVersion))fail();
  if(typeof value.candidateCommit!=='string'||!COMMIT_RE.test(value.candidateCommit))fail();
  const builtAt=canonicalBuiltAt(value.builtAt);
  if(typeof value.nodeVersion!=='string'||!EXACT_VERSION_RE.test(value.nodeVersion))fail();
  if(typeof value.npmVersion!=='string'||!EXACT_VERSION_RE.test(value.npmVersion))fail();
  exactDataObject(value.manifests,MANIFEST_KEYS);
  const manifests={};
  for(const key of MANIFEST_KEYS){
    if(typeof value.manifests[key]!=='string'||!SHA256_RE.test(value.manifests[key]))fail();
    manifests[key]=value.manifests[key];
  }
  return{
    productVersion:value.productVersion,
    candidateCommit:value.candidateCommit,
    builtAt,
    nodeVersion:value.nodeVersion,
    npmVersion:value.npmVersion,
    manifests:Object.freeze(manifests)
  };
}

function computeReleaseId(value){
  const hash=crypto.createHash('sha256');
  hash.update(`${RELEASE_ID_ALGORITHM}\n`,'utf8');
  hash.update(JSON.stringify([
    value.productVersion,
    value.candidateCommit,
    value.builtAt,
    value.nodeVersion,
    value.npmVersion,
    value.manifests.source,
    value.manifests.contract,
    value.manifests.static,
    value.manifests.runtime,
    value.manifests.toolchain
  ]),'utf8');
  hash.update('\n','utf8');
  return`release-v1-${hash.digest('hex')}`;
}

function freezeIdentity(value){
  return Object.freeze({
    schemaVersion:1,
    releaseId:computeReleaseId(value),
    productVersion:value.productVersion,
    candidateCommit:value.candidateCommit,
    builtAt:value.builtAt,
    nodeVersion:value.nodeVersion,
    npmVersion:value.npmVersion,
    manifests:value.manifests
  });
}

export function createReleaseIdentity(value){
  return freezeIdentity(normalizeInput(value));
}

export function validateReleaseIdentity(value){
  const normalized=normalizeInput(value,{identity:true});
  if(typeof value.releaseId!=='string'||!RELEASE_ID_RE.test(value.releaseId))fail();
  const identity=freezeIdentity(normalized);
  if(identity.releaseId!==value.releaseId)fail();
  return identity;
}
