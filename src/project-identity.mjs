import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MANAGED_START='<!-- personal-ai-workbench:managed:start -->';
const MANAGED_END='<!-- personal-ai-workbench:managed:end -->';
const PROJECT_ID_PREFIX='<!-- personal-ai-workbench:project-id:';
const LEGACY_MARKERS=['## 当前进度','进度说明：','当前卡点：','上下文恢复：','最近同步：'];

function oneLine(value){
  return String(value??'').replaceAll(MANAGED_START,'[managed start]').replaceAll(MANAGED_END,'[managed end]').replace(/[\r\n]+/g,' ').trim();
}

function expectedProjectId(project){return String(project?.id||'unknown').replace(/[^A-Za-z0-9_-]/g,'_');}

export function projectIdentityBlock(project,businessName=''){
  const projectId=expectedProjectId(project);
  return `${MANAGED_START}\n${PROJECT_ID_PREFIX}${projectId} -->\n# ${oneLine(project?.name)}\n\n> 这是工作台生成的项目身份证。真实工作产物以本地项目文件夹为准；项目分析、阶段总结和复盘正文只保存在绑定的飞书项目文档。\n\n- Project ID：${oneLine(project?.id||'unknown')}\n- 所属业务：${oneLine(businessName||'待归类')}\n- 项目介绍：${oneLine(project?.intro)}\n- 开始时间：${oneLine(project?.startDate)}\n- 计划结束：${oneLine(project?.endDate)}\n- Git：${oneLine(project?.git||'未设置')}\n- 飞书项目文档：${oneLine(project?.feishu||'未设置')}\n- 分析与总结真源：飞书云文档\n${MANAGED_END}`;
}

function inspectManagedBlock(existing,project){
  const starts=[...existing.matchAll(new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))];
  const ends=[...existing.matchAll(new RegExp(MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))];
  if(starts.length===0&&ends.length===0)return{managed:false,malformed:false,legacy:false,start:-1,end:-1,owned:''};
  if(starts.length!==1||ends.length!==1||ends[0].index<starts[0].index)return{managed:true,malformed:true,legacy:false,start:-1,end:-1,owned:''};
  const start=starts[0].index,end=ends[0].index+MANAGED_END.length;
  const owned=existing.slice(start,end);
  const owner=owned.match(/<!-- personal-ai-workbench:project-id:([A-Za-z0-9_-]+) -->/);
  if(!owner||owner[1]!==expectedProjectId(project))return{managed:true,malformed:true,ownerMismatch:true,legacy:false,start,end,owned};
  return{managed:true,malformed:false,legacy:LEGACY_MARKERS.some(marker=>owned.includes(marker)),start,end,owned};
}

function mergeIdentity(existing,project,businessName){
  const block=projectIdentityBlock(project,businessName);
  const inspection=inspectManagedBlock(existing,project);
  if(inspection.malformed)throw new Error(inspection.ownerMismatch?'PROJECT.md 属于其他项目或无法确认归属，已拒绝覆盖。':'PROJECT.md 的工作台托管区块不完整，已拒绝覆盖。');
  if(!inspection.managed)return existing?`${existing}${existing.endsWith('\n')?'\n':'\n\n'}${block}\n`:`${block}\n`;
  return existing.slice(0,inspection.start)+block+existing.slice(inspection.end);
}

async function readSafeProjectMd(target){
  try{
    const stat=await fsp.lstat(target);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw new Error('PROJECT.md 不是安全的普通文件，已拒绝覆盖。');
    return{exists:true,content:await fsp.readFile(target,'utf8'),mode:stat.mode&0o777};
  }catch(error){
    if(error.code==='ENOENT')return{exists:false,content:'',mode:0o600};
    throw error;
  }
}

async function backupLegacyProjectMd(target,content){
  const backup=`${target}.pre-feishu-v1.bak`;
  try{
    await fsp.writeFile(backup,content,{encoding:'utf8',flag:'wx',mode:0o600});
    return backup;
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    const stat=await fsp.lstat(backup);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw new Error('PROJECT.md 迁移备份不是安全普通文件，已拒绝继续。');
    return backup;
  }
}

export async function inspectProjectIdentity(dir,project){
  if(!dir)return{status:'missing_directory',target:null,legacy:false};
  const dirStat=await fsp.lstat(dir);
  if(dirStat.isSymbolicLink()||!dirStat.isDirectory())throw new Error('项目目录不是安全目录，已拒绝检查 PROJECT.md。');
  const target=path.join(dir,'PROJECT.md');
  const file=await readSafeProjectMd(target);
  if(!file.exists)return{status:'missing_file',target,legacy:false};
  const inspection=inspectManagedBlock(file.content,project);
  if(inspection.malformed)return{status:inspection.ownerMismatch?'owner_mismatch':'malformed',target,legacy:false};
  return{status:inspection.legacy?'legacy':'current',target,legacy:inspection.legacy,managed:inspection.managed};
}

export async function rewriteProjectIdentity(dir,project,{businessName='',backupLegacy=true}={}){
  if(!dir)return null;
  const dirStat=await fsp.lstat(dir);
  if(dirStat.isSymbolicLink()||!dirStat.isDirectory())throw new Error('项目目录不是安全目录，已拒绝更新 PROJECT.md。');
  const target=path.join(dir,'PROJECT.md');
  const file=await readSafeProjectMd(target);
  const inspection=inspectManagedBlock(file.content,project);
  if(inspection.malformed)throw new Error(inspection.ownerMismatch?'PROJECT.md 属于其他项目或无法确认归属，已拒绝覆盖。':'PROJECT.md 的工作台托管区块不完整，已拒绝覆盖。');
  if(backupLegacy&&inspection.legacy)await backupLegacyProjectMd(target,file.content);
  const content=mergeIdentity(file.content,project,businessName);
  if(file.exists&&content===file.content)return target;
  const temp=path.join(dir,`.PROJECT.md.identity-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try{
    await fsp.writeFile(temp,content,{encoding:'utf8',flag:'wx',mode:file.mode||0o600});
    await fsp.chmod(temp,file.mode||0o600);
    await fsp.rename(temp,target);
  }finally{
    await fsp.unlink(temp).catch(()=>{});
  }
  return target;
}

export async function migrateProjectIdentity(dir,project,{businessName='',dryRun=true}={}){
  const inspection=await inspectProjectIdentity(dir,project);
  if(dryRun||!['legacy','missing_file'].includes(inspection.status))return{...inspection,applied:false};
  const target=await rewriteProjectIdentity(dir,project,{businessName,backupLegacy:true});
  return{status:'migrated',target,legacy:inspection.legacy,applied:true,backup:inspection.legacy?`${target}.pre-feishu-v1.bak`:null};
}

export { MANAGED_START, MANAGED_END, LEGACY_MARKERS };
