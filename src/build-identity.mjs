import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const ASSET_HASH_ALGORITHM='sha256-canonical-assets-v1';

const COMMIT_RE=/^[a-f0-9]{40}$/;
const SHA256_RE=/^sha256:[a-f0-9]{64}$/;
const BUILT_AT_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SEMVER_RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message,code='INVALID_BUILD_MANIFEST'){
  throw Object.assign(new Error(message),{code});
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function requireExactKeys(value,expected,label){
  if(!isPlainObject(value))fail(`${label} must be an object.`);
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index])){
    fail(`${label} contains missing or unsupported fields.`);
  }
}

function validBuiltAt(value){
  if(typeof value!=='string'||!BUILT_AT_RE.test(value))return false;
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime()))return false;
  const canonical=parsed.toISOString();
  return value===canonical||(canonical.endsWith('.000Z')&&value===canonical.replace('.000Z','Z'));
}

export function validateBuildIdentity(value){
  requireExactKeys(value,['schemaVersion','productVersion','commit','builtAt'],'Build identity');
  if(value.schemaVersion!==1)fail('Invalid schemaVersion in build identity.');
  if(typeof value.productVersion!=='string'||!SEMVER_RE.test(value.productVersion)){
    fail('Invalid productVersion in build identity.');
  }
  if(typeof value.commit!=='string'||!COMMIT_RE.test(value.commit)){
    fail('Invalid commit in build identity.');
  }
  if(!validBuiltAt(value.builtAt))fail('Invalid builtAt in build identity.');
  return Object.freeze({
    schemaVersion:1,
    productVersion:value.productVersion,
    commit:value.commit,
    builtAt:value.builtAt
  });
}

function validateAssetPath(value){
  if(typeof value!=='string'||value.length===0||value.includes('\0'))fail('Invalid asset path.');
  if(value.includes('\\')||path.posix.isAbsolute(value)||/^[A-Za-z]:\//.test(value)){
    fail('Invalid asset path: paths must be POSIX relative paths.');
  }
  const segments=value.split('/');
  if(segments.some(segment=>segment===''||segment==='.'||segment==='..')||path.posix.normalize(value)!==value){
    fail('Invalid asset path: path traversal and non-canonical paths are forbidden.');
  }
  return value;
}

function validateAssetRecord(value){
  requireExactKeys(value,['path','bytes','sha256'],'Asset');
  const assetPath=validateAssetPath(value.path);
  if(!Number.isSafeInteger(value.bytes)||value.bytes<0)fail(`Invalid bytes for asset path ${assetPath}.`);
  if(typeof value.sha256!=='string'||!SHA256_RE.test(value.sha256)){
    fail(`Invalid sha256 for asset path ${assetPath}.`);
  }
  return Object.freeze({path:assetPath,bytes:value.bytes,sha256:value.sha256});
}

function canonicalAssets(assets){
  if(!Array.isArray(assets))fail('Assets must be an array.');
  const normalized=assets.map(validateAssetRecord);
  const seen=new Set();
  for(const asset of normalized){
    if(seen.has(asset.path))fail(`Duplicate asset path: ${asset.path}.`);
    seen.add(asset.path);
  }
  return normalized.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
}

function canonicalAssetPaths(assetPaths){
  if(!Array.isArray(assetPaths))fail('Asset paths must be an array.');
  const normalized=assetPaths.map(validateAssetPath);
  const seen=new Set();
  for(const assetPath of normalized){
    if(seen.has(assetPath))fail(`Duplicate asset path: ${assetPath}.`,'ASSET_DUPLICATE');
    seen.add(assetPath);
  }
  return normalized.sort();
}

