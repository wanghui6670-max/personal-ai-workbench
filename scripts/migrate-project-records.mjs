import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.mjs';
import { loadWorkbenchEnv } from '../src/env.mjs';
import { projectPath, businessById } from '../src/projects.mjs';
import { migrateProjectIdentity } from '../src/project-identity.mjs';
import { appendProjectSummary } from '../src/domain.mjs';
import { projectRecordConfigured } from '../src/feishu.mjs';

const __filename=fileURLToPath(import.meta.url);
const APP_ROOT=path.dirname(path.dirname(__filename));
await loadWorkbenchEnv({root:APP_ROOT});
const DATA_DIR=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(APP_ROOT,'data');
const apply=process.argv.includes('--apply');
const store=new JsonStore(DATA_DIR);
await store.ensure();

function legacyText(project){
  const progress=project?.progress&&typeof project.progress==='object'?project.progress:{};
  const before=project?.progressBeforeCompletion&&typeof project.progressBeforeCompletion==='object'?project.progressBeforeCompletion:{};
  const source=Object.keys(progress).some(key=>['summary','resume','blocker'].includes(key))?progress:before;
  if(!['summary','resume','blocker'].some(key=>typeof source[key]==='string'&&source[key].trim()))return null;
  return [
    '迁移来源：Personal AI Workbench 升级前本地项目记录',
    `项目：${project.name||project.id}`,
    `状态：${source.status||'未记录'}`,
    `进度：${Number.isFinite(source.percent)?Math.round(source.percent):0}%`,
    `原分析：${source.summary||'未记录'}`,
    `原卡点：${source.blocker||'未记录'}`,
    `原恢复摘要：${source.resume||'未记录'}`,
    `原同步时间：${source.syncedAt||'未记录'}`
  ].join(' ｜ ');
}

async function readSnapshot(){
  const target=path.join(store.migrationDir,'pre-narrative-v1-startup.json');
  try{return JSON.parse(await fsp.readFile(target,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

const snapshot=await readSnapshot();
const [state,config]=await Promise.all([store.readState(),store.readConfig()]);
const legacyById=new Map((snapshot?.state?.projects||[]).map(project=>[project.id,project]));
const results=[];

for(const project of state.projects){
  const legacy=legacyById.get(project.id);
  const narrative=legacyText(legacy);
  const business=businessById(config,project.businessId);
  const dir=project.businessId?projectPath(APP_ROOT,config,project):null;
  const result={projectId:project.id,name:project.name,narrative:Boolean(narrative),feishuBound:projectRecordConfigured(project),projectMd:'not_applicable',narrativeMigration:'not_applicable'};

  if(dir){
    try{
      const identity=await migrateProjectIdentity(dir,project,{businessName:business?.name||'待归类',dryRun:!apply});
      result.projectMd=identity.status;
    }catch(error){result.projectMd=`error:${error.message}`;}
  }

  if(narrative){
    if(!projectRecordConfigured(project))result.narrativeMigration='pending_feishu_binding';
    else if(!apply)result.narrativeMigration='ready';
    else{
      try{
        const saved=await appendProjectSummary({store,projectId:project.id,text:narrative});
        result.narrativeMigration=saved.replayed?'already_migrated':'migrated';
        result.operationId=saved.operationId;
        result.blockId=saved.blockId;
        await store.updateState(current=>{
          current.confirmations=current.confirmations.filter(item=>!(item.type==='legacy_project_narrative_pending'&&item.projectId===project.id));
        });
      }catch(error){result.narrativeMigration=`error:${error.code||error.message}`;}
    }
  }
  results.push(result);
}

const report={migration:'project-narrative-to-feishu-v1',mode:apply?'apply':'dry-run',createdAt:new Date().toISOString(),snapshotFound:Boolean(snapshot),results};
if(apply){
  const reportFile=path.join(store.migrationDir,`migration-report-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await fsp.writeFile(reportFile,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
  report.reportFile=reportFile;
}
console.log(JSON.stringify(report,null,2));
