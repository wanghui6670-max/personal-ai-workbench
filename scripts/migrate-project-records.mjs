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

function hasNarrative(progress){
  return progress&&typeof progress==='object'&&!Array.isArray(progress)&&['summary','resume','blocker'].some(key=>typeof progress[key]==='string'&&progress[key].trim());
}

function legacySection(project,label,source){
  return [
    '迁移来源：Personal AI Workbench 升级前本地项目记录',
    `项目：${project.name||project.id}`,
    `记录范围：${label}`,
    `状态：${source.status||'未记录'}`,
    `进度：${Number.isFinite(source.percent)?Math.round(source.percent):0}%`,
    `原分析：${source.summary||'未记录'}`,
    `原卡点：${source.blocker||'未记录'}`,
    `原恢复摘要：${source.resume||'未记录'}`,
    `原同步时间：${source.syncedAt||'未记录'}`
  ].join(' ｜ ');
}

function splitRecord(text,max=5_600){
  const chunks=[];
  for(let offset=0;offset<text.length;offset+=max){
    const part=text.slice(offset,offset+max);
    chunks.push(text.length>max?`迁移分片 ${chunks.length+1} ｜ ${part}`:part);
  }
  return chunks;
}

function legacyTexts(project){
  if(!project)return[];
  const sections=[];
  if(hasNarrative(project.progress))sections.push(legacySection(project,'项目当前进度',project.progress));
  if(hasNarrative(project.progressBeforeCompletion))sections.push(legacySection(project,'项目完成前进度',project.progressBeforeCompletion));
  return sections.flatMap(text=>splitRecord(text));
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
  const narratives=legacyTexts(legacy);
  const business=businessById(config,project.businessId);
  const dir=project.businessId?projectPath(APP_ROOT,config,project):null;
  const result={
    projectId:project.id,
    name:project.name,
    narrative:narratives.length>0,
    narrativeRecordCount:narratives.length,
    feishuBound:projectRecordConfigured(project),
    projectMd:'not_applicable',
    narrativeMigration:'not_applicable',
    records:[]
  };

  if(dir){
    try{
      const identity=await migrateProjectIdentity(dir,project,{businessName:business?.name||'待归类',dryRun:!apply});
      result.projectMd=identity.status;
    }catch(error){result.projectMd=`error:${error.message}`;}
  }

  if(narratives.length){
    if(!projectRecordConfigured(project))result.narrativeMigration='pending_feishu_binding';
    else if(!apply)result.narrativeMigration='ready';
    else{
      let complete=true;
      for(const text of narratives){
        try{
          const saved=await appendProjectSummary({store,projectId:project.id,text});
          result.records.push({
            status:saved.replayed?'already_migrated':'migrated',
            operationId:saved.operationId,
            blockId:saved.blockId
          });
        }catch(error){
          complete=false;
          result.records.push({status:'error',error:error.code||error.message});
          break;
        }
      }
      result.narrativeMigration=complete?'migrated':'partial_error';
      if(complete){
        await store.updateState(current=>{
          current.confirmations=current.confirmations.filter(item=>!(item.type==='legacy_project_narrative_pending'&&item.projectId===project.id));
        });
      }
    }
  }
  results.push(result);
}

const report={
  migration:'project-narrative-to-feishu-v1',
  mode:apply?'apply':'dry-run',
  createdAt:new Date().toISOString(),
  snapshotFound:Boolean(snapshot),
  results
};
if(apply){
  const reportFile=path.join(store.migrationDir,`migration-report-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await fsp.writeFile(reportFile,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
  report.reportFile=reportFile;
}
console.log(JSON.stringify(report,null,2));
