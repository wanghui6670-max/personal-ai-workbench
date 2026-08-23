import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const TOOLCHAIN_MANIFEST_ALGORITHM='sha256-toolchain-manifest-v1';

const SHA256_RE=/^sha256:[a-f0-9]{64}$/;
const EXACT_VERSION_RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TOKEN_RE=/^[a-z0-9][a-z0-9_-]{0,31}$/;
const COMMAND_ID_RE=/^[a-z][a-z0-9-]{0,63}$/;
const MANIFEST_KEYS=[
  'algorithm',
  'arch',
  'commands',
  'executables',
  'manifestSha256',
  'nodeVersion',
  'npmVersion',
  'platform',
  'schemaVersion'
];
const EXECUTABLES_KEYS=['node','npm'];
const EXECUTABLE_KEYS=['bytes','sha256'];
const COMMAND_KEYS=['argv','id','status'];

function fail(message='Toolchain manifest is invalid.',code='TOOLCHAIN_MANIFEST_INVALID'){
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

function normalizeExecutable(value){
  exactDataObject(value,EXECUTABLE_KEYS);
  if(!Number.isSafeInteger(value.bytes)||value.bytes<0||
    typeof value.sha256!=='string'||!SHA256_RE.test(value.sha256))fail();
  return Object.freeze({bytes:value.bytes,sha256:value.sha256});
}

function safeArgument(value){
  if(typeof value!=='string'||!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value)||
    path.posix.isAbsolute(value)||/^[A-Za-z]:[\\/]/.test(value))fail();
  return value;
}

function normalizeCommands(commands){
  if(!Array.isArray(commands)||commands.length===0||commands.length>32)fail();
  const seen=new Set();
  return commands.map(command=>{
    exactDataObject(command,COMMAND_KEYS);
    if(typeof command.id!=='string'||!COMMAND_ID_RE.test(command.id)||seen.has(command.id)||
      command.status!=='passed'||!Array.isArray(command.argv)||
      command.argv.length===0||command.argv.length>32)fail();
    seen.add(command.id);
    return Object.freeze({
      id:command.id,
      argv:Object.freeze(command.argv.map(safeArgument)),
      status:'passed'
    });
  });
}

function computeManifestHash(value){
  const hash=crypto.createHash('sha256');
  hash.update(`${TOOLCHAIN_MANIFEST_ALGORITHM}\n`,'utf8');
  hash.update(JSON.stringify([
    value.nodeVersion,
    value.npmVersion,
    value.platform,
    value.arch,
    value.executables.node.bytes,
    value.executables.node.sha256,
    value.executables.npm.bytes,
    value.executables.npm.sha256,
    value.commands.map(command=>[command.id,command.argv,command.status])
  ]),'utf8');
  hash.update('\n','utf8');
  return`sha256:${hash.digest('hex')}`;
}

function freezeManifest(value){
  const base={
    schemaVersion:1,
    algorithm:TOOLCHAIN_MANIFEST_ALGORITHM,
    nodeVersion:value.nodeVersion,
    npmVersion:value.npmVersion,
    platform:value.platform,
    arch:value.arch,
    executables:Object.freeze({
      node:value.executables.node,
      npm:value.executables.npm
    }),
    commands:Object.freeze(value.commands)
  };
  return Object.freeze({...base,manifestSha256:computeManifestHash(base)});
}

function normalizeManifestFields({nodeVersion,npmVersion,platform,arch,executables,commands}){
  if(typeof nodeVersion!=='string'||!EXACT_VERSION_RE.test(nodeVersion)||
    typeof npmVersion!=='string'||!EXACT_VERSION_RE.test(npmVersion)||
    typeof platform!=='string'||!TOKEN_RE.test(platform)||
    typeof arch!=='string'||!TOKEN_RE.test(arch))fail();
  exactDataObject(executables,EXECUTABLES_KEYS);
  return{
    nodeVersion,
    npmVersion,
    platform,
    arch,
    executables:{
      node:normalizeExecutable(executables.node),
      npm:normalizeExecutable(executables.npm)
    },
    commands:normalizeCommands(commands)
  };
}

