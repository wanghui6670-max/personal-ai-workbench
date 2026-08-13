export * from './domain-core.mjs';

import fsp from 'node:fs/promises';
import * as core from './domain-core.mjs';
import { addActivity } from './store.mjs';
import { analyzeProject, projectPath, businessById } from './projects.mjs';
import { createFeishuProjectRecordClient, projectRecordConfigured } from './feishu.mjs';
import { machineProgress, narrativeFromProgress } from './project-record-policy.mjs';
import { rewriteProjectIdentity } from './project-identity.mjs';
import { newId, nowIso } from './utils.mjs';
import { isValidDateOnly } from './validation.mjs';

const defaultProjectRecordClient=createFeishuProjectRecordClient();
const PROJECT_RECORD_CONFIRMATION_TYPES=new Set(['project_feishu_missing','project_record_write_failed','project_identity_update_failed']);

function sameStoredValue(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function projectBusinessName(config,project){return businessById(config,project.businessId)?.name||'待归类';}
function badRequest(message){return Object.assign(new Error(message),{statusCode:400,code:'INVALID_REQUEST'});}

async function persistedProject(store,projectId){
  return (await store.readState()).projects.find(project=>project.id===projectId)||null;
}

/**
 * Keep the current UI compatible without recreating a second narrative source.
 * The strings below are static display hints, derived at read time and never
 * persisted. Actual analysis/summary/resume content must be read from Feishu.
 */
export function deriveState(appRoot,state,config,aiEnabled=false){
  const derived=core.deriveState(appRoot,state,config,aiEnabled);
  derived.projects=derived.projects.map(project=>{
    const machine=project.progress||{};
    const bound=projectRecordConfigured(project);
    return {
      ...project,
      progress:{
        ...machine,
        summary:bound?'机器进度已同步；项目分析正文保存在飞书项目文档。':'机器进度可用；项目尚未绑定飞书项目文档，分析正文不会在本地保存。',
        blocker:machine.hasBlocker?'存在卡点，详情见飞书项目文档。':'暂无明确卡点。',
        resume:bound?'上下文恢复摘要请从飞书项目文档读取。':'未绑定飞书项目文档，当前没有持久化的恢复摘要。'
      }
    };
  });
  const projectById=new Map(derived.projects.map(project=>[project.id,project]));
  derived.todos=derived.todos.map(todo=>todo.projectId&&projectById.has(todo.projectId)?{...todo,project:projectById.get(todo.projectId).name}:todo);
  derived.overdue=derived.projects.filter(project=>!project.archived&&!project.completed&&project.businessId&&derived.overdue.some(item=>item.id===project.id));
  derived.unclassified=derived.projects.filter(project=>!project.archived&&!project.businessId);
  return derived;
}

async function rewriteIdentityFor({appRoot,store,projectId}){
  const project=await persistedProject(store,projectId);
  if(!project?.businessId)return project;
  const config=await store.readConfig();
  const dir=projectPath(appRoot,config,project);
  try{
    await rewriteProjectIdentity(dir,project,{businessName:projectBusinessName(config,project)});
    await store.updateState(state=>{
      state.confirmations=state.confirmations.filter(item=>!(item.type==='project_identity_update_failed'&&item.projectId===projectId));
    });
  }catch(error){
    await store.updateState(state=>{
      if(!state.confirmations.some(item=>item.type==='project_identity_update_failed'&&item.projectId===projectId)){
        state.confirmations.unshift({id:newId('cf'),type:'project_identity_update_failed',projectId,text:`「${project.name}」的 PROJECT.md 身份索引更新失败，需要检查本地项目目录。`,createdAt:nowIso()});
      }
    });
  }
  return persistedProject(store,projectId);
}

/**
 * Existing project creation rules stay in domain-core. The facade only makes
 * the returned object converge to the machine-only persisted state and rewrites
 * PROJECT.md to the identity-only representation.
 */
export async function createProject(args){
  const result=await core.createProject(args);
  if(!result?.project?.id)return result;
  const project=await rewriteIdentityFor({appRoot:args.appRoot,store:args.store,projectId:result.project.id});
  return {...result,project:project||result.project};
}

export async function assignProjectBusiness(args){
  const result=await core.assignProjectBusiness(args);
  return await rewriteIdentityFor({appRoot:args.appRoot,store:args.store,projectId:result.id})||result;
}

/**
 * Project edits never create local narrative progress. Completion/reopen only
 * changes the machine progress envelope; PROJECT.md is updated as identity
 * metadata on a best-effort basis and any failure becomes a confirmation.
 */
export async function updateProject({appRoot,store,projectId,patch}){
  if(typeof projectId!=='string'||!projectId.trim())throw badRequest('projectId 必须是非空字符串。');
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length)throw badRequest('项目更新内容不能为空。');
  const allowed=new Set(['intro','git','feishu','completed','archived','endDate']);
  const unknown=Object.keys(patch).find(key=>!allowed.has(key));
  if(unknown)throw badRequest(`项目更新内容包含不支持的字段：${unknown}。`);
  for(const field of ['intro','git','feishu'])if(Object.hasOwn(patch,field)&&typeof patch[field]!=='string')throw badRequest(`${field} 必须是字符串。`);
  for(const field of ['completed','archived'])if(Object.hasOwn(patch,field)&&typeof patch[field]!=='boolean')throw badRequest(`${field} 必须是布尔值。`);
  if(Object.hasOwn(patch,'endDate')&&!isValidDateOnly(patch.endDate))throw badRequest('endDate 必须是合法的 YYYY-MM-DD 日期。');

  let updated=null;
  await store.updateState(state=>{
    const project=state.projects.find(item=>item.id===projectId);
    if(!project)throw new Error('项目不存在');
    for(const field of ['intro','git','feishu'])if(Object.hasOwn(patch,field))project[field]=patch[field].trim();
    if(Object.hasOwn(patch,'completed')){
      const wasCompleted=project.completed===true;
      project.completed=patch.completed;
      if(project.completed&&!wasCompleted){
        project.progressBeforeCompletion=structuredClone(project.progress||{});
        project.progress={...(project.progress||{}),percent:100,status:'已完成',hasBlocker:false};
      }else if(!project.completed&&wasCompleted){
        if(project.progressBeforeCompletion&&typeof project.progressBeforeCompletion==='object'&&!Array.isArray(project.progressBeforeCompletion)){
          project.progress=structuredClone(project.progressBeforeCompletion);
        }else{
          const current=project.progress||{};
          project.progress={
            ...current,
            percent:Math.min(99,Number.isInteger(current.percent)?current.percent:0),
            status:current.lastActivity?'进行中':'未启动',
            hasBlocker:Boolean(current.hasBlocker)
          };
        }
        delete project.progressBeforeCompletion;
      }
    }
    if(Object.hasOwn(patch,'archived'))project.archived=patch.archived;
    if(Object.hasOwn(patch,'endDate'))project.endDate=patch.endDate;
    addActivity(state,{type:'project_updated',projectId,text:`更新项目「${project.name}」`});
    updated=structuredClone(project);
  });
  return await rewriteIdentityFor({appRoot,store,projectId})||updated;
}

