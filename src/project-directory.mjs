import fsp from 'node:fs/promises';
import path from 'node:path';
import { prepareBusinessDirs, projectPath, businessById } from './projects.mjs';
import { rewriteProjectIdentity, projectIdentityBlock } from './project-identity.mjs';

const SUBDIRECTORIES=['01_原始资料','02_工作过程','03_最终交付','99_归档'];

function sameEntry(left,right){return left&&right&&left.dev===right.dev&&left.ino===right.ino;}

async function lstatOrNull(target){
  try{return await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function assertSafeDirectory(target,label){
  const stat=await fsp.lstat(target);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`${label}不是安全目录。`);
  return stat;
}

async function removeCreatedProject({dir,dirStat,projectMdContent,subStats}){
  const failures=[];
  try{
    const current=await lstatOrNull(path.join(dir,'PROJECT.md'));
    if(current){
      if(current.isSymbolicLink()||!current.isFile()||current.nlink>1)failures.push('PROJECT.md 已发生不安全变化');
      else{
        const content=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
        if(content!==projectMdContent)failures.push('PROJECT.md 已被修改');
        else await fsp.unlink(path.join(dir,'PROJECT.md'));
      }
    }
  }catch(error){failures.push(`PROJECT.md: ${error.message}`);}
  for(const sub of [...SUBDIRECTORIES].reverse()){
    const target=path.join(dir,sub);
    try{
      const current=await lstatOrNull(target);
      if(!current)continue;
      const original=subStats.get(sub);
      if(current.isSymbolicLink()||!current.isDirectory()||!sameEntry(current,original))failures.push(`${sub} 已发生变化`);
      else await fsp.rmdir(target);
    }catch(error){failures.push(`${sub}: ${error.message}`);}
  }
  try{
    const current=await lstatOrNull(dir);
    if(current){
      if(current.isSymbolicLink()||!current.isDirectory()||!sameEntry(current,dirStat))failures.push('项目目录已发生变化');
      else await fsp.rmdir(dir);
    }
  }catch(error){failures.push(`项目目录: ${error.message}`);}
  if(failures.length)throw new Error(`无法完整回滚新项目目录（${failures.join('；')}）`);
}

export async function prepareIdentityProjectDir(appRoot,config,project,{businessName=null}={}){
  const business=businessById(config,project.businessId);
  if(!business)throw new Error('业务板块不存在。');
  const businessStage=await prepareBusinessDirs(appRoot,config);
  const dir=projectPath(appRoot,config,project);
  let created=false;
  let dirStat=null;
  const subStats=new Map();
  try{
    const existing=await lstatOrNull(dir);
    if(existing)throw new Error('项目目录已存在，已拒绝覆盖。');
    await fsp.mkdir(dir);
    created=true;
    dirStat=await assertSafeDirectory(dir,'项目目录');
    for(const sub of SUBDIRECTORIES){
      const target=path.join(dir,sub);
      await fsp.mkdir(target);
      subStats.set(sub,await assertSafeDirectory(target,`${sub} 目录`));
    }
    await rewriteProjectIdentity(dir,project,{businessName:businessName||business.name,backupLegacy:false});
    const projectMdContent=`${projectIdentityBlock(project,businessName||business.name)}\n`;
    let rolledBack=false;
    return{
      dir,
      async rollback(){
        if(rolledBack)return;
        await removeCreatedProject({dir,dirStat,projectMdContent,subStats});
        await businessStage.rollback();
        rolledBack=true;
      }
    };
  }catch(error){
    if(created){
      const projectMdContent=`${projectIdentityBlock(project,businessName||business.name)}\n`;
      try{await removeCreatedProject({dir,dirStat,projectMdContent,subStats});}
      catch(rollbackError){throw Object.assign(new Error(`创建项目目录失败，且回滚未完整完成：${rollbackError.message}`,{cause:error}),{code:'FILESYSTEM_ROLLBACK_FAILED'});}
    }
    await businessStage.rollback().catch(()=>{});
    throw error;
  }
}

export { SUBDIRECTORIES };
