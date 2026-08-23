import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {
  createStaticAssetManifest,
  loadVerifiedStaticAssets,
  validateBuildIdentity
} from './build-identity.mjs';
import {inspectReleaseCandidate} from './release-artifact.mjs';
import {createReleaseContract} from './release-contract.mjs';

const execFileAsync=promisify(execFile);
const DARWIN_EXCLUSIVE_RENAME_SCRIPT=[
  'import ctypes, os, sys',
  'try:',
  '    renameatx_np = ctypes.CDLL(None, use_errno=True).renameatx_np',
  'except AttributeError:',
  '    sys.exit(254)',
  'renameatx_np.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
  'renameatx_np.restype = ctypes.c_int',
  'result = renameatx_np(3, os.fsencode(sys.argv[1]), 3, os.fsencode(sys.argv[2]), 0x14)',
  'sys.exit(0 if result == 0 else (ctypes.get_errno() or 255))'
].join('\n');
const LINUX_EXCLUSIVE_RENAME_SCRIPT=[
  'import ctypes, os, sys',
  'try:',
  '    renameat2 = ctypes.CDLL(None, use_errno=True).renameat2',
  'except AttributeError:',
  '    sys.exit(254)',
  'renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
  'renameat2.restype = ctypes.c_int',
  'result = renameat2(3, os.fsencode(sys.argv[1]), 3, os.fsencode(sys.argv[2]), 0x1)',
  'sys.exit(0 if result == 0 else (ctypes.get_errno() or 255))'
].join('\n');
const FILE_LOCK_SCRIPT=[
  'import fcntl, sys',
  'try:',
  '    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  'except OSError as error:',
  '    sys.exit(error.errno or 255)',
  'sys.exit(0)'
].join('\n');
const LOCK_RECORD_KEYS=[
  'createdAt',
  'nonce',
  'pid',
  'processStartIdentity',
  'schemaVersion',
  'stagingName'
];

function fail(message,code,stage='prepare'){
  throw Object.assign(new Error(message),{code,stage,retryable:false});
}

function requiredPath(value,code){
  if(typeof value!=='string'||!value.trim()||value.includes('\0')){
    fail('Release preparation path is invalid.',code);
  }
  return path.resolve(value);
}

function isWithin(parent,target){
  const relative=path.relative(parent,target);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}

async function requireRealDirectory(directory,code){
  let stat;
  try{stat=await fsp.lstat(directory);}catch{
    fail('Release preparation parent is unavailable.',code);
  }
  if(stat.isSymbolicLink()||!stat.isDirectory()){
    fail('Release preparation parent must be a real directory.',code);
  }
}

async function directoryIdentity(directory,code){
  let stat;
  try{stat=await fsp.lstat(directory,{bigint:true});}catch{
    fail('Release preparation parent is unavailable.',code);
  }
  if(stat.isSymbolicLink()||!stat.isDirectory()){
    fail('Release preparation parent must be a real directory.',code);
  }
  return Object.freeze({dev:stat.dev,ino:stat.ino});
}

async function requireStableParent({requestedParent,physicalParent,identity}){
  let resolved;
  let current;
  try{
    resolved=await fsp.realpath(requestedParent);
    current=await fsp.lstat(physicalParent,{bigint:true});
  }catch{
    fail('Release preparation parent changed during preparation.','RELEASE_OUTPUT_PARENT_CHANGED');
  }
  if(resolved!==physicalParent||current.isSymbolicLink()||!current.isDirectory()||
    current.dev!==identity.dev||current.ino!==identity.ino){
    fail('Release preparation parent changed during preparation.','RELEASE_OUTPUT_PARENT_CHANGED');
  }
}

async function requireMissing(target){
  try{
    await fsp.lstat(target);
    fail('Prepared release destination already exists.','RELEASE_OUTPUT_EXISTS');
  }catch(error){
    if(error?.code!=='ENOENT')throw error;
  }
}

function commandEnv(){
  return{
    PATH:process.env.PATH||'/usr/bin:/bin',
    HOME:process.env.HOME||'',
    LC_ALL:'C',
    GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_NO_REPLACE_OBJECTS:'1',
    GIT_OPTIONAL_LOCKS:'0'
  };
}

async function processStartIdentity(pid){
  let stdout;
  try{
    ({stdout}=await execFileAsync('/bin/ps',['-o','lstart=','-p',String(pid)],{
      env:commandEnv(),
      encoding:'utf8',
      maxBuffer:4096,
      windowsHide:true
    }));
  }catch{
    fail('Release preparation process identity is unavailable.','RELEASE_BUILD_LOCK_FAILED','lock');
  }
  const identity=stdout.trim().replace(/\s+/g,' ');
  if(!identity||identity.length>256||/[\u0000-\u001f\u007f]/.test(identity)){
    fail('Release preparation process identity is unavailable.','RELEASE_BUILD_LOCK_FAILED','lock');
  }
  return identity;
}

async function runCommand(file,args,{cwd,code}){
  try{
    await execFileAsync(file,args,{
      cwd,
      env:commandEnv(),
      encoding:'utf8',
      maxBuffer:16*1024*1024,
      windowsHide:true
    });
  }catch{
    fail('Release source could not be materialized safely.',code,'materialize');
  }
}