function staleSyncError(){
  const error=new Error('项目在同步期间发生变化，本次过期分析未写入；请重新同步。');
  error.statusCode=409;
  error.code='PROJECT_SYNC_STALE';
  return error;
}

function missingFeishuConfirmation(state,project){
  if(state.confirmations.some(item=>item.type==='project_feishu_missing'&&item.projectId===project.id))return;
  state.confirmations.unshift({
    id:newId('cf'),type:'project_feishu_missing',projectId:project.id,
    text:`「${project.name}」尚未绑定飞书项目文档。本次只保存机器进度，项目分析正文未落地。`,createdAt:nowIso()
  });
}

function clearProjectRecordConfirmations(state,projectId){
  state.confirmations=state.confirmations.filter(item=>!(PROJECT_RECORD_CONFIRMATION_TYPES.has(item.type)&&item.projectId===projectId));
}

async function directoryAvailable(dir){
  if(!dir)return false;
  try{
    const stat=await fsp.lstat(dir);
    return !stat.isSymbolicLink()&&stat.isDirectory();
  }catch{return false;}
}

function unavailableNarrative(project){
  const machine=project.progress||{};
  return {
    percent:project.completed?100:Math.min(99,Number.isInteger(machine.percent)?machine.percent:0),
    status:project.completed?'已完成':(machine.status||'未启动'),
    summary:'项目目录不存在或不可访问，无法刷新新的分析证据。',
    resume:'保留上次机器进度；项目目录恢复可访问后再主动同步。',
    blocker:'项目目录不可访问，需要你确认本地项目路径。',
    lastActivity:machine.lastActivity??null,
    syncedAt:nowIso(),
    confidence:Math.min(.2,typeof machine.confidence==='number'?machine.confidence:.2)
  };
}

/**
 * Project sync is intentionally remote-first for narrative records:
 *
 * local files/Git -> transient analysis -> Feishu append/readback -> machine
 * state commit. Narrative summary/resume/blocker never enter state.json,
 * PROJECT.md, or activity text.
 */
