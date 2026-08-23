import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {parseWorkbenchEnv} from './env.mjs';

export const CONFIG_REVISION_SCHEMA_VERSION=1;

const REVISION_ID_RE=/^cfg_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256_RE=/^sha256:[a-f0-9]{64}$/;
const DIRECTORY_MODE=0o700;
const FILE_MODE=0o600;
const ENV_NAME='workbench.env';
const MANIFEST_NAME='revision.json';
const MANIFEST_KEYS=Object.freeze(['schemaVersion','revisionId','envFile','envSha256','bytes']);
const SAFE_ERROR=Symbol('configRevisionSafeError');
const UTF8_DECODER=new TextDecoder('utf-8',{fatal:true});

function fail(message,code){
  const error=Object.assign(new Error(message),{code});
  Object.defineProperty(error,SAFE_ERROR,{value:true});
  throw error;
}

function rethrowSafe(error){
  if(error?.[SAFE_ERROR])throw error;
  fail('Configuration revision filesystem operation failed.','CONFIG_REVISION_IO');
}

function validateRuntimeRoot(value){
  if(typeof value!=='string'||value.trim()===''||value.includes('\0')||!path.isAbsolute(value)){
    fail('Invalid configuration runtime root.','CONFIG_REVISION_INVALID_ROOT');
  }
  return path.resolve(value);
}

function validateRevisionId(value){
  if(typeof value!=='string'||!REVISION_ID_RE.test(value)){
    fail('Invalid configuration revision id.','CONFIG_REVISION_INVALID_ID');
  }
  return value;
}

function validateSource(source){
  if(typeof source!=='string')fail('Configuration revision source must be a string.','CONFIG_REVISION_INVALID_SOURCE');
  const parsed=parseWorkbenchEnv(source);
  if(!parsed||!Array.isArray(parsed.ignored)||parsed.ignored.length!==0){
    fail('Configuration revision source contains rejected lines.','CONFIG_REVISION_INVALID_ENV');
  }
  return Buffer.from(source,'utf8');
}