export async function materializeReleaseSource({repositoryRoot,candidateCommit,archiveFile,appRoot}){
  await runCommand('git',['archive','--format=tar',`--output=${archiveFile}`,candidateCommit],{
    cwd:repositoryRoot,
    code:'RELEASE_ARCHIVE_CREATE_FAILED'
  });
  await runCommand('tar',['-xf',archiveFile,'-C',appRoot],{
    cwd:repositoryRoot,
    code:'RELEASE_ARCHIVE_EXTRACT_FAILED'
  });
  await fsp.rm(path.join(appRoot,'data'),{recursive:true,force:true});
  await fsp.unlink(archiveFile);
}

function digest(buffer){
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

async function actualTree(root,current=root,tree={files:[],directories:[],root:null}){
  let currentBefore;
  try{currentBefore=await fsp.lstat(current,{bigint:true});}catch{sourceChanged();}
  if(currentBefore.isSymbolicLink()||!currentBefore.isDirectory()){
    fail('Prepared source contains an invalid directory.','RELEASE_SOURCE_MODE_FORBIDDEN','verify');
  }
  if(current===root)tree.root={absolute:current,path:'',snapshot:currentBefore};
  const entries=await fsp.readdir(current,{withFileTypes:true});
  entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
  for(const entry of entries){
    const absolute=path.join(current,entry.name);
    const stat=await fsp.lstat(absolute,{bigint:true});
    if(stat.isSymbolicLink())fail('Prepared source contains a symbolic link.','RELEASE_SOURCE_MODE_FORBIDDEN','verify');
    if(stat.isDirectory()){
      tree.directories.push({
        absolute,
        path:path.relative(root,absolute).split(path.sep).join('/'),
        snapshot:stat
      });
      await actualTree(root,absolute,tree);
      continue;
    }
    if(!stat.isFile())fail('Prepared source contains a non-regular file.','RELEASE_SOURCE_MODE_FORBIDDEN','verify');
    if(stat.nlink!==1n)fail('Prepared source contains a hard-linked file.','RELEASE_SOURCE_LINK_COUNT','verify');
    tree.files.push({
      absolute,
      path:path.relative(root,absolute).split(path.sep).join('/'),
      snapshot:stat
    });
  }
  let currentAfter;
  try{currentAfter=await fsp.lstat(current,{bigint:true});}catch{sourceChanged();}
  if(currentAfter.isSymbolicLink()||!currentAfter.isDirectory()||
    !sameFileIdentity(currentBefore,currentAfter))sourceChanged();
  return tree;
}

function expectedDirectories(files){
  const directories=new Set();
  for(const file of files){
    const segments=file.path.split('/').slice(0,-1);
    for(let index=1;index<=segments.length;index++)directories.add(segments.slice(0,index).join('/'));
  }
  return [...directories].sort();
}

function durableDirectoryOrder(tree){
  return [...tree.directories]
    .sort((left,right)=>{
      const depthDifference=right.path.split('/').length-left.path.split('/').length;
      if(depthDifference!==0)return depthDifference;
      return left.path<right.path?-1:left.path>right.path?1:0;
    });
}

function sourceChanged(){
  fail('Prepared source changed while it was being verified.','RELEASE_SOURCE_CHANGED_DURING_VERIFY','verify');
}

function sameFileIdentity(left,right){
  return left.dev===right.dev&&left.ino===right.ino;
}

function sameFileSnapshot(left,right){
  return sameFileIdentity(left,right)&&left.mode===right.mode&&left.nlink===right.nlink&&
    left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs;
}

function assertStableRegularFile(stat){
  if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1n)sourceChanged();
}

