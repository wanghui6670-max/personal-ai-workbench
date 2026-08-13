import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MANAGED_START='<!-- personal-ai-workbench:managed:start -->';
const MANAGED_END='<!-- personal-ai-workbench:managed:end -->';
const PROJECT_ID_PREFIX='<!-- personal-ai-workbench:project-id:';

function oneLine(value){
  return String(value??'').replaceAll(MANAGED_START,'[managed start]').replaceAll(MANAGED_END,'[managed end]').replace(/[\r\n]+/g,' ').trim();
}

export function projectIdentityBlock(project,businessName=''){
  const projectId=String(project?.id||'unknown').replace(/[^A-Za-z0-9_-]/g,'_');
  return `${MANAGED_START}\n${PROJECT_ID_PREFIX}${projectId} -->\n# ${oneLine(project?.name)}\n\n> 这是工作台生成的项目身份证。真实工作产物以本地项目文件夹为准；项目分析、阶段总结和复盘正文只保存在绑定的飞书项目文档。\n\n- Project ID：${oneLine(project?.id||'unknown')}\n- 所属业务：${oneLine(businessName||'待归类')}\n- 项目介绍：${oneLine(project?.intro)}\n- 开始时间：${oneLine(project?.startDate)}\n- 计划结束：${oneLine(project?.endDate)}\n- Git：${oneLine(project?.git||'未设置')}\n- 飞书项目文档：${oneLine(project?.feishu||'未设置')}\n- 分析与总结真源：飞书云文档\n${MANAGED_END}`;
}

function mergeIdentity(existing,project,businessName){
  const block=projectIdentityBlock(project,businessName);
  const start=existing.indexOf(MANAGED_START),end=existing.indexOf(MANAGED_END);
  if(start===-1&&end===-1)return existing?`${existing}${existing.endsWith('\n')?'\n':'\n\n'}${block}\n`:`${block}\n`;
  if(start<0||end<start||existing.indexOf(MANAGED_START,start+MANAGED_START.length)>=0||existing.indexOf(MANAGED_END,end+MANAGED_END.length)>=0)throw new Error('PROJECT.md 的工作台托管区块不完整，已拒绝覆盖。');
  const blockEnd=end+MANAGED_END.length;
  const owned=existing.slice(start,blockEnd);
  const owner=owned.match(/<!-- personal-ai-workbench:project-id:([A-Za-z0-9_-]+) -->/);
  const expected=String(project?.id||'unknown').replace(/[^A-Za-z0-9_-]/g,'_');
  if(!owner||owner[1]!==expected)throw new Error('PROJECT.md 属于其他项目或无法确认归属，已拒绝覆盖。');
  return existing.slice(0,start)+block+existing.slice(blockEnd);
}

export async function rewriteProjectIdentity(dir,project,{businessName=''}={}){
  if(!dir)return null;
  const dirStat=await fsp.lstat(dir);
  if(dirStat.isSymbolicLink()||!dirStat.isDirectory())throw new Error('项目目录不是安全目录，已拒绝更新 PROJECT.md。');
  const target=path.join(dir,'PROJECT.md');
  let existing='';
  try{
    const stat=await fsp.lstat(target);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw new Error('PROJECT.md 不是安全的普通文件，已拒绝覆盖。');
    existing=await fsp.readFile(target,'utf8');
  }catch(error){
    if(error.code!=='ENOENT')throw error;
  }
  const content=mergeIdentity(existing,project,businessName);
  const temp=path.join(dir,`.PROJECT.md.identity-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try{
    await fsp.writeFile(temp,content,{encoding:'utf8',flag:'wx',mode:0o600});
    await fsp.rename(temp,target);
  }finally{
    await fsp.unlink(temp).catch(()=>{});
  }
  return target;
}