export function computeCanonicalAssetsHash(assets){
  const normalized=canonicalAssets(assets);
  const hash=crypto.createHash('sha256');
  hash.update(`${ASSET_HASH_ALGORITHM}\n`,'utf8');
  for(const asset of normalized){
    hash.update(JSON.stringify([asset.path,asset.bytes,asset.sha256]),'utf8');
    hash.update('\n','utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function requirePublicRoot(publicRoot){
  if(typeof publicRoot!=='string'||publicRoot.trim()==='')fail('Public root is required.','INVALID_PUBLIC_ROOT');
  const resolved=path.resolve(publicRoot);
  let stat;
  try{stat=await fsp.lstat(resolved);}catch(error){
    if(error?.code==='ENOENT')fail('Public root is missing.','PUBLIC_ROOT_MISSING');
    throw error;
  }
  if(stat.isSymbolicLink())fail('Public root must not be a symbolic link (symlink).','ASSET_SYMLINK');
  if(!stat.isDirectory())fail('Public root must be a directory.','INVALID_PUBLIC_ROOT');
  return resolved;
}

export async function enumerateStaticAssetFiles(publicRoot){
  const root=await requirePublicRoot(publicRoot);
  const files=[];
  const seen=new Set();

  async function walk(directory,segments){
    const entries=await fsp.readdir(directory,{withFileTypes:true});
    entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
    for(const entry of entries){
      const nextSegments=[...segments,entry.name];
      const relative=validateAssetPath(nextSegments.join('/'));
      const target=path.join(directory,entry.name);
      const stat=await fsp.lstat(target);
      if(stat.isSymbolicLink()){
        fail(`Static asset tree contains a symbolic link (symlink): ${relative}.`,'ASSET_SYMLINK');
      }
      if(stat.isDirectory()){
        await walk(target,nextSegments);
        continue;
      }
      if(!stat.isFile())fail(`Static asset is not a regular file: ${relative}.`,'ASSET_NOT_REGULAR');
      if(seen.has(relative))fail(`Duplicate asset path: ${relative}.`,'ASSET_DUPLICATE');
      seen.add(relative);
      files.push(relative);
    }
  }

  await walk(root,[]);
  files.sort();
  return Object.freeze(files);
}

async function readRegularFile(filePath,assetLabel=path.basename(filePath)){
  let initial;
  try{initial=await fsp.lstat(filePath);}catch(error){
    if(error?.code==='ENOENT')fail(`Static asset is missing: ${assetLabel}.`,'ASSET_MISSING');
    throw error;
  }
  if(initial.isSymbolicLink())fail(`Static asset must not be a symbolic link (symlink): ${assetLabel}.`,'ASSET_SYMLINK');
  if(!initial.isFile())fail(`Static asset is not a regular file: ${assetLabel}.`,'ASSET_NOT_REGULAR');

  const noFollow=fsConstants.O_NOFOLLOW??0;
  let handle;
  try{handle=await fsp.open(filePath,fsConstants.O_RDONLY|noFollow);}catch(error){
    if(error?.code==='ELOOP')fail(`Static asset must not be a symbolic link (symlink): ${assetLabel}.`,'ASSET_SYMLINK');
    if(error?.code==='ENOENT')fail(`Static asset is missing: ${assetLabel}.`,'ASSET_MISSING');
    throw error;
  }
  try{
    const before=await handle.stat();
    if(!before.isFile())fail(`Static asset is not a regular file: ${assetLabel}.`,'ASSET_NOT_REGULAR');
    const buffer=await handle.readFile();
    const after=await handle.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs){
      fail(`Static asset changed while it was being read: ${assetLabel}.`,'ASSET_CHANGED_DURING_READ');
    }
    return buffer;
  }finally{
    await handle.close();
  }
}

function digestBuffer(buffer){
  return{
    bytes:buffer.byteLength,
    sha256:`sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
  };
}

export async function hashFile(filePath){
  const buffer=await readRegularFile(filePath);
  return Object.freeze(digestBuffer(buffer));
}

function assertSamePaths(expected,actual){
  const expectedSet=new Set(expected);
  const actualSet=new Set(actual);
  const missing=expected.filter(assetPath=>!actualSet.has(assetPath));
  const extra=actual.filter(assetPath=>!expectedSet.has(assetPath));
  if(missing.length)fail(`Static asset manifest has missing files: ${missing.join(', ')}.`,'ASSET_MISSING');
  if(extra.length)fail(`Static asset manifest has extra files: ${extra.join(', ')}.`,'ASSET_EXTRA');
}

export function validateStaticAssetManifest(value){
  requireExactKeys(
    value,
    ['schemaVersion','productVersion','commit','builtAt','staticAssets'],
    'Static asset manifest'
  );
  const identity=validateBuildIdentity({
    schemaVersion:value.schemaVersion,
    productVersion:value.productVersion,
    commit:value.commit,
    builtAt:value.builtAt
  });
  requireExactKeys(
    value.staticAssets,
    ['algorithm','manifestSha256','assetCount','assets'],
    'staticAssets'
  );
  if(value.staticAssets.algorithm!==ASSET_HASH_ALGORITHM)fail('Invalid static asset algorithm.');
  if(!Array.isArray(value.staticAssets.assets))fail('Invalid static asset assets list.');
  if(!Number.isSafeInteger(value.staticAssets.assetCount)||value.staticAssets.assetCount<0||
    value.staticAssets.assetCount!==value.staticAssets.assets.length){
    fail('Invalid static asset assetCount.');
  }
  const assets=canonicalAssets(value.staticAssets.assets);
  for(let index=0;index<assets.length;index++){
    if(assets[index].path!==value.staticAssets.assets[index].path){
      fail('Static asset paths must use canonical POSIX sort order.');
    }
  }
  if(typeof value.staticAssets.manifestSha256!=='string'||!SHA256_RE.test(value.staticAssets.manifestSha256)){
    fail('Invalid static asset manifestSha256.');
  }
  const expectedHash=computeCanonicalAssetsHash(assets);
  if(value.staticAssets.manifestSha256!==expectedHash)fail('Invalid static asset manifestSha256: aggregate does not match assets.');

  const staticAssets=Object.freeze({
    algorithm:ASSET_HASH_ALGORITHM,
    manifestSha256:value.staticAssets.manifestSha256,
    assetCount:assets.length,
    assets:Object.freeze(assets)
  });
  return Object.freeze({...identity,staticAssets});
}

export async function createStaticAssetManifest(publicRoot,buildIdentity,{assetPaths}={}){
  const identity=validateBuildIdentity(buildIdentity);
  const root=await requirePublicRoot(publicRoot);
  const paths=assetPaths===undefined
    ?await enumerateStaticAssetFiles(root)
    :canonicalAssetPaths(assetPaths);
  const assets=[];
  for(const assetPath of paths){
    const buffer=await readRegularFile(path.join(root,...assetPath.split('/')),assetPath);
    assets.push(Object.freeze({path:assetPath,...digestBuffer(buffer)}));
  }
  const staticAssets=Object.freeze({
    algorithm:ASSET_HASH_ALGORITHM,
    manifestSha256:computeCanonicalAssetsHash(assets),
    assetCount:assets.length,
    assets:Object.freeze(assets)
  });
  return Object.freeze({...identity,staticAssets});
}

export async function loadVerifiedStaticAssets(publicRoot,manifest){
  const verified=validateStaticAssetManifest(manifest);
  const root=await requirePublicRoot(publicRoot);
  const expected=verified.staticAssets.assets.map(asset=>asset.path);
  const actual=await enumerateStaticAssetFiles(root);
  assertSamePaths(expected,actual);

  const loaded=new Map();
  for(const asset of verified.staticAssets.assets){
    const buffer=await readRegularFile(path.join(root,...asset.path.split('/')),asset.path);
    const digest=digestBuffer(buffer);
    if(digest.bytes!==asset.bytes){
      fail(`Static asset bytes changed for ${asset.path}.`,'ASSET_BYTES_MISMATCH');
    }
    if(digest.sha256!==asset.sha256){
      fail(`Static asset sha256 changed for ${asset.path}.`,'ASSET_SHA256_MISMATCH');
    }
    loaded.set(asset.path,buffer);
  }

  assertSamePaths(expected,await enumerateStaticAssetFiles(root));
  return loaded;
}