async function verifyPreparedFile(found,wanted,{applyMode}){
  let pathBefore;
  try{pathBefore=await fsp.lstat(found.absolute,{bigint:true});}catch{sourceChanged();}
  assertStableRegularFile(pathBefore);
  if(!sameFileSnapshot(found.snapshot,pathBefore))sourceChanged();
  if(typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0){
    fail('Prepared source cannot be verified safely.','RELEASE_SOURCE_SAFE_OPEN_UNAVAILABLE','verify');
  }
  let handle;
  try{handle=await fsp.open(found.absolute,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{sourceChanged();}
  try{
    const opened=await handle.stat({bigint:true});
    assertStableRegularFile(opened);
    if(!sameFileSnapshot(pathBefore,opened))sourceChanged();
    const buffer=await handle.readFile();
    const afterRead=await handle.stat({bigint:true});
    if(!sameFileSnapshot(opened,afterRead))sourceChanged();
    if(buffer.byteLength!==wanted.bytes||digest(buffer)!==wanted.sha256){
      fail('Prepared source bytes do not match the candidate.','RELEASE_SOURCE_MATERIALIZATION_MISMATCH','verify');
    }
    const wantedMode=wanted.gitMode==='100755'?0o755:0o644;
    if(applyMode){
      try{
        await handle.chmod(wantedMode);
        await handle.sync();
      }catch{
        fail('Prepared source could not be made durable.','RELEASE_SOURCE_SYNC_FAILED','verify');
      }
    }
    const after=await handle.stat({bigint:true});
    let pathAfter;
    try{pathAfter=await fsp.lstat(found.absolute,{bigint:true});}catch{sourceChanged();}
    assertStableRegularFile(after);
    assertStableRegularFile(pathAfter);
    if(!sameFileIdentity(after,pathAfter)||after.size!==BigInt(wanted.bytes)||
      Number(after.mode&0o777n)!==wantedMode||Number(pathAfter.mode&0o777n)!==wantedMode){
      sourceChanged();
    }
  }finally{
    try{await handle.close();}catch{}
  }
}

async function requireDirectoryStable(record){
  let current;
  try{current=await fsp.lstat(record.absolute,{bigint:true});}catch{sourceChanged();}
  if(current.isSymbolicLink()||!current.isDirectory()||
    !sameFileIdentity(record.snapshot,current))sourceChanged();
}

function fileAncestorDirectories(tree,filePath){
  const records=[tree.root];
  const byPath=new Map(tree.directories.map(record=>[record.path,record]));
  const segments=filePath.split('/').slice(0,-1);
  for(let index=1;index<=segments.length;index++){
    const record=byPath.get(segments.slice(0,index).join('/'));
    if(!record)sourceChanged();
    records.push(record);
  }
  return records;
}

async function requireDirectoriesStable(records){
  for(const record of records)await requireDirectoryStable(record);
}

async function verifyPreparedSource(appRoot,sourceManifest,{afterInventory=null,applyModes=true}={}){
  const expected=sourceManifest.sourceTree.files;
  const tree=await actualTree(appRoot);
  const actual=tree.files;
  actual.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  tree.directories.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  const wantedDirectories=expectedDirectories(expected);
  if(tree.directories.length!==wantedDirectories.length||
    tree.directories.some((directory,index)=>directory.path!==wantedDirectories[index])){
    fail('Prepared source directory set does not match the candidate.','RELEASE_TRACKED_DIRECTORIES_MISMATCH','verify');
  }
  if(actual.length!==expected.length){
    fail('Prepared source file set does not match the candidate.','RELEASE_TRACKED_FILES_MISMATCH','verify');
  }
  if(afterInventory)await afterInventory({appRoot});
  for(let index=0;index<expected.length;index++){
    const wanted=expected[index];
    const found=actual[index];
    if(!found||found.path!==wanted.path){
      fail('Prepared source file set does not match the candidate.','RELEASE_TRACKED_FILES_MISMATCH','verify');
    }
    const ancestors=fileAncestorDirectories(tree,found.path);
    await requireDirectoriesStable(ancestors);
    await verifyPreparedFile(found,wanted,{applyMode:applyModes});
    await requireDirectoriesStable(ancestors);
  }
  await requireDirectoriesStable([tree.root,...tree.directories]);
  return tree;
}

async function writeSyncedJson(directory,name,value){
  const file=path.join(directory,name);
  const handle=await fsp.open(file,'wx',0o644);
  try{
    await handle.writeFile(`${JSON.stringify(value,null,2)}\n`,'utf8');
    await handle.sync();
  }finally{
    await handle.close();
  }
}

async function syncDirectory(directory,{mode=null,identity=null}={}){
  if(typeof fsConstants.O_DIRECTORY!=='number'||fsConstants.O_DIRECTORY===0||
    typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0){
    fail('Prepared source directories cannot be synchronized safely.','RELEASE_SOURCE_SYNC_FAILED','verify');
  }
  let pathBefore;
  try{pathBefore=await fsp.lstat(directory,{bigint:true});}catch{
    fail('Prepared source directory could not be synchronized.','RELEASE_SOURCE_SYNC_FAILED','verify');
  }
  if(pathBefore.isSymbolicLink()||!pathBefore.isDirectory()){
    fail('Prepared source directory could not be synchronized.','RELEASE_SOURCE_SYNC_FAILED','verify');
  }
  if(identity&&!sameFileIdentity(pathBefore,identity))sourceChanged();
  let handle;
  try{
    handle=await fsp.open(directory,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);
  }catch{
    fail('Prepared source directory could not be synchronized.','RELEASE_SOURCE_SYNC_FAILED','verify');
  }
  try{
    const opened=await handle.stat({bigint:true});
    if(!opened.isDirectory()||!sameFileIdentity(pathBefore,opened)){
      fail('Prepared source directory changed during synchronization.','RELEASE_SOURCE_SYNC_FAILED','verify');
    }
    if(identity&&!sameFileIdentity(opened,identity))sourceChanged();
    if(mode!==null)await handle.chmod(mode);
    await handle.sync();
    const after=await handle.stat({bigint:true});
    const pathAfter=await fsp.lstat(directory,{bigint:true});
    if(pathAfter.isSymbolicLink()||!pathAfter.isDirectory()||!after.isDirectory()||
      !sameFileIdentity(after,pathAfter)||
      (identity&&(!sameFileIdentity(after,identity)||!sameFileIdentity(pathAfter,identity)))||
      (mode!==null&&(Number(after.mode&0o777n)!==mode||Number(pathAfter.mode&0o777n)!==mode))){
      sourceChanged();
    }
  }catch(error){
    if(error?.code?.startsWith?.('RELEASE_'))throw error;
    fail('Prepared source directory could not be synchronized.','RELEASE_SOURCE_SYNC_FAILED','verify');
  }finally{
    try{await handle.close();}catch{}
  }
}

export async function synchronizeReleaseDirectory(directory,options={}){
  const target=requiredPath(directory,'RELEASE_DIRECTORY_INVALID');
  await syncDirectory(target,options);
}

async function synchronizeDirectory(syncDirectoryImplementation,directory,options){
  try{
    await syncDirectoryImplementation(directory,options);
  }catch(error){
    if(error?.code?.startsWith?.('RELEASE_'))throw error;
    fail('Prepared source directory could not be synchronized.','RELEASE_SOURCE_SYNC_FAILED','verify');
  }
}

async function runFdHelper(script,args,parentFd){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const child=spawn('/usr/bin/python3',[
      '-c',script,...args
    ],{
      env:commandEnv(),
      stdio:['ignore','ignore','ignore',parentFd]
    });
    child.once('error',error=>{
      if(settled)return;
      settled=true;
      reject(Object.assign(error,{fdHelperUnavailable:true}));
    });
    child.once('exit',(code,signal)=>{
      if(settled)return;
      settled=true;
      if(code===0){
        resolve();
        return;
      }
      reject(Object.assign(new Error('Exclusive rename failed.'),{
        errno:Number.isInteger(code)?code:null,
        signal,
        fdHelperUnavailable:code===254
      }));
    });
  });
}

