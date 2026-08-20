import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_CONTRACT_SCHEMA_VERSION=1;

const EXACT_VERSION_RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER_RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CANDIDATE_RE=/^[a-f0-9]{40}$/;
const SHA256_RE=/^sha256:[a-f0-9]{64}$/;
const CONTRACT_KEYS=[
  'schemaVersion',
  'productVersion',
  'candidateCommit',
  'nodeVersion',
  'npmVersion',
  'rootLockSha256',
  'harnessLockSha256'
];
const AUTHORITATIVE_FILES=[
  {
    key:'nodeMetadata',
    segments:['.node-version'],
    label:'.node-version',
    code:'RELEASE_NODE_METADATA'
  },
  {
    key:'packageMetadata',
    segments:['package.json'],
    label:'package.json',
    code:'RELEASE_PACKAGE_METADATA'
  },
  {
    key:'rootLock',
    segments:['package-lock.json'],
    label:'Root package-lock.json',
    code:'RELEASE_ROOT_LOCK'
  },
  {
    key:'harnessLock',
    segments:['harness','package-lock.json'],
    label:'Harness package-lock.json',
    code:'RELEASE_HARNESS_LOCK'
  }
];

function fail(message,code){
  throw Object.assign(new Error(message),{code});
}

function deepFreeze(value){
  if(value===null||typeof value!=='object'||Object.isFrozen(value))return value;
  for(const item of Object.values(value))deepFreeze(item);
  return Object.freeze(value);
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function normalizeProjectRoot(projectRoot){
  if(typeof projectRoot!=='string'||projectRoot.trim()===''){
    fail('Release project root is required.','RELEASE_PROJECT_ROOT_INVALID');
  }
  return path.resolve(projectRoot);
}

function identity(stat){
  return{
    dev:stat.dev,
    ino:stat.ino,
    mode:stat.mode,
    size:stat.size,
    mtimeMs:stat.mtimeMs,
    ctimeMs:stat.ctimeMs
  };
}

function sameIdentity(left,right){
  return left.dev===right.dev&&
    left.ino===right.ino&&
    left.mode===right.mode&&
    left.size===right.size&&
    left.mtimeMs===right.mtimeMs&&
    left.ctimeMs===right.ctimeMs;
}

function ioFailure(label,code,error){
  if(error?.code==='ENOENT')fail(`${label} is missing.`,`${code}_MISSING`);
  if(error?.code==='ELOOP')fail(`${label} must not be a symbolic link.`,`${code}_SYMLINK`);
  fail(`${label} could not be read safely.`,`${code}_READ_FAILED`);
}

async function readDirectoryIdentity(target,{label,code}){
  let stat;
  try{
    stat=await fsp.lstat(target);
  }catch(error){
    ioFailure(label,code,error);
  }
  if(stat.isSymbolicLink())fail(`${label} must not be a symbolic link.`,`${code}_SYMLINK`);
  if(!stat.isDirectory())fail(`${label} must be a directory.`,`${code}_NOT_DIRECTORY`);
  return identity(stat);
}

async function readRegularFile(projectRoot,segments,{label,code}){
  const target=path.join(projectRoot,...segments);
  let initial;
  try{
    initial=await fsp.lstat(target);
  }catch(error){
    ioFailure(label,code,error);
  }
  if(initial.isSymbolicLink())fail(`${label} must not be a symbolic link.`,`${code}_SYMLINK`);
  if(!initial.isFile())fail(`${label} must be a regular file.`,`${code}_NOT_REGULAR`);

  let handle;
  try{
    handle=await fsp.open(target,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));
  }catch(error){
    ioFailure(label,code,error);
  }

  try{
    const before=await handle.stat();
    if(!before.isFile())fail(`${label} must be a regular file.`,`${code}_NOT_REGULAR`);
    const initialIdentity=identity(initial);
    const beforeIdentity=identity(before);
    if(!sameIdentity(initialIdentity,beforeIdentity)){
      fail('Release authority changed while its snapshot was being read.','RELEASE_SNAPSHOT_CHANGED');
    }
    const buffer=await handle.readFile();
    const after=await handle.stat();
    if(!sameIdentity(beforeIdentity,identity(after))){
      fail(`${label} changed while it was being read.`,`${code}_CHANGED_DURING_READ`);
    }
    let pathAfter;
    try{
      pathAfter=await fsp.lstat(target);
    }catch{
      fail('Release authority changed while its snapshot was being read.','RELEASE_SNAPSHOT_CHANGED');
    }
    if(pathAfter.isSymbolicLink()||!pathAfter.isFile()||!sameIdentity(beforeIdentity,identity(pathAfter))){
      fail('Release authority changed while its snapshot was being read.','RELEASE_SNAPSHOT_CHANGED');
    }
    return{buffer,identity:beforeIdentity};
  }catch(error){
    if(typeof error?.code==='string'&&error.code.startsWith('RELEASE_'))throw error;
    ioFailure(label,code,error);
  }finally{
    try{await handle.close();}catch{}
  }
}

