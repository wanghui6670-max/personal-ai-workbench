import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);

export const RELEASE_CANDIDATE_SCHEMA_VERSION=1;
export const SOURCE_TREE_ALGORITHM='sha256-canonical-git-tree-v1';

const COMMIT_RE=/^[a-f0-9]{40}$/;
const SHA256_RE=/^sha256:[a-f0-9]{64}$/;
const SOURCE_KEYS=['algorithm','gitTree','manifestSha256','fileCount','totalBytes','files'];
const RECORD_KEYS=['path','gitMode','bytes','sha256'];
const CANDIDATE_KEYS=['schemaVersion','candidateCommit','sourceTree','trackedPublicPaths'];
const ALLOWED_GIT_MODES=new Set(['100644','100755']);

function fail(message,code,stage='provenance'){
  throw Object.assign(new Error(message),{code,stage,retryable:false});
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function exactDataObject(value,keys,label){
  if(!isPlainObject(value))fail(`${label} must be an object.`,'RELEASE_SOURCE_MANIFEST_INVALID');
  const own=Reflect.ownKeys(value);
  if(own.some(key=>typeof key!=='string'))fail(`${label} contains unsupported fields.`,'RELEASE_SOURCE_MANIFEST_INVALID');
  const actual=[...own].sort();
  const expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index])){
    fail(`${label} contains missing or unsupported fields.`,'RELEASE_SOURCE_MANIFEST_INVALID');
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(expected.some(key=>!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key],'value'))){
    fail(`${label} fields must be enumerable data properties.`,'RELEASE_SOURCE_MANIFEST_INVALID');
  }
}

function freezeCandidate(value){
  for(const file of value.sourceTree.files)Object.freeze(file);
  Object.freeze(value.sourceTree.files);
  Object.freeze(value.sourceTree);
  Object.freeze(value.trackedPublicPaths);
  return Object.freeze(value);
}

function assertCommit(value,code='RELEASE_CANDIDATE_INVALID'){
  if(typeof value!=='string'||!COMMIT_RE.test(value)){
    fail('Release candidate must be a complete lowercase Git SHA.',code);
  }
  return value;
}

function safeRepositoryRoot(repositoryRoot){
  if(typeof repositoryRoot!=='string'||!repositoryRoot.trim()){
    fail('Release repository root is required.','RELEASE_REPOSITORY_ROOT_INVALID');
  }
  return path.resolve(repositoryRoot);
}

async function assertRepositoryRoot(repositoryRoot){
  const root=safeRepositoryRoot(repositoryRoot);
  let stat;
  try{stat=await fsp.lstat(root);}catch{
    fail('Release repository root is unavailable.','RELEASE_REPOSITORY_ROOT_INVALID');
  }
  if(stat.isSymbolicLink())fail('Release repository root must not be a symbolic link.','RELEASE_REPOSITORY_ROOT_SYMLINK');
  if(!stat.isDirectory())fail('Release repository root must be a directory.','RELEASE_REPOSITORY_ROOT_INVALID');
  return root;
}

function safePath(value){
  if(typeof value!=='string'||!value||value.includes('\0')||/[\u0000-\u001f\u007f]/u.test(value)){
    fail('Candidate tree contains an invalid path.','RELEASE_SOURCE_PATH_INVALID');
  }
  if(value.includes('\\')||path.posix.isAbsolute(value)||/^[A-Za-z]:\//.test(value)){
    fail('Candidate tree contains a non-portable path.','RELEASE_SOURCE_PATH_INVALID');
  }
  const segments=value.split('/');
  if(segments.some(segment=>!segment||segment==='.'||segment==='..')||path.posix.normalize(value)!==value){
    fail('Candidate tree contains path traversal.','RELEASE_SOURCE_PATH_INVALID');
  }
  if(value.normalize('NFC')!==value){
    fail('Candidate tree contains a non-canonical Unicode path.','RELEASE_SOURCE_PATH_COLLISION');
  }
  return value;
}