export function validateToolchainManifest(value){
  exactDataObject(value,MANIFEST_KEYS);
  if(value.schemaVersion!==1||value.algorithm!==TOOLCHAIN_MANIFEST_ALGORITHM||
    typeof value.manifestSha256!=='string'||!SHA256_RE.test(value.manifestSha256))fail();
  const normalized=normalizeManifestFields(value);
  const manifest=freezeManifest(normalized);
  if(manifest.manifestSha256!==value.manifestSha256)fail();
  return manifest;
}

function sameSnapshot(left,right){
  return left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&
    left.nlink===right.nlink&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&
    left.ctimeNs===right.ctimeNs;
}

async function hashExecutable(target){
  if(typeof target!=='string'||!path.isAbsolute(target)||target.includes('\0')){
    fail('Toolchain executable path is invalid.','TOOLCHAIN_EXECUTABLE_INVALID');
  }
  let physical;
  try{physical=await fsp.realpath(target);}catch{
    fail('Toolchain executable is unavailable.','TOOLCHAIN_EXECUTABLE_INVALID');
  }
  let initial;
  try{initial=await fsp.lstat(physical,{bigint:true});}catch{
    fail('Toolchain executable is unavailable.','TOOLCHAIN_EXECUTABLE_INVALID');
  }
  if(initial.isSymbolicLink()||!initial.isFile()||initial.nlink!==1n||
    Number(initial.mode&0o7000n)!==0){
    fail('Toolchain executable is unsafe.','TOOLCHAIN_EXECUTABLE_INVALID');
  }
  if(typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0){
    fail('Safe toolchain reads are unavailable.','TOOLCHAIN_EXECUTABLE_INVALID');
  }
  let handle;
  try{handle=await fsp.open(physical,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{
    fail('Toolchain executable could not be read.','TOOLCHAIN_EXECUTABLE_INVALID');
  }
  try{
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||!sameSnapshot(initial,opened)){
      fail('Toolchain executable changed while it was read.','TOOLCHAIN_EXECUTABLE_CHANGED');
    }
    const buffer=await handle.readFile();
    const after=await handle.stat({bigint:true});
    const pathAfter=await fsp.lstat(physical,{bigint:true});
    if(!sameSnapshot(opened,after)||pathAfter.isSymbolicLink()||!pathAfter.isFile()||
      !sameSnapshot(after,pathAfter)){
      fail('Toolchain executable changed while it was read.','TOOLCHAIN_EXECUTABLE_CHANGED');
    }
    return Object.freeze({
      bytes:buffer.byteLength,
      sha256:`sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`
    });
  }finally{
    try{await handle.close();}catch{}
  }
}

export async function createToolchainManifest({
  nodeExecutable,
  npmExecutable,
  nodeVersion,
  npmVersion,
  platform,
  arch,
  commands
}={}){
  const normalizedCommands=normalizeCommands(commands);
  if(typeof nodeVersion!=='string'||!EXACT_VERSION_RE.test(nodeVersion)||
    typeof npmVersion!=='string'||!EXACT_VERSION_RE.test(npmVersion)||
    typeof platform!=='string'||!TOKEN_RE.test(platform)||
    typeof arch!=='string'||!TOKEN_RE.test(arch))fail();
  const [node,npm]=await Promise.all([
    hashExecutable(nodeExecutable),
    hashExecutable(npmExecutable)
  ]);
  return freezeManifest({
    nodeVersion,
    npmVersion,
    platform,
    arch,
    executables:{node,npm},
    commands:normalizedCommands
  });
}

export async function verifyToolchainManifest(options,manifest){
  const expected=validateToolchainManifest(manifest);
  let actual;
  try{
    actual=await createToolchainManifest({
      ...options,
      commands:expected.commands
    });
  }catch(error){
    if(error?.code?.startsWith?.('TOOLCHAIN_')){
      fail('Toolchain does not match its manifest.','TOOLCHAIN_MANIFEST_MISMATCH');
    }
    throw error;
  }
  if(JSON.stringify(actual)!==JSON.stringify(expected)){
    fail('Toolchain does not match its manifest.','TOOLCHAIN_MANIFEST_MISMATCH');
  }
  return expected;
}