async function readSnapshotPass(projectRoot){
  const rootIdentity=await readDirectoryIdentity(projectRoot,{
    label:'Release project root',
    code:'RELEASE_PROJECT_ROOT'
  });
  const harnessPath=path.join(projectRoot,'harness');
  const harnessIdentity=await readDirectoryIdentity(harnessPath,{
    label:'Release Harness directory',
    code:'RELEASE_HARNESS_DIRECTORY'
  });
  const files={};
  for(const descriptor of AUTHORITATIVE_FILES){
    files[descriptor.key]=await readRegularFile(projectRoot,descriptor.segments,descriptor);
  }
  const finalRootIdentity=await readDirectoryIdentity(projectRoot,{
    label:'Release project root',
    code:'RELEASE_PROJECT_ROOT'
  });
  const finalHarnessIdentity=await readDirectoryIdentity(harnessPath,{
    label:'Release Harness directory',
    code:'RELEASE_HARNESS_DIRECTORY'
  });
  if(!sameIdentity(rootIdentity,finalRootIdentity)||!sameIdentity(harnessIdentity,finalHarnessIdentity)){
    fail('Release authority changed while its snapshot was being read.','RELEASE_SNAPSHOT_CHANGED');
  }
  return{rootIdentity,harnessIdentity,files};
}

function assertSameSnapshot(first,second){
  if(
    !sameIdentity(first.rootIdentity,second.rootIdentity)||
    !sameIdentity(first.harnessIdentity,second.harnessIdentity)
  ){
    fail('Release authority changed between snapshot reads.','RELEASE_SNAPSHOT_CHANGED');
  }
  for(const {key} of AUTHORITATIVE_FILES){
    const left=first.files[key];
    const right=second.files[key];
    if(!sameIdentity(left.identity,right.identity)||!left.buffer.equals(right.buffer)){
      fail('Release authority changed between snapshot reads.','RELEASE_SNAPSHOT_CHANGED');
    }
  }
}

async function readAuthoritativeSnapshot(projectRoot){
  const root=normalizeProjectRoot(projectRoot);
  const first=await readSnapshotPass(root);
  const second=await readSnapshotPass(root);
  assertSameSnapshot(first,second);
  return first.files;
}

function parseNodeRequirement(buffer){
  const raw=buffer.toString('utf8');
  const match=/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\r?\n)?$/.exec(raw);
  if(!match)fail('.node-version must contain one exact x.y.z version.','RELEASE_NODE_REQUIREMENT_INVALID');
  return match[1];
}

function parsePackageMetadata(buffer){
  let metadata;
  try{
    metadata=JSON.parse(buffer.toString('utf8'));
  }catch{
    fail('package.json must contain valid JSON.','RELEASE_PACKAGE_METADATA_INVALID');
  }
  if(!isPlainObject(metadata)){
    fail('package.json must contain a JSON object.','RELEASE_PACKAGE_METADATA_INVALID');
  }
  if(typeof metadata.version!=='string'||!SEMVER_RE.test(metadata.version)){
    fail('package.json version must be valid SemVer.','RELEASE_PRODUCT_VERSION_INVALID');
  }
  if(typeof metadata.packageManager!=='string'){
    fail('package.json packageManager must pin npm to one exact version.','RELEASE_NPM_REQUIREMENT_INVALID');
  }
  const match=/^npm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(metadata.packageManager);
  if(!match){
    fail('package.json packageManager must pin npm to one exact version.','RELEASE_NPM_REQUIREMENT_INVALID');
  }
  return{productVersion:metadata.version,npmVersion:match[1]};
}

function assertCandidate(candidateCommit,code='RELEASE_CANDIDATE_INVALID'){
  if(typeof candidateCommit!=='string'||!CANDIDATE_RE.test(candidateCommit)){
    fail('Release candidate must be a complete lowercase Git SHA.',code);
  }
}

function assertRuntime(requirements,{nodeVersion,npmVersion}){
  if(typeof nodeVersion!=='string'||nodeVersion!==requirements.nodeVersion){
    fail('Runtime Node version does not match the release requirement.','RELEASE_NODE_VERSION_MISMATCH');
  }
  if(typeof npmVersion!=='string'||npmVersion!==requirements.npmVersion){
    fail('Runtime npm version does not match the release requirement.','RELEASE_NPM_VERSION_MISMATCH');
  }
}