export async function syncProject({appRoot,store,projectId,projectRecordClient=defaultProjectRecordClient}){
  const state=await store.readState();
  const config=await store.readConfig();
  const project=state.projects.find(item=>item.id===projectId);
  if(!project)throw new Error('项目不存在');
  if(!project.businessId)throw new Error('项目尚未归类');
  const sourceDir=projectPath(appRoot,config,project);
  const available=await directoryAvailable(sourceDir);
  const analysis=available
    ?await analyzeProject(appRoot,config,project)
    :{progress:unavailableNarrative(project),gitRemote:project.git||'',filesCount:0,dir:sourceDir,scan:{complete:false,reasons:['project_unavailable'],directoriesVisited:0,maxDepthVisited:0,durationMs:0}};

  // Refuse an already-stale analysis before any remote write.
  const beforeRemote=await store.readState();
  const beforeRemoteProject=beforeRemote.projects.find(item=>item.id===projectId);
  const beforeRemoteConfig=await store.readConfig();
  if(!beforeRemoteProject||!sameStoredValue(beforeRemoteProject,project)||projectPath(appRoot,beforeRemoteConfig,beforeRemoteProject)!==sourceDir)throw staleSyncError();

  const recordedAt=nowIso();
  let record=null;
  if(projectRecordConfigured(project)){
    const text=narrativeFromProgress(project,analysis.progress,{kind:'analysis',recordedAt});
    record=await projectRecordClient.appendAnalysis(project.feishu,text);
  }

  let committed=null;
  await store.updateState(current=>{
    const p=current.projects.find(item=>item.id===projectId);
    if(!p||!sameStoredValue(p,project))throw staleSyncError();
    const recordPointer=record?{revisionId:record.revisionId,item:record.item,recordedAt}:null;
    p.progress=machineProgress(analysis.progress,recordPointer);
    if(!p.git&&analysis.gitRemote)p.git=analysis.gitRemote;
    if(record)clearProjectRecordConfirmations(current,p.id);
    else missingFeishuConfirmation(current,p);
    if(analysis.progress.confidence<.55&&!current.confirmations.some(item=>item.type==='progress_unclear'&&item.projectId===p.id)){
      current.confirmations.unshift({id:newId('cf'),type:'progress_unclear',projectId:p.id,text:`「${p.name}」的进度证据不足，需要你确认。`,createdAt:nowIso()});
    }
    addActivity(current,{
      type:'project_synced',projectId:p.id,
      text:`同步「${p.name}」：${p.progress.percent}% · ${p.progress.status}${record?' · 分析正文已写入飞书':' · 未保存分析正文（未绑定飞书项目文档）'}`
    });
    committed=structuredClone(p);
  });

  await rewriteIdentityFor({appRoot,store,projectId});
  return {
    ...analysis,
    machineProgress:committed?.progress||null,
    record:record?{
      saved:true,documentUrl:project.feishu,revisionId:record.revisionId??null,
      blockId:record.item?.blockId??null,recordedAt
    }:{saved:false,documentUrl:project.feishu||null,recordedAt:null}
  };
}

export async function syncAllProjects({appRoot,store,projectRecordClient=defaultProjectRecordClient}){
  const state=await store.readState();
  const results=[];
  for(const project of state.projects.filter(item=>item.businessId&&!item.archived)){
    try{
      const analysis=await syncProject({appRoot,store,projectId:project.id,projectRecordClient});
      results.push({id:project.id,ok:true,progress:analysis.machineProgress,record:analysis.record});
    }catch(error){
      if(error?.code==='PROJECT_SYNC_STALE'){
        results.push({id:project.id,ok:false,stale:true,code:'PROJECT_SYNC_STALE'});
        continue;
      }
      await store.updateState(current=>{
        if(!current.confirmations.some(item=>item.type==='sync_failed'&&item.projectId===project.id)){
          current.confirmations.unshift({id:newId('cf'),type:'sync_failed',projectId:project.id,text:`「${project.name}」同步失败：${error.message}`,createdAt:nowIso()});
        }
      });
      results.push({id:project.id,ok:false,error:error.message});
    }
  }
  return results;
}

/** Read project narrative directly from Feishu. Nothing is cached locally. */
export async function readProjectRecords({store,projectId,projectRecordClient=defaultProjectRecordClient}){
  const project=await persistedProject(store,projectId);
  if(!project)throw new Error('项目不存在');
  if(!projectRecordConfigured(project)){
    const error=new Error('项目尚未绑定飞书项目文档。');
    error.statusCode=409;
    throw error;
  }
  const records=await projectRecordClient.fetch(project.feishu);
  return {
    projectId:project.id,documentUrl:project.feishu,revisionId:records.revisionId??null,
    records:records.items.map(item=>({blockId:item.blockId,kind:item.kind,text:item.text}))
  };
}

/** Append a human stage summary to Feishu without duplicating the text locally. */
export async function appendProjectSummary({store,projectId,text,projectRecordClient=defaultProjectRecordClient}){
  const project=await persistedProject(store,projectId);
  if(!project)throw new Error('项目不存在');
  if(!projectRecordConfigured(project)){
    const error=new Error('项目尚未绑定飞书项目文档。');
    error.statusCode=409;
    throw error;
  }
  const value=String(text||'').trim();
  if(!value){
    const error=new Error('阶段总结不能为空。');
    error.statusCode=400;
    throw error;
  }
  const result=await projectRecordClient.appendSummary(project.feishu,value);
  await store.updateState(state=>{
    addActivity(state,{type:'project_summary_saved',projectId,text:`「${project.name}」阶段总结已保存到飞书项目文档。`});
  });
  return {saved:true,projectId,documentUrl:project.feishu,revisionId:result.revisionId??null,blockId:result.item?.blockId??null};
}