async function runExclusiveRename(parentFd,sourceName,destinationName){
  const script=process.platform==='darwin'
    ?DARWIN_EXCLUSIVE_RENAME_SCRIPT
    :process.platform==='linux'?LINUX_EXCLUSIVE_RENAME_SCRIPT:null;
  if(!script){
    throw Object.assign(new Error('Exclusive rename is unavailable.'),{
      exclusiveRenameUnavailable:true
    });
  }
  try{
    await runFdHelper(script,[sourceName,destinationName],parentFd);
  }catch(error){
    throw Object.assign(error,{exclusiveRenameUnavailable:error.fdHelperUnavailable});
  }
}

function parseLockRecord(buffer,destinationName){
  let value;
  try{value=JSON.parse(buffer.toString('utf8'));}catch{
    fail('Release preparation lock record is invalid.','RELEASE_BUILD_LOCK_INVALID','lock');
  }
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().some((key,index)=>key!==LOCK_RECORD_KEYS[index])||
    Object.keys(value).length!==LOCK_RECORD_KEYS.length||value.schemaVersion!==1||
    !Number.isSafeInteger(value.pid)||value.pid<=0||
    typeof value.processStartIdentity!=='string'||!value.processStartIdentity||
    value.processStartIdentity.length>256||/[\u0000-\u001f\u007f]/.test(value.processStartIdentity)||
    typeof value.nonce!=='string'||!/^[a-f0-9]{32}$/.test(value.nonce)||
    typeof value.createdAt!=='string'||Number.isNaN(Date.parse(value.createdAt))||
    new Date(value.createdAt).toISOString()!==value.createdAt||
    value.stagingName!==`.${destinationName}.staging-${value.nonce}`){
    fail('Release preparation lock record is invalid.','RELEASE_BUILD_LOCK_INVALID','lock');
  }
  return Object.freeze({...value});
}

async function removeStaleStaging(physicalParent,destinationName,record){
  const expectedName=`.${destinationName}.staging-${record.nonce}`;
  if(record.stagingName!==expectedName)return;
  const stalePath=path.join(physicalParent,expectedName);
  let stat;
  try{stat=await fsp.lstat(stalePath);}catch(error){
    if(error?.code==='ENOENT')return;
    fail('Stale release preparation state could not be inspected.','RELEASE_BUILD_STALE_CLEANUP_FAILED','lock');
  }
  if(stat.isSymbolicLink()||!stat.isDirectory()){
    fail('Stale release preparation state is unsafe.','RELEASE_BUILD_STALE_STATE_UNSAFE','lock');
  }
  try{await fsp.rm(stalePath,{recursive:true,force:true});}catch{
    fail('Stale release preparation state could not be removed.','RELEASE_BUILD_STALE_CLEANUP_FAILED','lock');
  }
}