function digest(buffer){
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function modeOf(stat){
  return Number(stat.mode&0o777n);
}

function requireNoFollowFlags({directory=false}={}){
  if(typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0||
    (directory&&(typeof fsConstants.O_DIRECTORY!=='number'||fsConstants.O_DIRECTORY===0))){
    fail('Safe configuration revision filesystem flags are unavailable.','CONFIG_REVISION_PLATFORM_UNSAFE');
  }
  return fsConstants.O_NOFOLLOW|(directory?fsConstants.O_DIRECTORY:0);
}

async function lstatOrNull(target){
  try{return await fsp.lstat(target,{bigint:true});}
  catch(error){if(error?.code==='ENOENT')return null;throw error;}
}

function assertDirectoryStat(stat,{symlinkCode,typeCode,modeCode}){
  if(stat.isSymbolicLink())fail('Configuration revision path must not be a symbolic link.',symlinkCode);
  if(!stat.isDirectory())fail('Configuration revision path must be a directory.',typeCode);
  if(modeOf(stat)!==DIRECTORY_MODE)fail('Configuration revision directory has unsafe permissions.',modeCode);
}

async function requireDirectory(target,codes,{missingCode}={}){
  const stat=await lstatOrNull(target);
  if(!stat){
    if(missingCode)fail('Configuration revision directory is missing.',missingCode);
    return null;
  }
  assertDirectoryStat(stat,codes);
  return stat;
}

async function syncDirectory(directory){
  const flags=fsConstants.O_RDONLY|requireNoFollowFlags({directory:true});
  let handle;
  try{handle=await fsp.open(directory,flags);}
  catch(error){
    if(error?.code==='ELOOP')fail('Configuration revision directory must not be a symbolic link.','CONFIG_REVISION_DIRECTORY_CHANGED');
    throw error;
  }
  try{
    const stat=await handle.stat({bigint:true});
    if(!stat.isDirectory())fail('Configuration revision directory changed during use.','CONFIG_REVISION_DIRECTORY_CHANGED');
    await handle.sync();
  }finally{
    await handle.close();
  }
}

async function secureDirectoryMode(target,initial,codes){
  const flags=fsConstants.O_RDONLY|requireNoFollowFlags({directory:true});
  let handle;
  try{handle=await fsp.open(target,flags);}
  catch(error){
    if(error?.code==='ELOOP')fail('Configuration revision path must not be a symbolic link.',codes.symlinkCode);
    throw error;
  }
  try{
    const opened=await handle.stat({bigint:true});
    if(!opened.isDirectory())fail('Configuration revision path must be a directory.',codes.typeCode);
    if(!sameFileIdentity(initial,opened))fail('Configuration revision directory changed during use.','CONFIG_REVISION_DIRECTORY_CHANGED');
    await handle.chmod(DIRECTORY_MODE);
    await handle.sync();
    const secured=await handle.stat({bigint:true});
    assertDirectoryStat(secured,codes);
    const current=await fsp.lstat(target,{bigint:true});
    if(current.isSymbolicLink()||!sameFileIdentity(secured,current)){
      fail('Configuration revision directory changed during use.','CONFIG_REVISION_DIRECTORY_CHANGED');
    }
    assertDirectoryStat(current,codes);
  }finally{
    await handle.close();
  }
}

async function createOrSecureDirectory(target,codes,{syncParent=false}={}){
  let created=false;
  let stat=await lstatOrNull(target);
  if(!stat){
    try{
      await fsp.mkdir(target,{mode:DIRECTORY_MODE});
      created=true;
    }catch(error){
      if(error?.code!=='EEXIST')throw error;
    }
    stat=await lstatOrNull(target);
  }
  if(!stat)fail('Configuration revision directory could not be created.','CONFIG_REVISION_IO');
  if(stat.isSymbolicLink())fail('Configuration revision path must not be a symbolic link.',codes.symlinkCode);
  if(!stat.isDirectory())fail('Configuration revision path must be a directory.',codes.typeCode);
  await secureDirectoryMode(target,stat,codes);
  stat=await fsp.lstat(target,{bigint:true});
  assertDirectoryStat(stat,codes);
  if(created&&syncParent)await syncDirectory(path.dirname(target));
  return created;
}

function sameFileIdentity(left,right){
  return left.dev===right.dev&&left.ino===right.ino;
}

function sameFileSnapshot(left,right){
  return sameFileIdentity(left,right)&&
    left.size===right.size&&left.mode===right.mode&&left.nlink===right.nlink&&
    left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs;
}

async function readPrivateFile(target,role){
  const prefix=role==='env'?'CONFIG_REVISION_ENV':'CONFIG_REVISION_MANIFEST';
  const initial=await lstatOrNull(target);
  if(!initial)fail('Configuration revision is incomplete.','CONFIG_REVISION_INCOMPLETE');
  if(initial.isSymbolicLink())fail('Configuration revision file must not be a symbolic link.',`${prefix}_SYMLINK`);
  if(!initial.isFile())fail('Configuration revision file must be regular.',`${prefix}_NOT_REGULAR`);
  if(modeOf(initial)!==FILE_MODE)fail('Configuration revision file has unsafe permissions.',`${prefix}_MODE`);
  if(initial.nlink!==1n)fail('Configuration revision file must not have additional hard links.',`${prefix}_LINK_COUNT`);

  const flags=fsConstants.O_RDONLY|requireNoFollowFlags();
  let handle;
  try{handle=await fsp.open(target,flags);}
  catch(error){
    if(error?.code==='ELOOP')fail('Configuration revision file must not be a symbolic link.',`${prefix}_SYMLINK`);
    if(error?.code==='ENOENT')fail('Configuration revision changed during verification.','CONFIG_REVISION_CHANGED_DURING_READ');
    throw error;
  }
  try{
    const before=await handle.stat({bigint:true});
    if(!before.isFile())fail('Configuration revision file must be regular.',`${prefix}_NOT_REGULAR`);
    if(!sameFileIdentity(initial,before))fail('Configuration revision changed during verification.','CONFIG_REVISION_CHANGED_DURING_READ');
    if(modeOf(before)!==FILE_MODE)fail('Configuration revision file has unsafe permissions.',`${prefix}_MODE`);
    if(before.nlink!==1n)fail('Configuration revision file must not have additional hard links.',`${prefix}_LINK_COUNT`);
    const buffer=await handle.readFile();
    const after=await handle.stat({bigint:true});
    const current=await lstatOrNull(target);
    if(!sameFileSnapshot(before,after)||!current||current.isSymbolicLink()||!sameFileSnapshot(after,current)){
      fail('Configuration revision changed during verification.','CONFIG_REVISION_CHANGED_DURING_READ');
    }
    return buffer;
  }finally{
    await handle.close();
  }
}

function decodeUtf8(buffer,code){
  try{return UTF8_DECODER.decode(buffer);}
  catch{fail('Configuration revision text is not valid UTF-8.',code);}
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function parseManifest(buffer,revisionId){
  let value;
  try{value=JSON.parse(decodeUtf8(buffer,'CONFIG_REVISION_MANIFEST_INVALID'));}
  catch{fail('Configuration revision manifest is invalid.','CONFIG_REVISION_MANIFEST_INVALID');}
  if(!isPlainObject(value))fail('Configuration revision manifest is invalid.','CONFIG_REVISION_MANIFEST_INVALID');
  const keys=Object.keys(value).sort();
  const expected=[...MANIFEST_KEYS].sort();
  if(keys.length!==expected.length||keys.some((key,index)=>key!==expected[index])){
    fail('Configuration revision manifest has missing or unsupported fields.','CONFIG_REVISION_MANIFEST_INVALID');
  }
  if(value.schemaVersion!==CONFIG_REVISION_SCHEMA_VERSION||value.revisionId!==revisionId||value.envFile!==ENV_NAME){
    fail('Configuration revision manifest identity is invalid.','CONFIG_REVISION_MANIFEST_INVALID');
  }
  if(typeof value.envSha256!=='string'||!SHA256_RE.test(value.envSha256)||
    !Number.isSafeInteger(value.bytes)||value.bytes<0){
    fail('Configuration revision manifest metadata is invalid.','CONFIG_REVISION_MANIFEST_INVALID');
  }
  return value;
}

function pathsFor(runtimeRoot,revisionId){
  const revisionsDirectory=path.join(runtimeRoot,'config-revisions');
  const revisionDirectory=path.join(revisionsDirectory,revisionId);
  const envFile=path.join(revisionDirectory,ENV_NAME);
  const manifestFile=path.join(revisionDirectory,MANIFEST_NAME);
  if(path.dirname(envFile)!==revisionDirectory||path.dirname(manifestFile)!==revisionDirectory){
    fail('Configuration revision path ownership is invalid.','CONFIG_REVISION_PATH_ESCAPE');
  }
  return{revisionsDirectory,revisionDirectory,envFile,manifestFile};
}

function descriptor(paths,revisionId,manifest,created){
  return Object.freeze({
    schemaVersion:CONFIG_REVISION_SCHEMA_VERSION,
    revisionId,
    envFile:paths.envFile,
    manifestFile:paths.manifestFile,
    envSha256:manifest.envSha256,
    bytes:manifest.bytes,
    created
  });
}

async function verifyDirectoryEntries(revisionDirectory){
  const entries=(await fsp.readdir(revisionDirectory)).sort();
  const expected=[ENV_NAME,MANIFEST_NAME].sort();
  const missing=expected.some(name=>!entries.includes(name));
  if(missing)fail('Configuration revision is incomplete.','CONFIG_REVISION_INCOMPLETE');
  if(entries.length!==expected.length||entries.some((name,index)=>name!==expected[index])){
    fail('Configuration revision contains unsupported entries.','CONFIG_REVISION_EXTRA_ENTRY');
  }
}

async function assertDirectoryUnchanged(target,initial){
  const current=await lstatOrNull(target);
  if(!current||current.isSymbolicLink()||!current.isDirectory()||
    !sameFileIdentity(initial,current)||modeOf(current)!==DIRECTORY_MODE){
    fail('Configuration revision directory changed during verification.','CONFIG_REVISION_DIRECTORY_CHANGED');
  }
}

async function readVerifiedInternal(runtimeRoot,revisionId){
  const paths=pathsFor(runtimeRoot,revisionId);
  const root=await requireDirectory(runtimeRoot,{
    symlinkCode:'CONFIG_REVISION_ROOT_SYMLINK',
    typeCode:'CONFIG_REVISION_ROOT_NOT_DIRECTORY',
    modeCode:'CONFIG_REVISION_ROOT_MODE'
  },{missingCode:'CONFIG_REVISION_ROOT_MISSING'});
  const revisions=await requireDirectory(paths.revisionsDirectory,{
    symlinkCode:'CONFIG_REVISIONS_SYMLINK',
    typeCode:'CONFIG_REVISIONS_NOT_DIRECTORY',
    modeCode:'CONFIG_REVISIONS_MODE'
  });
  if(!revisions)fail('Configuration revision was not found.','CONFIG_REVISION_NOT_FOUND');
  const target=await requireDirectory(paths.revisionDirectory,{
    symlinkCode:'CONFIG_REVISION_TARGET_SYMLINK',
    typeCode:'CONFIG_REVISION_TARGET_NOT_DIRECTORY',
    modeCode:'CONFIG_REVISION_TARGET_MODE'
  });
  if(!target)fail('Configuration revision was not found.','CONFIG_REVISION_NOT_FOUND');

  await verifyDirectoryEntries(paths.revisionDirectory);
  const [envBuffer,manifestBuffer]=await Promise.all([
    readPrivateFile(paths.envFile,'env'),
    readPrivateFile(paths.manifestFile,'manifest')
  ]);
  const manifest=parseManifest(manifestBuffer,revisionId);
  const parsed=parseWorkbenchEnv(decodeUtf8(envBuffer,'CONFIG_REVISION_INVALID_ENV'));
  if(!parsed||!Array.isArray(parsed.ignored)||parsed.ignored.length!==0){
    fail('Configuration revision source contains rejected lines.','CONFIG_REVISION_INVALID_ENV');
  }
  if(manifest.bytes!==envBuffer.byteLength||manifest.envSha256!==digest(envBuffer)){
    fail('Configuration revision content does not match its manifest.','CONFIG_REVISION_ENV_MISMATCH');
  }
  await verifyDirectoryEntries(paths.revisionDirectory);
  await assertDirectoryUnchanged(paths.revisionDirectory,target);
  await assertDirectoryUnchanged(paths.revisionsDirectory,revisions);
  await assertDirectoryUnchanged(runtimeRoot,root);
  return descriptor(paths,revisionId,manifest,false);
}

function manifestFor(revisionId,envBuffer){
  return Object.freeze({
    schemaVersion:CONFIG_REVISION_SCHEMA_VERSION,
    revisionId,
    envFile:ENV_NAME,
    envSha256:digest(envBuffer),
    bytes:envBuffer.byteLength
  });
}

async function writeAtomicPrivateFile(directory,name,buffer){
  const temporaryName=`.${name}.tmp-${crypto.randomUUID()}`;
  const temporary=path.join(directory,temporaryName);
  const target=path.join(directory,name);
  const flags=fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|requireNoFollowFlags();
  let handle;
  let renamed=false;
  try{
    handle=await fsp.open(temporary,flags,FILE_MODE);
    await handle.writeFile(buffer);
    await handle.chmod(FILE_MODE);
    await handle.sync();
    await handle.close();
    handle=null;
    await fsp.rename(temporary,target);
    renamed=true;
    await syncDirectory(directory);
  }finally{
    if(handle)await handle.close().catch(()=>{});
    if(!renamed)await fsp.unlink(temporary).catch(()=>{});
  }
}

async function cleanupOwnedRevision(paths){
  const entries=await fsp.readdir(paths.revisionDirectory).catch(()=>[]);
  for(const name of entries){
    if(name===ENV_NAME||name===MANIFEST_NAME||name.startsWith(`.${ENV_NAME}.tmp-`)||name.startsWith(`.${MANIFEST_NAME}.tmp-`)){
      await fsp.unlink(path.join(paths.revisionDirectory,name)).catch(()=>{});
    }
  }
  await fsp.rmdir(paths.revisionDirectory).catch(()=>{});
  await syncDirectory(paths.revisionsDirectory).catch(()=>{});
}

async function prepareInternal({runtimeRoot,revisionId,source}){
  const root=validateRuntimeRoot(runtimeRoot);
  const id=validateRevisionId(revisionId);
  const envBuffer=validateSource(source);
  const expected=manifestFor(id,envBuffer);
  const paths=pathsFor(root,id);

  await createOrSecureDirectory(root,{
    symlinkCode:'CONFIG_REVISION_ROOT_SYMLINK',
    typeCode:'CONFIG_REVISION_ROOT_NOT_DIRECTORY',
    modeCode:'CONFIG_REVISION_ROOT_MODE'
  },{syncParent:true});
  await createOrSecureDirectory(paths.revisionsDirectory,{
    symlinkCode:'CONFIG_REVISIONS_SYMLINK',
    typeCode:'CONFIG_REVISIONS_NOT_DIRECTORY',
    modeCode:'CONFIG_REVISIONS_MODE'
  },{syncParent:true});

  let ownsTarget=false;
  try{
    try{
      await fsp.mkdir(paths.revisionDirectory,{mode:DIRECTORY_MODE});
      ownsTarget=true;
    }catch(error){
      if(error?.code!=='EEXIST')throw error;
    }
    if(!ownsTarget){
      const existing=await readVerifiedInternal(root,id);
      if(existing.envSha256!==expected.envSha256||existing.bytes!==expected.bytes){
        fail('Configuration revision id is already bound to different content.','CONFIG_REVISION_COLLISION');
      }
      return existing;
    }

    const targetCodes={
      symlinkCode:'CONFIG_REVISION_TARGET_SYMLINK',
      typeCode:'CONFIG_REVISION_TARGET_NOT_DIRECTORY',
      modeCode:'CONFIG_REVISION_TARGET_MODE'
    };
    const targetStat=await fsp.lstat(paths.revisionDirectory,{bigint:true});
    if(targetStat.isSymbolicLink())fail('Configuration revision path must not be a symbolic link.',targetCodes.symlinkCode);
    if(!targetStat.isDirectory())fail('Configuration revision path must be a directory.',targetCodes.typeCode);
    await secureDirectoryMode(paths.revisionDirectory,targetStat,targetCodes);
    await writeAtomicPrivateFile(paths.revisionDirectory,ENV_NAME,envBuffer);
    const manifestBuffer=Buffer.from(`${JSON.stringify(expected,null,2)}\n`,'utf8');
    await writeAtomicPrivateFile(paths.revisionDirectory,MANIFEST_NAME,manifestBuffer);
    await syncDirectory(paths.revisionDirectory);
    await syncDirectory(paths.revisionsDirectory);

    const verified=await readVerifiedInternal(root,id);
    ownsTarget=false;
    return descriptor(paths,id,verified,true);
  }catch(error){
    if(ownsTarget)await cleanupOwnedRevision(paths);
    throw error;
  }
}

export async function prepareConfigRevision(options={}){
  try{return await prepareInternal(options);}
  catch(error){rethrowSafe(error);}
}

export async function readVerifiedConfigRevision(options={}){
  try{
    const runtimeRoot=validateRuntimeRoot(options.runtimeRoot);
    const revisionId=validateRevisionId(options.revisionId);
    return await readVerifiedInternal(runtimeRoot,revisionId);
  }catch(error){rethrowSafe(error);}
}
