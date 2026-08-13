import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { resolveWorkspace } from './projects.mjs';
import { safeResolve } from './utils.mjs';
import { validateStateConfigReferences } from './validation.mjs';

const DIRECTORY_ACCESS = fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK;
const FILE_ACCESS = fsConstants.R_OK | fsConstants.W_OK;

function isInside(root,target){
  const relative=path.relative(root,target);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`));
}

function isSafeSingleSegment(value){
  return typeof value==='string'&&value.trim()!==''&&value!=='.'&&value!=='..'&&!value.includes('/')&&!value.includes('\\')&&!value.includes('\0');
}

async function inspectPath(target,{type,access}){
  const stat=await fsp.lstat(target);
  if(stat.isSymbolicLink())throw new Error('readiness path is a symbolic link');
  if(type==='directory'&&!stat.isDirectory())throw new Error('readiness path is not a directory');
  if(type==='file'&&!stat.isFile())throw new Error('readiness path is not a regular file');
  await fsp.access(target,access);
  return fsp.realpath(target);
}

export async function inspectReadiness({appRoot,store}){
  const dataRoot=path.resolve(store.dataDir);
  const realDataRoot=await inspectPath(dataRoot,{type:'directory',access:DIRECTORY_ACCESS});
  for(const file of [store.stateFile,store.configFile]){
    const realFile=await inspectPath(file,{type:'file',access:FILE_ACCESS});
    if(!isInside(realDataRoot,realFile))throw new Error('readiness data file escapes data directory');
  }
  const realBackupRoot=await inspectPath(store.backupDir,{type:'directory',access:DIRECTORY_ACCESS});
  if(!isInside(realDataRoot,realBackupRoot))throw new Error('readiness backup directory escapes data directory');

  // JsonStore readers validate both JSON documents without normalizing or writing them.
  const config=await store.readConfig();
  const state=await store.readState();
  validateStateConfigReferences(state,config);

  const workspaceRoot=resolveWorkspace(appRoot,config);
  const realWorkspaceRoot=await inspectPath(workspaceRoot,{type:'directory',access:DIRECTORY_ACCESS});
  const businessDirectories=new Map();
  for(const business of config.businesses){
    const businessPath=safeResolve(workspaceRoot,business.folder);
    if(!isInside(workspaceRoot,businessPath))throw new Error('readiness business path escapes workspace');
    const realBusinessPath=await inspectPath(businessPath,{type:'directory',access:DIRECTORY_ACCESS});
    if(!isInside(realWorkspaceRoot,realBusinessPath))throw new Error('readiness business directory escapes workspace');
    businessDirectories.set(business.id,{businessPath,realBusinessPath});
  }
  for(const project of state.projects){
    if(project.businessId===null||project.businessId===undefined)continue;
    if(!isSafeSingleSegment(project.folder))throw new Error('readiness project folder is not a safe path segment');
    const business=businessDirectories.get(project.businessId);
    if(!business)throw new Error('readiness project business is unavailable');
    const projectDirectory=safeResolve(business.businessPath,project.folder);
    const realProjectDirectory=await inspectPath(projectDirectory,{type:'directory',access:DIRECTORY_ACCESS});
    if(!isInside(realWorkspaceRoot,realProjectDirectory)||!isInside(business.realBusinessPath,realProjectDirectory)){
      throw new Error('readiness project directory escapes its business directory');
    }
  }

  return{config,workspaceRoot};
}