async function acquireBuildLock({
  lockPath,
  physicalParent,
  destinationName,
  processStartIdentityImplementation,
  syncLockParentImplementation
}){
  if(!['darwin','linux'].includes(process.platform)||
    typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0){
    fail('Release preparation locking is unavailable.','RELEASE_BUILD_LOCK_FAILED','lock');
  }
  let handle;
  try{
    handle=await fsp.open(
      lockPath,
      fsConstants.O_RDWR|fsConstants.O_CREAT|fsConstants.O_NOFOLLOW,
      0o600
    );
  }catch(error){
    if(error?.code==='ELOOP')fail('Release preparation lock is unsafe.','RELEASE_BUILD_LOCK_UNSAFE','lock');
    fail('Release preparation lock could not be opened.','RELEASE_BUILD_LOCK_FAILED','lock');
  }
  try{
    try{
      await runFdHelper(FILE_LOCK_SCRIPT,[],handle.fd);
    }catch(error){
      if(error.errno===os.constants.errno.EAGAIN||error.errno===os.constants.errno.EWOULDBLOCK){
        fail('Release preparation is already running.','RELEASE_BUILD_BUSY','lock');
      }
      fail('Release preparation lock could not be acquired.','RELEASE_BUILD_LOCK_FAILED','lock');
    }
    const [opened,current]=await Promise.all([
      handle.stat({bigint:true}),
      fsp.lstat(lockPath,{bigint:true})
    ]);
    if(!opened.isFile()||opened.nlink!==1n||current.isSymbolicLink()||!current.isFile()||
      current.nlink!==1n||!sameFileIdentity(opened,current)||Number(opened.mode&0o7000n)!==0){
      fail('Release preparation lock is unsafe.','RELEASE_BUILD_LOCK_UNSAFE','lock');
    }
    if(opened.size>4096n){
      fail('Release preparation lock record is invalid.','RELEASE_BUILD_LOCK_INVALID','lock');
    }
    let previous=null;
    if(opened.size>0n){
      const buffer=Buffer.alloc(Number(opened.size));
      const {bytesRead}=await handle.read(buffer,0,buffer.byteLength,0);
      if(bytesRead!==buffer.byteLength){
        fail('Release preparation lock record is invalid.','RELEASE_BUILD_LOCK_INVALID','lock');
      }
      previous=parseLockRecord(buffer,destinationName);
      await removeStaleStaging(physicalParent,destinationName,previous);
    }
    const nonce=crypto.randomBytes(16).toString('hex');
    const record=Object.freeze({
      schemaVersion:1,
      pid:process.pid,
      processStartIdentity:await processStartIdentityImplementation(process.pid),
      nonce,
      createdAt:new Date().toISOString(),
      stagingName:`.${destinationName}.staging-${nonce}`
    });
    const bytes=Buffer.from(`${JSON.stringify(record,null,2)}\n`,'utf8');
    await handle.chmod(0o600);
    await handle.truncate(0);
    const {bytesWritten}=await handle.write(bytes,0,bytes.byteLength,0);
    if(bytesWritten!==bytes.byteLength){
      fail('Release preparation lock record could not be written.','RELEASE_BUILD_LOCK_FAILED','lock');
    }
    await handle.sync();
    const [after,pathAfter]=await Promise.all([
      handle.stat({bigint:true}),
      fsp.lstat(lockPath,{bigint:true})
    ]);
    if(!sameFileIdentity(after,pathAfter)||after.nlink!==1n||pathAfter.nlink!==1n||
      Number(after.mode&0o7777n)!==0o600||Number(pathAfter.mode&0o7777n)!==0o600||
      after.size!==BigInt(bytes.byteLength)||pathAfter.size!==BigInt(bytes.byteLength)){
      fail('Release preparation lock record could not be verified.','RELEASE_BUILD_LOCK_FAILED','lock');
    }
    try{
      await syncLockParentImplementation(physicalParent,{purpose:'acquire'});
    }catch{
      fail('Release preparation lock could not be made durable.','RELEASE_BUILD_LOCK_SYNC_FAILED','lock');
    }
    return Object.freeze({handle,record,previous});
  }catch(error){
    try{await handle.close();}catch{}
    throw error;
  }
}

async function releaseBuildLock({
  lockPath,
  physicalParent,
  handle,
  syncLockParentImplementation
}){
  try{
    const [opened,current]=await Promise.all([
      handle.stat({bigint:true}),
      fsp.lstat(lockPath,{bigint:true})
    ]);
    if(!opened.isFile()||opened.nlink!==1n||current.isSymbolicLink()||!current.isFile()||
      current.nlink!==1n||!sameFileIdentity(opened,current)){
      fail('Release preparation lock changed before release.','RELEASE_BUILD_LOCK_RELEASE_FAILED','cleanup');
    }
    try{await fsp.unlink(lockPath);}catch{
      fail('Release preparation lock could not be removed.','RELEASE_BUILD_LOCK_RELEASE_FAILED','cleanup');
    }
    try{
      await syncLockParentImplementation(physicalParent,{purpose:'release'});
    }catch{
      fail('Release preparation lock removal could not be made durable.','RELEASE_BUILD_LOCK_RELEASE_SYNC_FAILED','cleanup');
    }
  }finally{
    try{await handle.close();}catch(error){
      if(!error?.code?.startsWith?.('RELEASE_')){
        fail('Release preparation lock could not be closed.','RELEASE_BUILD_LOCK_CLOSE_FAILED','cleanup');
      }
      throw error;
    }
  }
}