function sensitivePath(sourcePath){
  const segments=sourcePath.toLowerCase().split('/');
  const basename=segments.at(-1);
  if(segments.some(segment=>segment==='.ssh'||segment==='.aws'))return true;
  if(basename==='.env'||(basename.startsWith('.env.')&&basename!=='.env.example'))return true;
  if(['credentials.json','auth.json','cookies.txt','id_rsa','id_ed25519'].includes(basename))return true;
  if(/(?:private[-_.]?key|credential|secret)(?:\.|$)/.test(basename))return true;
  if(/\.(?:pem|p12|pfx)$/i.test(basename))return true;
  return false;
}

function digest(buffer){
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function canonicalSourceHash(files){
  const hash=crypto.createHash('sha256');
  hash.update(`${SOURCE_TREE_ALGORITHM}\n`,'utf8');
  for(const file of files){
    hash.update(JSON.stringify([file.path,file.gitMode,file.bytes,file.sha256]),'utf8');
    hash.update('\n','utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

function parseTreeRecord(record){
  const tab=record.indexOf('\t');
  if(tab<=0)fail('Candidate tree record is malformed.','RELEASE_SOURCE_TREE_INVALID');
  const header=record.slice(0,tab);
  const sourcePath=safePath(record.slice(tab+1));
  const match=/^([0-7]{6}) ([a-z]+) ([a-f0-9]{40}) +([0-9]+|-)$/.exec(header);
  if(!match)fail('Candidate tree record is malformed.','RELEASE_SOURCE_TREE_INVALID');
  const [,gitMode,type,objectId,sizeRaw]=match;
  if(type!=='blob'||!ALLOWED_GIT_MODES.has(gitMode)){
    fail('Candidate tree contains a forbidden Git object mode.','RELEASE_SOURCE_MODE_FORBIDDEN');
  }
  if(sizeRaw==='-')fail('Candidate tree blob size is unavailable.','RELEASE_SOURCE_TREE_INVALID');
  const bytes=Number(sizeRaw);
  if(!Number.isSafeInteger(bytes)||bytes<0)fail('Candidate tree blob size is invalid.','RELEASE_SOURCE_TREE_INVALID');
  if(sensitivePath(sourcePath))fail('Candidate tree contains a forbidden sensitive path.','RELEASE_SOURCE_SENSITIVE_PATH');
  return{path:sourcePath,gitMode,objectId,bytes};
}

function decodeTree(stdout){
  const buffer=Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout??'');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{
    fail('Candidate tree contains a non-UTF-8 path.','RELEASE_SOURCE_PATH_INVALID');
  }
  if(text&&!text.endsWith('\0'))fail('Candidate tree output is truncated.','RELEASE_SOURCE_TREE_INVALID');
  return text?text.slice(0,-1).split('\0').map(parseTreeRecord):[];
}

function normalizeGitFailure(error,code){
  if(error?.code&&String(error.code).startsWith('RELEASE_'))throw error;
  fail('Git candidate evidence could not be read safely.',code);
}

function defaultGitOps(repositoryRoot){
  async function run(args,{binary=false,maxBuffer=64*1024*1024}={}){
    try{
      const result=await execFileAsync('git',args,{
        cwd:repositoryRoot,
        encoding:binary?'buffer':'utf8',
        maxBuffer,
        windowsHide:true,
        env:{
          PATH:process.env.PATH,
          HOME:process.env.HOME,
          LC_ALL:'C',
          GIT_CONFIG_NOSYSTEM:'1',
          GIT_CONFIG_GLOBAL:'/dev/null',
          GIT_NO_REPLACE_OBJECTS:'1',
          GIT_OPTIONAL_LOCKS:'0'
        }
      });
      return result.stdout;
    }catch(error){throw error;}
  }
  return Object.freeze({
    async objectType(commit){return String(await run(['cat-file','-t',commit])).trim();},
    async treeId(commit){return String(await run(['rev-parse','--verify',`${commit}^{tree}`])).trim();},
    async listTree(commit){return run(['ls-tree','-r','-z','--long',commit],{binary:true});},
    async readBlob(objectId){return run(['cat-file','blob',objectId],{binary:true})}
  });
}

async function candidateType(gitOps,candidateCommit){
  try{return await gitOps.objectType(candidateCommit);}
  catch(error){normalizeGitFailure(error,'RELEASE_CANDIDATE_NOT_FOUND');}
}

async function candidateTreeId(gitOps,candidateCommit){
  let tree;
  try{tree=await gitOps.treeId(candidateCommit);}catch(error){normalizeGitFailure(error,'RELEASE_SOURCE_TREE_READ_FAILED');}
  if(typeof tree!=='string'||!COMMIT_RE.test(tree.trim())){
    fail('Candidate commit tree identity is invalid.','RELEASE_SOURCE_TREE_INVALID');
  }
  return tree.trim();
}

async function candidateTreeRecords(gitOps,candidateCommit){
  try{return decodeTree(await gitOps.listTree(candidateCommit));}
  catch(error){normalizeGitFailure(error,'RELEASE_SOURCE_TREE_READ_FAILED');}
}

async function candidateBlob(gitOps,record){
  let buffer;
  try{buffer=await gitOps.readBlob(record.objectId);}catch(error){normalizeGitFailure(error,'RELEASE_SOURCE_BLOB_READ_FAILED');}
  if(!Buffer.isBuffer(buffer))buffer=Buffer.from(buffer??'');
  if(buffer.byteLength!==record.bytes){
    fail('Candidate blob bytes do not match the Git tree.','RELEASE_SOURCE_BLOB_MISMATCH');
  }
  return buffer;
}

function normalizedFiles(files){
  if(!Array.isArray(files))fail('sourceTree.files must be an array.','RELEASE_SOURCE_MANIFEST_INVALID');
  const normalized=[];
  const exactSeen=new Set();
  const portableSeen=new Set();
  for(const value of files){
    exactDataObject(value,RECORD_KEYS,'Source file');
    const sourcePath=safePath(value.path);
    if(sensitivePath(sourcePath))fail('Source manifest contains a forbidden sensitive path.','RELEASE_SOURCE_SENSITIVE_PATH');
    if(!ALLOWED_GIT_MODES.has(value.gitMode))fail('Source manifest contains a forbidden Git mode.','RELEASE_SOURCE_MODE_FORBIDDEN');
    if(!Number.isSafeInteger(value.bytes)||value.bytes<0)fail('Source manifest contains invalid bytes.','RELEASE_SOURCE_MANIFEST_INVALID');
    if(typeof value.sha256!=='string'||!SHA256_RE.test(value.sha256))fail('Source manifest contains an invalid digest.','RELEASE_SOURCE_MANIFEST_INVALID');
    const portable=sourcePath.normalize('NFC').toLowerCase();
    if(exactSeen.has(sourcePath)||portableSeen.has(portable)){
      fail('Candidate tree contains colliding paths.','RELEASE_SOURCE_PATH_COLLISION');
    }
    exactSeen.add(sourcePath);
    portableSeen.add(portable);
    normalized.push({path:sourcePath,gitMode:value.gitMode,bytes:value.bytes,sha256:value.sha256});
  }
  normalized.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  return normalized;
}

function trackedPublicPaths(files){
  return files
    .filter(file=>file.path.startsWith('public/')&&file.path.length>'public/'.length)
    .map(file=>file.path.slice('public/'.length));
}

export function validateReleaseCandidate(value){
  exactDataObject(value,CANDIDATE_KEYS,'Release candidate');
  if(value.schemaVersion!==RELEASE_CANDIDATE_SCHEMA_VERSION)fail('Release candidate schemaVersion is invalid.','RELEASE_SOURCE_MANIFEST_INVALID');
  const candidateCommit=assertCommit(value.candidateCommit,'RELEASE_SOURCE_MANIFEST_INVALID');
  exactDataObject(value.sourceTree,SOURCE_KEYS,'sourceTree');
  if(value.sourceTree.algorithm!==SOURCE_TREE_ALGORITHM)fail('sourceTree algorithm is invalid.','RELEASE_SOURCE_MANIFEST_INVALID');
  const gitTree=assertCommit(value.sourceTree.gitTree,'RELEASE_SOURCE_MANIFEST_INVALID');
  const files=normalizedFiles(value.sourceTree.files);
  const totalBytes=files.reduce((total,file)=>total+file.bytes,0);
  if(!Number.isSafeInteger(totalBytes)||value.sourceTree.totalBytes!==totalBytes||value.sourceTree.fileCount!==files.length){
    fail('sourceTree totals are invalid.','RELEASE_SOURCE_MANIFEST_INVALID');
  }
  const manifestSha256=canonicalSourceHash(files);
  if(value.sourceTree.manifestSha256!==manifestSha256)fail('sourceTree aggregate digest is invalid.','RELEASE_SOURCE_MANIFEST_INVALID');
  if(!Array.isArray(value.trackedPublicPaths)||value.trackedPublicPaths.some(item=>typeof item!=='string')){
    fail('trackedPublicPaths is invalid.','RELEASE_SOURCE_MANIFEST_INVALID');
  }
  const expectedPublic=trackedPublicPaths(files);
  if(value.trackedPublicPaths.length!==expectedPublic.length||value.trackedPublicPaths.some((item,index)=>item!==expectedPublic[index])){
    fail('trackedPublicPaths does not match sourceTree.','RELEASE_SOURCE_MANIFEST_INVALID');
  }
  const frozenFiles=files.map(file=>Object.freeze(file));
  return freezeCandidate({
    schemaVersion:RELEASE_CANDIDATE_SCHEMA_VERSION,
    candidateCommit,
    sourceTree:{
      algorithm:SOURCE_TREE_ALGORITHM,
      gitTree,
      manifestSha256,
      fileCount:frozenFiles.length,
      totalBytes,
      files:frozenFiles
    },
    trackedPublicPaths:[...expectedPublic]
  });
}

export async function inspectReleaseCandidate({repositoryRoot,candidateCommit}={},dependencies={}){
  assertCommit(candidateCommit);
  const root=await assertRepositoryRoot(repositoryRoot);
  const gitOps=dependencies.gitOps||defaultGitOps(root);
  if(!gitOps||['objectType','treeId','listTree','readBlob'].some(method=>typeof gitOps[method]!=='function')){
    fail('Git candidate reader is invalid.','RELEASE_GIT_READER_INVALID');
  }
  const type=await candidateType(gitOps,candidateCommit);
  if(type!=='commit')fail('Release candidate object is not a commit.','RELEASE_CANDIDATE_NOT_COMMIT');
  const gitTree=await candidateTreeId(gitOps,candidateCommit);
  const records=await candidateTreeRecords(gitOps,candidateCommit);
  const exactSeen=new Set();
  const portableSeen=new Set();
  const files=[];
  for(const record of records){
    const portable=record.path.normalize('NFC').toLowerCase();
    if(exactSeen.has(record.path)||portableSeen.has(portable)){
      fail('Candidate tree contains colliding paths.','RELEASE_SOURCE_PATH_COLLISION');
    }
    exactSeen.add(record.path);
    portableSeen.add(portable);
    const buffer=await candidateBlob(gitOps,record);
    files.push({path:record.path,gitMode:record.gitMode,bytes:record.bytes,sha256:digest(buffer)});
  }
  files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  const totalBytes=files.reduce((total,file)=>total+file.bytes,0);
  if(!Number.isSafeInteger(totalBytes))fail('Candidate tree is too large.','RELEASE_SOURCE_TREE_INVALID');
  return validateReleaseCandidate({
    schemaVersion:RELEASE_CANDIDATE_SCHEMA_VERSION,
    candidateCommit,
    sourceTree:{
      algorithm:SOURCE_TREE_ALGORITHM,
      gitTree,
      manifestSha256:canonicalSourceHash(files),
      fileCount:files.length,
      totalBytes,
      files
    },
    trackedPublicPaths:trackedPublicPaths(files)
  });
}
