import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_TREE_ALGORITHM='sha256-canonical-runtime-tree-v1';

const COMMIT_RE=/^[a-f0-9]{40}$/;
const SHA256_RE=/^sha256:[a-f0-9]{64}$/;
const TOKEN_RE=/^[a-z0-9][a-z0-9_-]{0,31}$/;
const MANIFEST_KEYS=['arch','candidateCommit','platform','runtimeTree','schemaVersion'];
const TREE_KEYS=['algorithm','entries','entryCount','fileCount','manifestSha256','totalBytes'];
const DIRECTORY_KEYS=['path','type'];
const FILE_KEYS=['bytes','executable','path','sha256','type'];
const SYMLINK_KEYS=['path','target','type'];

function fail(message='Runtime manifest is invalid.',code='RUNTIME_MANIFEST_INVALID'){
  throw Object.assign(new Error(message),{code});
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

function safePath(value){
  if(typeof value!=='string'||!value||value.includes('\0')||value.includes('\\')||
    path.posix.isAbsolute(value)||/^[A-Za-z]:\//.test(value)||value.normalize('NFC')!==value){
    fail();
  }
  const segments=value.split('/');
  if(segments.some(segment=>!segment||segment==='.'||segment==='..')||path.posix.normalize(value)!==value){
    fail();
  }
  return value;
}

function safeSymlinkTarget(value,code='RUNTIME_MANIFEST_INVALID'){
  if(typeof value!=='string'||!value||value.includes('\0')||value.includes('\\')||
    path.posix.isAbsolute(value)||/^[A-Za-z]:\//.test(value)||value.normalize('NFC')!==value||
    path.posix.normalize(value)!==value||value==='.')fail('Runtime symlink is invalid.',code);
  return value;
}

function normalizeEntries(entries){
  if(!Array.isArray(entries))fail();
  const normalized=[];
  const seen=new Set();
  for(const entry of entries){
    if(!plainObject(entry))fail();
    const type=entry.type;
    if(type==='directory')exactDataObject(entry,DIRECTORY_KEYS);
    else if(type==='file')exactDataObject(entry,FILE_KEYS);
    else if(type==='symlink')exactDataObject(entry,SYMLINK_KEYS);
    else fail();
    const entryPath=safePath(entry.path);
    const portable=entryPath.toLowerCase();
    if(seen.has(portable))fail();
    seen.add(portable);
    if(type==='directory'){
      normalized.push(Object.freeze({path:entryPath,type}));
      continue;
    }
    if(type==='symlink'){
      normalized.push(Object.freeze({path:entryPath,type,target:safeSymlinkTarget(entry.target)}));
      continue;
    }
    if(!Number.isSafeInteger(entry.bytes)||entry.bytes<0||
      typeof entry.sha256!=='string'||!SHA256_RE.test(entry.sha256)||
      typeof entry.executable!=='boolean')fail();
    normalized.push(Object.freeze({
      path:entryPath,
      type,
      bytes:entry.bytes,
      sha256:entry.sha256,
      executable:entry.executable
    }));
  }
  normalized.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  return normalized;
}

function computeTreeHash(entries){
  const hash=crypto.createHash('sha256');
  hash.update(`${RUNTIME_TREE_ALGORITHM}\n`,'utf8');
  for(const entry of entries){
    const record=entry.type==='directory'
      ?[entry.path,entry.type]
      :entry.type==='symlink'
        ?[entry.path,entry.type,entry.target]
        :[entry.path,entry.type,entry.bytes,entry.sha256,entry.executable];
    hash.update(JSON.stringify(record),'utf8');
    hash.update('\n','utf8');
  }
  return`sha256:${hash.digest('hex')}`;
}

function freezeManifest({candidateCommit,platform,arch,entries}){
  const fileEntries=entries.filter(entry=>entry.type==='file');
  const totalBytes=fileEntries.reduce((total,entry)=>total+entry.bytes,0);
  if(!Number.isSafeInteger(totalBytes))fail();
  return Object.freeze({
    schemaVersion:1,
    candidateCommit,
    platform,
    arch,
    runtimeTree:Object.freeze({
      algorithm:RUNTIME_TREE_ALGORITHM,
      manifestSha256:computeTreeHash(entries),
      entryCount:entries.length,
      fileCount:fileEntries.length,
      totalBytes,
      entries:Object.freeze(entries)
    })
  });
}

export function validateRuntimeManifest(value){
  exactDataObject(value,MANIFEST_KEYS);
  if(value.schemaVersion!==1||typeof value.candidateCommit!=='string'||
    !COMMIT_RE.test(value.candidateCommit)||typeof value.platform!=='string'||
    !TOKEN_RE.test(value.platform)||typeof value.arch!=='string'||!TOKEN_RE.test(value.arch))fail();
  exactDataObject(value.runtimeTree,TREE_KEYS);
  if(value.runtimeTree.algorithm!==RUNTIME_TREE_ALGORITHM||
    typeof value.runtimeTree.manifestSha256!=='string'||
    !SHA256_RE.test(value.runtimeTree.manifestSha256))fail();
  const entries=normalizeEntries(value.runtimeTree.entries);
  const fileEntries=entries.filter(entry=>entry.type==='file');
  const totalBytes=fileEntries.reduce((total,entry)=>total+entry.bytes,0);
  if(!Number.isSafeInteger(value.runtimeTree.entryCount)||
    value.runtimeTree.entryCount!==entries.length||
    !Number.isSafeInteger(value.runtimeTree.fileCount)||
    value.runtimeTree.fileCount!==fileEntries.length||
    !Number.isSafeInteger(value.runtimeTree.totalBytes)||
    value.runtimeTree.totalBytes!==totalBytes||
    value.runtimeTree.manifestSha256!==computeTreeHash(entries)||
    entries.some((entry,index)=>entry.path!==value.runtimeTree.entries[index]?.path))fail();
  return freezeManifest({
    candidateCommit:value.candidateCommit,
    platform:value.platform,
    arch:value.arch,
    entries
  });
}

function within(root,target){
  const relative=path.relative(root,target);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}

function sameSnapshot(left,right){
  return left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&
    left.nlink===right.nlink&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&
    left.ctimeNs===right.ctimeNs;
}

async function readRuntimeFile(target,entryPath,initial){
  if(initial.nlink!==1n)fail('Runtime hardlinks are forbidden.','RUNTIME_HARDLINK_FORBIDDEN');
  if(Number(initial.mode&0o7000n)!==0)fail('Runtime special permission bits are forbidden.','RUNTIME_MODE_FORBIDDEN');
  if(typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0){
    fail('Safe runtime file reads are unavailable.','RUNTIME_SAFE_OPEN_UNAVAILABLE');
  }
  let handle;
  try{handle=await fsp.open(target,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{
    fail('Runtime file could not be read safely.','RUNTIME_FILE_READ_FAILED');
  }
  try{
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||!sameSnapshot(initial,opened)){
      fail('Runtime tree changed while it was read.','RUNTIME_TREE_CHANGED');
    }
    const buffer=await handle.readFile();
    const after=await handle.stat({bigint:true});
    const pathAfter=await fsp.lstat(target,{bigint:true});
    if(!sameSnapshot(opened,after)||pathAfter.isSymbolicLink()||!pathAfter.isFile()||
      !sameSnapshot(after,pathAfter))fail('Runtime tree changed while it was read.','RUNTIME_TREE_CHANGED');
    return Object.freeze({
      path:entryPath,
      type:'file',
      bytes:buffer.byteLength,
      sha256:`sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`,
      executable:Number(after.mode&0o111n)!==0
    });
  }finally{
    try{await handle.close();}catch{}
  }
}

async function enumerateRuntime(root){
  let rootStat;
  try{rootStat=await fsp.lstat(root,{bigint:true});}catch{
    fail('Runtime root is unavailable.','RUNTIME_ROOT_INVALID');
  }
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory()){
    fail('Runtime root must be a real directory.','RUNTIME_ROOT_INVALID');
  }
  const physicalRoot=await fsp.realpath(root);
  const entries=[];

  async function walk(directory,segments){
    const before=await fsp.lstat(directory,{bigint:true});
    if(before.isSymbolicLink()||!before.isDirectory())fail('Runtime directory is invalid.','RUNTIME_TREE_CHANGED');
    const children=await fsp.readdir(directory,{withFileTypes:true});
    children.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
    for(const child of children){
      const next=[...segments,child.name];
      const entryPath=safePath(next.join('/'));
      const target=path.join(directory,child.name);
      const stat=await fsp.lstat(target,{bigint:true});
      if(stat.isDirectory()){
        entries.push(Object.freeze({path:entryPath,type:'directory'}));
        await walk(target,next);
        continue;
      }
      if(stat.isSymbolicLink()){
        const linkTarget=safeSymlinkTarget(await fsp.readlink(target),'RUNTIME_SYMLINK_FORBIDDEN');
        const lexicalTarget=path.resolve(path.dirname(target),...linkTarget.split('/'));
        let physicalTarget;
        try{physicalTarget=await fsp.realpath(target);}catch{
          fail('Runtime symlink target is unavailable.','RUNTIME_SYMLINK_FORBIDDEN');
        }
        let targetStat;
        try{targetStat=await fsp.lstat(physicalTarget,{bigint:true});}catch{
          fail('Runtime symlink target is unavailable.','RUNTIME_SYMLINK_FORBIDDEN');
        }
        if(!within(root,lexicalTarget)||!within(physicalRoot,physicalTarget)||!targetStat.isFile()){
          fail('Runtime symlink escapes the app root.','RUNTIME_SYMLINK_FORBIDDEN');
        }
        entries.push(Object.freeze({path:entryPath,type:'symlink',target:linkTarget}));
        continue;
      }
      if(!stat.isFile())fail('Runtime tree contains an unsupported entry.','RUNTIME_ENTRY_FORBIDDEN');
      entries.push(await readRuntimeFile(target,entryPath,stat));
    }
    const after=await fsp.lstat(directory,{bigint:true});
    if(after.isSymbolicLink()||!after.isDirectory()||before.dev!==after.dev||before.ino!==after.ino){
      fail('Runtime tree changed while it was read.','RUNTIME_TREE_CHANGED');
    }
  }

  await walk(root,[]);
  return normalizeEntries(entries);
}

export async function createRuntimeManifest(appRoot,{candidateCommit,platform,arch}={}){
  if(typeof appRoot!=='string'||!appRoot.trim())fail('Runtime root is invalid.','RUNTIME_ROOT_INVALID');
  if(typeof candidateCommit!=='string'||!COMMIT_RE.test(candidateCommit)||
    typeof platform!=='string'||!TOKEN_RE.test(platform)||typeof arch!=='string'||!TOKEN_RE.test(arch))fail();
  return freezeManifest({
    candidateCommit,
    platform,
    arch,
    entries:await enumerateRuntime(path.resolve(appRoot))
  });
}

export async function verifyRuntimeManifest(appRoot,manifest){
  const expected=validateRuntimeManifest(manifest);
  const actual=await createRuntimeManifest(appRoot,{
    candidateCommit:expected.candidateCommit,
    platform:expected.platform,
    arch:expected.arch
  });
  if(JSON.stringify(actual)!==JSON.stringify(expected)){
    fail('Runtime tree does not match its manifest.','RUNTIME_MANIFEST_MISMATCH');
  }
  return expected;
}

async function syncRuntimeFile(target){
  let handle;
  try{handle=await fsp.open(target,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{
    fail('Runtime file could not be synchronized.','RUNTIME_SYNC_FAILED');
  }
  try{await handle.sync();}catch{
    fail('Runtime file could not be synchronized.','RUNTIME_SYNC_FAILED');
  }finally{
    try{await handle.close();}catch{}
  }
}

async function syncRuntimeDirectory(target){
  if(typeof fsConstants.O_DIRECTORY!=='number'||fsConstants.O_DIRECTORY===0){
    fail('Runtime directory synchronization is unavailable.','RUNTIME_SYNC_FAILED');
  }
  let handle;
  try{
    handle=await fsp.open(target,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);
  }catch{
    fail('Runtime directory could not be synchronized.','RUNTIME_SYNC_FAILED');
  }
  try{await handle.sync();}catch{
    fail('Runtime directory could not be synchronized.','RUNTIME_SYNC_FAILED');
  }finally{
    try{await handle.close();}catch{}
  }
}

export async function synchronizeRuntimeManifest(appRoot,manifest,dependencies={}){
  const expected=await verifyRuntimeManifest(appRoot,manifest);
  const syncFile=dependencies.syncFile||syncRuntimeFile;
  const syncDirectory=dependencies.syncDirectory||syncRuntimeDirectory;
  if(typeof syncFile!=='function'||typeof syncDirectory!=='function'){
    fail('Runtime synchronization dependency is invalid.','RUNTIME_SYNC_DEPENDENCY_INVALID');
  }
  const root=path.resolve(appRoot);
  try{
    for(const entry of expected.runtimeTree.entries){
      if(entry.type==='file')await syncFile(path.join(root,...entry.path.split('/')));
    }
    const directories=expected.runtimeTree.entries
      .filter(entry=>entry.type==='directory')
      .sort((left,right)=>{
        const depth=right.path.split('/').length-left.path.split('/').length;
        if(depth!==0)return depth;
        return left.path<right.path?-1:left.path>right.path?1:0;
      });
    for(const entry of directories)await syncDirectory(path.join(root,...entry.path.split('/')));
    await syncDirectory(root);
  }catch(error){
    if(error?.code?.startsWith?.('RUNTIME_'))throw error;
    fail('Runtime tree could not be synchronized.','RUNTIME_SYNC_FAILED');
  }
  await verifyRuntimeManifest(root,expected);
  return expected;
}