async function cleanupPreparationState({
  staging,
  promoted,
  lockPath,
  physicalParent,
  lock,
  removeStagingImplementation,
  syncLockParentImplementation
}){
  const errors=[];
  let stagingRemoved=promoted||!staging;
  if(staging&&!promoted){
    try{
      await removeStagingImplementation(staging,{recursive:true,force:true});
      stagingRemoved=true;
    }catch{
      errors.push('RELEASE_STAGING_CLEANUP_FAILED');
    }
  }
  if(stagingRemoved){
    try{
      await releaseBuildLock({
        lockPath,
        physicalParent,
        handle:lock,
        syncLockParentImplementation
      });
    }catch(error){
      errors.push(error?.code?.startsWith?.('RELEASE_')?error.code:'RELEASE_BUILD_LOCK_RELEASE_FAILED');
    }
  }else{
    try{await lock.close();}catch{
      errors.push('RELEASE_BUILD_LOCK_CLOSE_FAILED');
    }
  }
  return Object.freeze([...new Set(errors)]);
}

async function renameDirectoryExclusive(source,destination){
  const parent=path.dirname(source);
  if(!['darwin','linux'].includes(process.platform)||path.dirname(destination)!==parent||
    typeof fsConstants.O_DIRECTORY!=='number'||fsConstants.O_DIRECTORY===0||
    typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0){
    fail('Atomic release promotion is unavailable.','RELEASE_ATOMIC_PROMOTION_UNAVAILABLE','promote');
  }
  let parentBefore;
  let sourceBefore;
  try{
    [parentBefore,sourceBefore]=await Promise.all([
      fsp.lstat(parent,{bigint:true}),
      fsp.lstat(source,{bigint:true})
    ]);
  }catch{
    fail('Prepared source could not be promoted.','RELEASE_PROMOTION_FAILED','promote');
  }
  if(parentBefore.isSymbolicLink()||!parentBefore.isDirectory()||
    sourceBefore.isSymbolicLink()||!sourceBefore.isDirectory()){
    fail('Prepared source could not be promoted.','RELEASE_PROMOTION_FAILED','promote');
  }
  let handle;
  try{
    handle=await fsp.open(parent,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);
  }catch{
    fail('Atomic release promotion is unavailable.','RELEASE_ATOMIC_PROMOTION_UNAVAILABLE','promote');
  }
  let operationError=null;
  try{
    const opened=await handle.stat({bigint:true});
    if(!opened.isDirectory()||!sameFileIdentity(parentBefore,opened)){
      fail('Prepared source promotion state is uncertain.','RELEASE_PROMOTION_STATE_UNCERTAIN','promote');
    }
    try{
      await runExclusiveRename(handle.fd,path.basename(source),path.basename(destination));
    }catch(error){
      operationError=error;
    }
    const after=await handle.stat({bigint:true});
    const parentAfter=await fsp.lstat(parent,{bigint:true});
    if(parentAfter.isSymbolicLink()||!parentAfter.isDirectory()||!after.isDirectory()||
      !sameFileIdentity(after,parentAfter)||!sameFileIdentity(parentBefore,after)){
      fail('Prepared source promotion state is uncertain.','RELEASE_PROMOTION_STATE_UNCERTAIN','promote');
    }
  }catch(error){
    if(error?.code?.startsWith?.('RELEASE_'))throw error;
    fail('Prepared source promotion state is uncertain.','RELEASE_PROMOTION_STATE_UNCERTAIN','promote');
  }finally{
    try{await handle.close();}catch{}
  }
  if(operationError){
    if(operationError.errno===os.constants.errno.EEXIST){
      fail('Prepared release destination already exists.','RELEASE_OUTPUT_EXISTS','promote');
    }
    if(operationError.exclusiveRenameUnavailable||
      operationError.errno===os.constants.errno.ENOTSUP||
      operationError.errno===os.constants.errno.ENOSYS){
      fail('Atomic release promotion is unavailable.','RELEASE_ATOMIC_PROMOTION_UNAVAILABLE','promote');
    }
    fail('Prepared source could not be promoted.','RELEASE_PROMOTION_FAILED','promote');
  }
  let destinationAfter;
  try{destinationAfter=await fsp.lstat(destination,{bigint:true});}catch{
    fail('Prepared source promotion state is uncertain.','RELEASE_PROMOTION_STATE_UNCERTAIN','promote');
  }
  if(destinationAfter.isSymbolicLink()||!destinationAfter.isDirectory()||
    !sameFileIdentity(sourceBefore,destinationAfter)){
    fail('Prepared source promotion state is uncertain.','RELEASE_PROMOTION_STATE_UNCERTAIN','promote');
  }
  try{
    await fsp.lstat(source);
    fail('Prepared source promotion state is uncertain.','RELEASE_PROMOTION_STATE_UNCERTAIN','promote');
  }catch(error){
    if(error?.code!=='ENOENT')throw error;
  }
}

