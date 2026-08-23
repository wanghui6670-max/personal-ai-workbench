import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {loadVerifiedStaticAssets,validateStaticAssetManifest} from './build-identity.mjs';
import {validateReleaseCandidate} from './release-artifact.mjs';
import {
  prepareReleaseSourceArtifact,
  promoteReleaseDirectoryAtomically,
  synchronizeReleaseDirectory
} from './release-preparation.mjs';
import {validateReleaseContract} from './release-contract.mjs';
import {createReleaseIdentity,validateReleaseIdentity} from './release-identity.mjs';
import {
  createRuntimeManifest,
  synchronizeRuntimeManifest,
  validateRuntimeManifest,
  verifyRuntimeManifest
} from './runtime-manifest.mjs';
import {
  createToolchainManifest,
  validateToolchainManifest,
  verifyToolchainManifest
} from './toolchain-manifest.mjs';

const execFileAsync=promisify(execFile);
const METADATA_FILES=[
  'release-contract.json',
  'release-identity.json',
  'runtime-manifest.json',
  'source-manifest.json',
  'static-manifest.json',
  'toolchain-manifest.json'
];
const ALLOWED_RUNTIME_ROOTS=new Set(['node_modules','harness/node_modules']);

function fail(message,code,stage='build',extra={}){
  throw Object.assign(new Error(message),{code,stage,retryable:false,...extra});
}

function requiredPath(value,code){
  if(typeof value!=='string'||!value.trim()||value.includes('\0')){
    fail('Release builder path is invalid.',code);
  }
  return path.resolve(value);
}

async function requireRealDirectory(directory,code){
  let stat;
  try{stat=await fsp.lstat(directory);}catch{fail('Release builder directory is unavailable.',code);}
  if(stat.isSymbolicLink()||!stat.isDirectory())fail('Release builder requires a real directory.',code);
  return fsp.realpath(directory);
}