function digest(buffer){
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function readRequirements(snapshot){
  const nodeVersion=parseNodeRequirement(snapshot.nodeMetadata.buffer);
  const {productVersion,npmVersion}=parsePackageMetadata(snapshot.packageMetadata.buffer);
  return deepFreeze({productVersion,nodeVersion,npmVersion});
}

function readLockDigests(snapshot){
  return{
    rootLockSha256:digest(snapshot.rootLock.buffer),
    harnessLockSha256:digest(snapshot.harnessLock.buffer)
  };
}

function normalizeContract(value){
  if(!isPlainObject(value))fail('Release contract must be an object.','RELEASE_CONTRACT_INVALID');
  const ownKeys=Reflect.ownKeys(value);
  if(ownKeys.some(key=>typeof key!=='string')){
    fail('Release contract contains missing or unsupported fields.','RELEASE_CONTRACT_INVALID');
  }
  const actual=[...ownKeys].sort();
  const expected=[...CONTRACT_KEYS].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index])){
    fail('Release contract contains missing or unsupported fields.','RELEASE_CONTRACT_INVALID');
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(expected.some(key=>!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key],'value'))){
    fail('Release contract fields must be enumerable data properties.','RELEASE_CONTRACT_INVALID');
  }
  if(value.schemaVersion!==RELEASE_CONTRACT_SCHEMA_VERSION){
    fail('Release contract schemaVersion is invalid.','RELEASE_CONTRACT_INVALID');
  }
  if(typeof value.productVersion!=='string'||!SEMVER_RE.test(value.productVersion)){
    fail('Release contract productVersion is invalid.','RELEASE_CONTRACT_INVALID');
  }
  assertCandidate(value.candidateCommit,'RELEASE_CONTRACT_INVALID');
  if(typeof value.nodeVersion!=='string'||!EXACT_VERSION_RE.test(value.nodeVersion)){
    fail('Release contract nodeVersion is invalid.','RELEASE_CONTRACT_INVALID');
  }
  if(typeof value.npmVersion!=='string'||!EXACT_VERSION_RE.test(value.npmVersion)){
    fail('Release contract npmVersion is invalid.','RELEASE_CONTRACT_INVALID');
  }
  if(typeof value.rootLockSha256!=='string'||!SHA256_RE.test(value.rootLockSha256)){
    fail('Release contract rootLockSha256 is invalid.','RELEASE_CONTRACT_INVALID');
  }
  if(typeof value.harnessLockSha256!=='string'||!SHA256_RE.test(value.harnessLockSha256)){
    fail('Release contract harnessLockSha256 is invalid.','RELEASE_CONTRACT_INVALID');
  }
  return{
    schemaVersion:RELEASE_CONTRACT_SCHEMA_VERSION,
    productVersion:value.productVersion,
    candidateCommit:value.candidateCommit,
    nodeVersion:value.nodeVersion,
    npmVersion:value.npmVersion,
    rootLockSha256:value.rootLockSha256,
    harnessLockSha256:value.harnessLockSha256
  };
}

export async function readReleaseRequirements(projectRoot){
  return readRequirements(await readAuthoritativeSnapshot(projectRoot));
}

export async function createReleaseContract({
  projectRoot,
  candidateCommit,
  nodeVersion,
  npmVersion
}={}){
  assertCandidate(candidateCommit);
  const snapshot=await readAuthoritativeSnapshot(projectRoot);
  const requirements=readRequirements(snapshot);
  assertRuntime(requirements,{nodeVersion,npmVersion});
  const locks=readLockDigests(snapshot);
  return deepFreeze({
    schemaVersion:RELEASE_CONTRACT_SCHEMA_VERSION,
    productVersion:requirements.productVersion,
    candidateCommit,
    nodeVersion:requirements.nodeVersion,
    npmVersion:requirements.npmVersion,
    ...locks
  });
}

export async function validateReleaseContract(contract,{
  projectRoot,
  nodeVersion,
  npmVersion
}={}){
  const normalized=normalizeContract(contract);
  const snapshot=await readAuthoritativeSnapshot(projectRoot);
  const requirements=readRequirements(snapshot);
  assertRuntime(requirements,{nodeVersion,npmVersion});
  if(normalized.productVersion!==requirements.productVersion){
    fail('Release contract productVersion does not match package.json.','RELEASE_PRODUCT_VERSION_MISMATCH');
  }
  if(normalized.nodeVersion!==requirements.nodeVersion||normalized.npmVersion!==requirements.npmVersion){
    fail('Release contract toolchain does not match authoritative metadata.','RELEASE_CONTRACT_TOOLCHAIN_MISMATCH');
  }
  const locks=readLockDigests(snapshot);
  if(normalized.rootLockSha256!==locks.rootLockSha256){
    fail('Root package-lock.json does not match the release contract.','RELEASE_ROOT_LOCK_MISMATCH');
  }
  if(normalized.harnessLockSha256!==locks.harnessLockSha256){
    fail('Harness package-lock.json does not match the release contract.','RELEASE_HARNESS_LOCK_MISMATCH');
  }
  return deepFreeze(normalized);
}