async function promotePreparedSource({
  staging,
  destination,
  physicalParent,
  syncDirectoryImplementation,
  promoteDirectoryImplementation
}){
  try{
    await promoteDirectoryImplementation(staging,destination);
  }catch(error){
    if(error?.code?.startsWith?.('RELEASE_'))throw error;
    fail('Prepared source could not be promoted.','RELEASE_PROMOTION_FAILED','promote');
  }
  try{
    await synchronizeDirectory(syncDirectoryImplementation,physicalParent,{});
  }catch{
    try{
      await promoteDirectoryImplementation(destination,staging);
      await synchronizeDirectory(syncDirectoryImplementation,physicalParent,{});
    }catch{
      fail('Prepared source promotion state is uncertain.','RELEASE_PROMOTION_STATE_UNCERTAIN','promote');
    }
    fail('Prepared source promotion was not durable and was rolled back.','RELEASE_PROMOTION_SYNC_FAILED','promote');
  }
}

export async function promoteReleaseDirectoryAtomically({source,destination}={},dependencies={}){
  const sourcePath=requiredPath(source,'RELEASE_PROMOTION_SOURCE_INVALID');
  const destinationPath=requiredPath(destination,'RELEASE_PROMOTION_DESTINATION_INVALID');
  const parent=path.dirname(sourcePath);
  if(path.dirname(destinationPath)!==parent){
    fail('Atomic promotion paths must share one parent.','RELEASE_PROMOTION_PARENT_MISMATCH','promote');
  }
  await requireRealDirectory(parent,'RELEASE_PROMOTION_PARENT_INVALID');
  const syncDirectoryImplementation=dependencies.syncDirectory||syncDirectory;
  const promoteDirectoryImplementation=dependencies.promoteDirectory||renameDirectoryExclusive;
  if(typeof syncDirectoryImplementation!=='function'||typeof promoteDirectoryImplementation!=='function'){
    fail('Atomic promotion dependencies are invalid.','RELEASE_PROMOTION_DEPENDENCY_INVALID','promote');
  }
  await promotePreparedSource({
    staging:sourcePath,
    destination:destinationPath,
    physicalParent:parent,
    syncDirectoryImplementation,
    promoteDirectoryImplementation
  });
  return destinationPath;
}