function digest(buffer){
  return`sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function serializedJson(value){
  return Buffer.from(`${JSON.stringify(value,null,2)}\n`,'utf8');
}

async function writeSyncedJson(directory,name,value){
  const target=path.join(directory,name);
  const bytes=serializedJson(value);
  let handle;
  try{handle=await fsp.open(target,'wx',0o644);}catch{
    fail('Release metadata could not be created.','RELEASE_METADATA_WRITE_FAILED','finalize');
  }
  try{
    const result=await handle.write(bytes,0,bytes.byteLength,0);
    if(result.bytesWritten!==bytes.byteLength){
      fail('Release metadata write was incomplete.','RELEASE_METADATA_WRITE_FAILED','finalize');
    }
    await handle.sync();
  }catch(error){
    if(error?.code?.startsWith?.('RELEASE_'))throw error;
    fail('Release metadata could not be made durable.','RELEASE_METADATA_WRITE_FAILED','finalize');
  }finally{
    try{await handle.close();}catch{}
  }
  return digest(bytes);
}

async function digestExistingJson(directory,name,value){
  let bytes;
  try{bytes=await fsp.readFile(path.join(directory,name));}catch{
    fail('Prepared release metadata is unavailable.','RELEASE_METADATA_MISMATCH','verify');
  }
  if(!bytes.equals(serializedJson(value))){
    fail('Prepared release metadata changed before finalization.','RELEASE_METADATA_MISMATCH','verify');
  }
  return digest(bytes);
}

function expectedDirectories(files){
  const directories=new Set();
  for(const file of files){
    const segments=file.path.split('/').slice(0,-1);
    for(let index=1;index<=segments.length;index++)directories.add(segments.slice(0,index).join('/'));
  }
  return [...directories].sort();
}

function sameSnapshot(left,right){
  return left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&
    left.nlink===right.nlink&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&
    left.ctimeNs===right.ctimeNs;
}

async function readSourceFile(target,relative){
  let initial;
  try{initial=await fsp.lstat(target,{bigint:true});}catch{
    fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
  }
  if(initial.isSymbolicLink()||!initial.isFile()||initial.nlink!==1n||
    typeof fsConstants.O_NOFOLLOW!=='number'||fsConstants.O_NOFOLLOW===0){
    fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
  }
  let handle;
  try{handle=await fsp.open(target,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{
    fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
  }
  try{
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||!sameSnapshot(initial,opened)){
      fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
    }
    const buffer=await handle.readFile();
    const after=await handle.stat({bigint:true});
    const pathAfter=await fsp.lstat(target,{bigint:true});
    if(!sameSnapshot(opened,after)||pathAfter.isSymbolicLink()||!pathAfter.isFile()||
      !sameSnapshot(after,pathAfter)){
      fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
    }
    return{
      path:relative,
      bytes:buffer.byteLength,
      sha256:digest(buffer),
      executable:Number(after.mode&0o111n)!==0
    };
  }finally{
    try{await handle.close();}catch{}
  }
}

async function verifyPostBuildSource(appRoot,sourceManifest){
  const source=validateReleaseCandidate(sourceManifest);
  if(source.sourceTree.files.some(file=>
    file.path==='node_modules'||file.path.startsWith('node_modules/')||
    file.path==='harness/node_modules'||file.path.startsWith('harness/node_modules/')
  ))fail('Candidate source uses a reserved runtime path.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
  const files=[];
  const directories=[];

  async function walk(directory,segments){
    let before;
    try{before=await fsp.lstat(directory,{bigint:true});}catch{
      fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
    }
    if(before.isSymbolicLink()||!before.isDirectory()){
      fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
    }
    const entries=await fsp.readdir(directory,{withFileTypes:true});
    entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
    for(const entry of entries){
      const next=[...segments,entry.name];
      const relative=next.join('/');
      const target=path.join(directory,entry.name);
      const stat=await fsp.lstat(target,{bigint:true});
      if(stat.isDirectory()){
        if(ALLOWED_RUNTIME_ROOTS.has(relative))continue;
        if(stat.isSymbolicLink()){
          fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
        }
        directories.push(relative);
        await walk(target,next);
        continue;
      }
      if(stat.isSymbolicLink()||!stat.isFile()){
        fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
      }
      files.push(await readSourceFile(target,relative));
    }
    const after=await fsp.lstat(directory,{bigint:true});
    if(after.isSymbolicLink()||!after.isDirectory()||before.dev!==after.dev||before.ino!==after.ino){
      fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
    }
  }

  await walk(appRoot,[]);
  files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  directories.sort();
  const expected=source.sourceTree.files;
  const wantedDirectories=expectedDirectories(expected);
  if(files.length!==expected.length||directories.length!==wantedDirectories.length||
    directories.some((directory,index)=>directory!==wantedDirectories[index])){
    fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
  }
  for(let index=0;index<expected.length;index++){
    const wanted=expected[index];
    const actual=files[index];
    if(!actual||actual.path!==wanted.path||actual.bytes!==wanted.bytes||
      actual.sha256!==wanted.sha256||actual.executable!==(wanted.gitMode==='100755')){
      fail('Candidate source changed during build.','RELEASE_SOURCE_POST_BUILD_MISMATCH','verify');
    }
  }
  return source;
}

function commandContract(npmExecutable,appRoot){
  return[
    {
      id:'root-install',
      file:npmExecutable,
      args:['ci','--ignore-scripts','--no-audit','--no-fund'],
      argv:['npm','ci','--ignore-scripts','--no-audit','--no-fund'],
      cwd:appRoot
    },
    {
      id:'harness-install',
      file:npmExecutable,
      args:['ci','--prefix','harness','--ignore-scripts','--no-audit','--no-fund'],
      argv:['npm','ci','--prefix','harness','--ignore-scripts','--no-audit','--no-fund'],
      cwd:appRoot
    },
    {id:'root-tests',file:npmExecutable,args:['test'],argv:['npm','test'],cwd:appRoot},
    {id:'full-verify',file:npmExecutable,args:['run','verify'],argv:['npm','run','verify'],cwd:appRoot}
  ];
}

function commandEnvironment({nodeExecutable,npmExecutable}){
  const pathValue=[
    path.dirname(nodeExecutable),
    path.dirname(npmExecutable),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].filter((value,index,values)=>values.indexOf(value)===index).join(path.delimiter);
  return{
    PATH:pathValue,
    HOME:process.env.HOME||os.homedir(),
    TMPDIR:process.env.TMPDIR||os.tmpdir(),
    LC_ALL:'C',
    CI:'1',
    NO_COLOR:'1',
    OPENAI_API_KEY:'',
    AI_PROVIDER_ENABLED:'0',
    HARNESS_ENABLED:'0',
    JOYCREW_ENABLED:'0'
  };
}

async function defaultRunBuildCommand(command){
  await execFileAsync(command.file,command.args,{
    cwd:command.cwd,
    env:command.env,
    encoding:'utf8',
    maxBuffer:32*1024*1024,
    windowsHide:true
  });
}

async function runBuildCommands({appRoot,nodeExecutable,npmExecutable,runBuildCommand}){
  const env=commandEnvironment({nodeExecutable,npmExecutable});
  const commands=commandContract(npmExecutable,appRoot);
  for(const command of commands){
    try{
      await runBuildCommand(Object.freeze({...command,appRoot,env}));
    }catch(error){
      const causeCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)
        ?error.code
        :'COMMAND_FAILED';
      fail('A required release build command failed.','RELEASE_BUILD_COMMAND_FAILED','build',{
        causeCode,
        commandId:command.id
      });
    }
  }
  return Object.freeze(commands.map(command=>Object.freeze({
    id:command.id,
    argv:Object.freeze([...command.argv]),
    status:'passed'
  })));
}

function intermediateName(options){
  const hash=crypto.createHash('sha256').update(JSON.stringify([
    options.candidateCommit,
    options.builtAt,
    options.nodeVersion,
    options.npmVersion,
    options.platform,
    options.arch
  ])).digest('hex').slice(0,32);
  return`.release-build-${hash}`;
}

async function pathExists(target){
  try{await fsp.lstat(target);return true;}catch(error){
    if(error?.code==='ENOENT')return false;
    throw error;
  }
}

async function readMetadata(directory,name){
  let buffer;
  try{buffer=await fsp.readFile(path.join(directory,name));}catch{
    fail('Release metadata is unavailable.','RELEASE_METADATA_MISMATCH','verify');
  }
  let value;
  try{value=JSON.parse(buffer.toString('utf8'));}catch{
    fail('Release metadata is invalid.','RELEASE_METADATA_MISMATCH','verify');
  }
  return{buffer,value};
}

async function verifyFinalizedRelease(releaseRoot,options,{requireIdentityName=false}={}){
  const root=await requireRealDirectory(releaseRoot,'RELEASE_FINAL_ARTIFACT_INVALID');
  const appRoot=path.join(root,'app');
  const metadataRoot=path.join(root,'metadata');
  await requireRealDirectory(appRoot,'RELEASE_FINAL_ARTIFACT_INVALID');
  await requireRealDirectory(metadataRoot,'RELEASE_FINAL_ARTIFACT_INVALID');
  const names=(await fsp.readdir(metadataRoot)).sort();
  if(names.length!==METADATA_FILES.length||names.some((name,index)=>name!==METADATA_FILES[index])){
    fail('Release metadata set is invalid.','RELEASE_METADATA_MISMATCH','verify');
  }
  const records=Object.fromEntries(await Promise.all(METADATA_FILES.map(async name=>[
    name,
    await readMetadata(metadataRoot,name)
  ])));
  const sourceManifest=validateReleaseCandidate(records['source-manifest.json'].value);
  const releaseContract=await validateReleaseContract(records['release-contract.json'].value,{
    projectRoot:appRoot,
    nodeVersion:options.nodeVersion,
    npmVersion:options.npmVersion
  });
  const staticManifest=validateStaticAssetManifest(records['static-manifest.json'].value);
  const runtimeManifest=validateRuntimeManifest(records['runtime-manifest.json'].value);
  const toolchainManifest=validateToolchainManifest(records['toolchain-manifest.json'].value);
  const releaseIdentity=validateReleaseIdentity(records['release-identity.json'].value);
  const manifests={
    source:digest(records['source-manifest.json'].buffer),
    contract:digest(records['release-contract.json'].buffer),
    static:digest(records['static-manifest.json'].buffer),
    runtime:digest(records['runtime-manifest.json'].buffer),
    toolchain:digest(records['toolchain-manifest.json'].buffer)
  };
  const expectedIdentity=createReleaseIdentity({
    productVersion:releaseContract.productVersion,
    candidateCommit:sourceManifest.candidateCommit,
    builtAt:staticManifest.builtAt,
    nodeVersion:releaseContract.nodeVersion,
    npmVersion:releaseContract.npmVersion,
    manifests
  });
  if(JSON.stringify(expectedIdentity)!==JSON.stringify(releaseIdentity)||
    sourceManifest.candidateCommit!==options.candidateCommit||
    runtimeManifest.candidateCommit!==options.candidateCommit||
    releaseIdentity.builtAt!==options.builtAt||
    toolchainManifest.platform!==options.platform||toolchainManifest.arch!==options.arch||
    runtimeManifest.platform!==options.platform||runtimeManifest.arch!==options.arch||
    (requireIdentityName&&path.basename(root)!==releaseIdentity.releaseId)){
    fail('Release identities do not agree.','RELEASE_IDENTITY_MISMATCH','verify');
  }
  await verifyPostBuildSource(appRoot,sourceManifest);
  await loadVerifiedStaticAssets(path.join(appRoot,'public'),staticManifest);
  await verifyRuntimeManifest(appRoot,runtimeManifest);
  await verifyToolchainManifest({
    nodeExecutable:options.nodeExecutable,
    npmExecutable:options.npmExecutable,
    nodeVersion:options.nodeVersion,
    npmVersion:options.npmVersion,
    platform:options.platform,
    arch:options.arch
  },toolchainManifest);
  return Object.freeze({
    artifactPath:root,
    releaseId:releaseIdentity.releaseId,
    releaseIdentity,
    sourceManifest,
    releaseContract,
    staticManifest,
    runtimeManifest,
    toolchainManifest
  });
}

async function discardIntermediate(intermediate,releasesRoot){
  await fsp.rm(intermediate,{recursive:true,force:true});
  await synchronizeReleaseDirectory(releasesRoot);
}

async function promoteOrReuse(intermediate,finalized,options){
  const destination=path.join(options.releasesRoot,finalized.releaseId);
  try{
    await options.promoteFinal({source:intermediate,destination});
  }catch(error){
    if(error?.code!=='RELEASE_OUTPUT_EXISTS'){
      if(error?.code?.startsWith?.('RELEASE_'))throw error;
      const causeCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)
        ?error.code
        :'PROMOTION_FAILED';
      fail('Final release promotion failed.','RELEASE_FINAL_PROMOTION_FAILED','promote',{causeCode});
    }
    let existing;
    try{
      existing=await verifyFinalizedRelease(destination,options,{requireIdentityName:true});
    }catch{
      fail('Release ID collides with a different or invalid artifact.','RELEASE_ID_COLLISION','promote');
    }
    if(existing.releaseId!==finalized.releaseId){
      fail('Release ID collides with a different artifact.','RELEASE_ID_COLLISION','promote');
    }
    await discardIntermediate(intermediate,options.releasesRoot);
    return Object.freeze({...existing,reused:true});
  }
  const verified=await verifyFinalizedRelease(destination,options,{requireIdentityName:true});
  return Object.freeze({...verified,reused:false});
}

export async function buildReleaseArtifact({
  repositoryRoot,
  candidateCommit,
  releasesRoot,
  builtAt,
  nodeExecutable,
  npmExecutable,
  nodeVersion,
  npmVersion,
  platform,
  arch
}={},dependencies={}){
  const runBuildCommand=dependencies.runBuildCommand||defaultRunBuildCommand;
  const promoteFinal=dependencies.promoteFinal||promoteReleaseDirectoryAtomically;
  if(typeof runBuildCommand!=='function'){
    fail('Release build command runner is invalid.','RELEASE_BUILD_RUNNER_INVALID');
  }
  if(typeof promoteFinal!=='function'){
    fail('Final release promoter is invalid.','RELEASE_FINAL_PROMOTER_INVALID');
  }
  const repository=requiredPath(repositoryRoot,'RELEASE_REPOSITORY_ROOT_INVALID');
  const releaseDirectory=requiredPath(releasesRoot,'RELEASES_ROOT_INVALID');
  const nodePath=requiredPath(nodeExecutable,'RELEASE_NODE_EXECUTABLE_INVALID');
  const npmPath=requiredPath(npmExecutable,'RELEASE_NPM_EXECUTABLE_INVALID');
  const physicalReleasesRoot=await requireRealDirectory(releaseDirectory,'RELEASES_ROOT_INVALID');
  const options={
    repositoryRoot:repository,
    candidateCommit,
    releasesRoot:physicalReleasesRoot,
    builtAt,
    nodeExecutable:nodePath,
    npmExecutable:npmPath,
    nodeVersion,
    npmVersion,
    platform,
    arch,
    promoteFinal
  };
  const intermediate=path.join(physicalReleasesRoot,intermediateName(options));

  if(await pathExists(intermediate)){
    try{
      const recovered=await verifyFinalizedRelease(intermediate,options);
      return promoteOrReuse(intermediate,recovered,options);
    }catch{
      await discardIntermediate(intermediate,physicalReleasesRoot);
    }
  }

  let finalized=null;
  await prepareReleaseSourceArtifact({
    repositoryRoot:repository,
    candidateCommit,
    destinationRoot:intermediate,
    builtAt,
    nodeVersion,
    npmVersion
  },{
    beforePromotion:async ({staging,appRoot,metadataRoot,sourceManifest,releaseContract,staticManifest})=>{
      const commands=await runBuildCommands({
        appRoot,
        nodeExecutable:nodePath,
        npmExecutable:npmPath,
        runBuildCommand
      });
      await verifyPostBuildSource(appRoot,sourceManifest);
      await validateReleaseContract(releaseContract,{
        projectRoot:appRoot,
        nodeVersion,
        npmVersion
      });
      await loadVerifiedStaticAssets(path.join(appRoot,'public'),staticManifest);
      const toolchainManifest=await createToolchainManifest({
        nodeExecutable:nodePath,
        npmExecutable:npmPath,
        nodeVersion,
        npmVersion,
        platform,
        arch,
        commands
      });
      const runtimeManifest=await createRuntimeManifest(appRoot,{
        candidateCommit,
        platform,
        arch
      });
      const manifests={
        source:await digestExistingJson(metadataRoot,'source-manifest.json',sourceManifest),
        contract:await digestExistingJson(metadataRoot,'release-contract.json',releaseContract),
        static:await digestExistingJson(metadataRoot,'static-manifest.json',staticManifest),
        runtime:await writeSyncedJson(metadataRoot,'runtime-manifest.json',runtimeManifest),
        toolchain:await writeSyncedJson(metadataRoot,'toolchain-manifest.json',toolchainManifest)
      };
      const releaseIdentity=createReleaseIdentity({
        productVersion:releaseContract.productVersion,
        candidateCommit,
        builtAt,
        nodeVersion,
        npmVersion,
        manifests
      });
      await writeSyncedJson(metadataRoot,'release-identity.json',releaseIdentity);
      await synchronizeRuntimeManifest(appRoot,runtimeManifest);
      await synchronizeReleaseDirectory(metadataRoot);
      await synchronizeReleaseDirectory(staging);
      await verifyPostBuildSource(appRoot,sourceManifest);
      await loadVerifiedStaticAssets(path.join(appRoot,'public'),staticManifest);
      await verifyRuntimeManifest(appRoot,runtimeManifest);
      await verifyToolchainManifest({
        nodeExecutable:nodePath,
        npmExecutable:npmPath,
        nodeVersion,
        npmVersion,
        platform,
        arch
      },toolchainManifest);
      finalized=Object.freeze({
        releaseId:releaseIdentity.releaseId,
        releaseIdentity,
        sourceManifest,
        releaseContract,
        staticManifest,
        runtimeManifest,
        toolchainManifest
      });
    }
  });
  if(!finalized)fail('Release staging was not finalized.','RELEASE_FINALIZATION_MISSING','finalize');
  return promoteOrReuse(intermediate,finalized,options);
}