export async function prepareReleaseSourceArtifact({
  repositoryRoot,
  candidateCommit,
  destinationRoot,
  builtAt,
  nodeVersion,
  npmVersion
}={},dependencies={}){
  const materializeSource=dependencies.materializeSource||materializeReleaseSource;
  const afterSourceInventory=dependencies.afterSourceInventory||null;
  const afterFinalSourceVerify=dependencies.afterFinalSourceVerify||null;
  const syncDirectoryImplementation=dependencies.syncDirectory||syncDirectory;
  const beforePromotion=dependencies.beforePromotion||null;
  const promoteDirectoryImplementation=dependencies.promoteDirectory||renameDirectoryExclusive;
  const processStartIdentityImplementation=dependencies.processStartIdentity||processStartIdentity;
  const removeStagingImplementation=dependencies.removeStaging||fsp.rm;
  const syncLockParentImplementation=dependencies.syncLockParent||syncDirectory;
  if(typeof materializeSource!=='function'){
    fail('Release source materializer is invalid.','RELEASE_MATERIALIZER_INVALID');
  }
  if(afterSourceInventory!==null&&typeof afterSourceInventory!=='function'){
    fail('Release source verification hook is invalid.','RELEASE_VERIFICATION_HOOK_INVALID');
  }
  if(afterFinalSourceVerify!==null&&typeof afterFinalSourceVerify!=='function'){
    fail('Release final verification hook is invalid.','RELEASE_FINAL_VERIFICATION_HOOK_INVALID');
  }
  if(typeof syncDirectoryImplementation!=='function'){
    fail('Release source directory synchronizer is invalid.','RELEASE_DIRECTORY_SYNCHRONIZER_INVALID');
  }
  if(beforePromotion!==null&&typeof beforePromotion!=='function'){
    fail('Release promotion hook is invalid.','RELEASE_PROMOTION_HOOK_INVALID');
  }
  if(typeof promoteDirectoryImplementation!=='function'){
    fail('Release promoter is invalid.','RELEASE_PROMOTER_INVALID');
  }
  if(typeof processStartIdentityImplementation!=='function'){
    fail('Release process identity provider is invalid.','RELEASE_PROCESS_IDENTITY_PROVIDER_INVALID');
  }
  if(typeof removeStagingImplementation!=='function'){
    fail('Release staging remover is invalid.','RELEASE_STAGING_REMOVER_INVALID');
  }
  if(typeof syncLockParentImplementation!=='function'){
    fail('Release lock directory synchronizer is invalid.','RELEASE_LOCK_SYNCHRONIZER_INVALID');
  }
  const repository=requiredPath(repositoryRoot,'RELEASE_REPOSITORY_ROOT_INVALID');
  const requestedDestination=requiredPath(destinationRoot,'RELEASE_OUTPUT_INVALID');
  const requestedParent=path.dirname(requestedDestination);
  const destinationName=path.basename(requestedDestination);
  if(isWithin(repository,requestedDestination)){
    fail('Prepared release must be outside the source repository.','RELEASE_OUTPUT_INSIDE_REPOSITORY');
  }
  await requireRealDirectory(requestedParent,'RELEASE_OUTPUT_PARENT_INVALID');
  let physicalRepository;
  let physicalParent;
  try{
    [physicalRepository,physicalParent]=await Promise.all([
      fsp.realpath(repository),
      fsp.realpath(requestedParent)
    ]);
  }catch{
    fail('Release preparation paths could not be resolved safely.','RELEASE_OUTPUT_PARENT_INVALID');
  }
  const parentIdentity=await directoryIdentity(physicalParent,'RELEASE_OUTPUT_PARENT_INVALID');
  await requireStableParent({requestedParent,physicalParent,identity:parentIdentity});
  const destination=path.join(physicalParent,destinationName);
  if(isWithin(physicalRepository,destination)){
    fail('Prepared release must be outside the source repository.','RELEASE_OUTPUT_INSIDE_REPOSITORY');
  }
  await requireMissing(destination);

  const lockPath=path.join(physicalParent,`.${destinationName}.prepare.lock`);
  const lockState=await acquireBuildLock({
    lockPath,
    physicalParent,
    destinationName,
    processStartIdentityImplementation,
    syncLockParentImplementation
  });
  const lock=lockState.handle;

  let staging;
  let promoted=false;
  let result=null;
  let primaryError=null;
  try{
    await requireStableParent({requestedParent,physicalParent,identity:parentIdentity});
    await requireMissing(destination);
    const sourceManifest=await inspectReleaseCandidate({repositoryRoot:physicalRepository,candidateCommit});
    await requireStableParent({requestedParent,physicalParent,identity:parentIdentity});
    const plannedStaging=path.join(physicalParent,lockState.record.stagingName);
    await fsp.mkdir(plannedStaging,{mode:0o700});
    staging=plannedStaging;
    const appRoot=path.join(staging,'app');
    const metadataRoot=path.join(staging,'metadata');
    const archiveFile=path.join(staging,'source.tar');
    await fsp.mkdir(appRoot,{mode:0o755});
    await fsp.mkdir(metadataRoot,{mode:0o755});
    await materializeSource({repositoryRoot:physicalRepository,candidateCommit,archiveFile,appRoot});
    await requireStableParent({requestedParent,physicalParent,identity:parentIdentity});
    await verifyPreparedSource(appRoot,sourceManifest,{afterInventory:afterSourceInventory});

    const releaseContract=await createReleaseContract({
      projectRoot:appRoot,
      candidateCommit,
      nodeVersion,
      npmVersion
    });
    const buildIdentity=validateBuildIdentity({
      schemaVersion:1,
      productVersion:releaseContract.productVersion,
      commit:candidateCommit,
      builtAt
    });
    const publicRoot=path.join(appRoot,'public');
    const staticManifest=await createStaticAssetManifest(publicRoot,buildIdentity,{
      assetPaths:sourceManifest.trackedPublicPaths
    });
    await loadVerifiedStaticAssets(publicRoot,staticManifest);

    await writeSyncedJson(metadataRoot,'source-manifest.json',sourceManifest);
    await writeSyncedJson(metadataRoot,'release-contract.json',releaseContract);
    await writeSyncedJson(metadataRoot,'static-manifest.json',staticManifest);
    const finalSourceTree=await verifyPreparedSource(appRoot,sourceManifest,{applyModes:false});
    if(afterFinalSourceVerify)await afterFinalSourceVerify({appRoot});
    for(const directory of durableDirectoryOrder(finalSourceTree)){
      await synchronizeDirectory(syncDirectoryImplementation,directory.absolute,{
        mode:0o755,
        identity:directory.snapshot
      });
    }
    await synchronizeDirectory(syncDirectoryImplementation,appRoot,{
      mode:0o755,
      identity:finalSourceTree.root.snapshot
    });
    await synchronizeDirectory(syncDirectoryImplementation,metadataRoot,{});
    await synchronizeDirectory(syncDirectoryImplementation,staging,{});
    await requireStableParent({requestedParent,physicalParent,identity:parentIdentity});
    await requireMissing(destination);
    if(beforePromotion)await beforePromotion({
      staging,
      destination,
      physicalParent,
      appRoot,
      metadataRoot,
      sourceManifest,
      releaseContract,
      staticManifest
    });
    await promotePreparedSource({
      staging,
      destination,
      physicalParent,
      syncDirectoryImplementation,
      promoteDirectoryImplementation
    });
    promoted=true;
    result={
      artifactPath:requestedDestination,
      sourceManifest,
      releaseContract,
      staticManifest
    };
  }catch(error){
    primaryError=error;
  }
  const cleanupErrors=await cleanupPreparationState({
    staging,
    promoted,
    lockPath,
    physicalParent,
    lock,
    removeStagingImplementation,
    syncLockParentImplementation
  });
  if(primaryError){
    if(cleanupErrors.length>0){
      Object.defineProperty(primaryError,'cleanupErrors',{
        value:cleanupErrors,
        enumerable:true
      });
    }
    throw primaryError;
  }
  if(cleanupErrors.length>0)result.cleanupWarnings=cleanupErrors;
  return Object.freeze(result);
}
