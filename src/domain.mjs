import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import * as core from './domain-core.mjs';
import { addActivity } from './store.mjs';
import { classifyProjectDescription } from './ai.mjs';
import {
  analyzeProject,
  projectPath,
  businessById,
  defaultProjectName,
  uniqueProjectFolder
} from './projects.mjs';
import { prepareIdentityProjectDir } from './project-directory.mjs';
import { createFeishuProjectRecordClient, projectRecordConfigured } from './feishu.mjs';
import { machineProgress, narrativeFromProgress } from './project-record-policy.mjs';
import { rewriteProjectIdentity } from './project-identity.mjs';
import { newId, nowIso, todayIso, compactText } from './utils.mjs';
import { isValidDateOnly } from './validation.mjs';
import { recordGetnoteSourceDecision } from './external-task-decisions.mjs';
import {
  normalizeFeishuProjectDocumentUrl,
  normalizeProjectRecordText,
  projectRecordOperationId,
  clearProjectRecordPointer,
  boundedProjectRecordLimit
} from './project-record-contract.mjs';
import { withProjectSyncLease, withAllProjectSyncLease } from './project-sync-coordinator.mjs';

export const projectStatus=core.projectStatus;
export const updateWorkbenchConfig=core.updateWorkbenchConfig;
export const configureDataSource=core.configureDataSource;
export const syncFeishuInbox=core.syncFeishuInbox;
export const addInbox=core.addInbox;
export const processInbox=core.processInbox;
export const morningCandidates=core.morningCandidates;
export const morningChat=core.morningChat;
export const setToday=core.setToday;
export const updateTodo=core.updateTodo;
export const createBusiness=core.createBusiness;
export const renameBusiness=core.renameBusiness;
export const deleteBusiness=core.deleteBusiness;

const defaultProjectRecordClient=createFeishuProjectRecordClient();
const PROJECT_RECORD_CONFIRMATION_TYPES=new Set([
  'project_feishu_missing',
  'project_record_write_failed',
  'project_identity_update_failed'
]);

function sameStoredValue(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function projectBusinessName(config,project){return businessById(config,project.businessId)?.name||'待归类';}
function badRequest(message){return Object.assign(new Error(message),{statusCode:400,code:'INVALID_REQUEST'});}
function snapshotHash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}

async function persistedProject(store,projectId){
  return (await store.readState()).projects.find(project=>project.id===projectId)||null;
}

function replayProjectOrConflict(existing,{description,endDate}){
  if(existing.sourceDescription===description&&existing.endDate===endDate){
    return{project:structuredClone(existing),unclassified:!existing.businessId,replay:true};
  }
  throw Object.assign(new Error('该收件箱事项已用于创建参数不同的项目。'),{statusCode:409});
}

async function rollbackStage(stage,scope,error){
  if(!stage)throw error;
  try{await stage.rollback();}
  catch(rollbackError){
    const combined=new Error(`${scope}失败，且文件系统回滚未完整完成：${rollbackError.message}`,{cause:error});
    combined.code='FILESYSTEM_ROLLBACK_FAILED';
    throw combined;
  }
  throw error;
}

export function deriveState(appRoot,state,config,aiEnabled=false){
  const derived=core.deriveState(appRoot,state,config,aiEnabled);
  derived.projects=derived.projects.map(project=>{
    const machine=project.progress||{};
    const bound=projectRecordConfigured(project);
    const recoveryPending=state.confirmations.some(
      item=>item.type==='project_record_recovery_pending'&&item.projectId===project.id
    );
    return {
      ...project,
      recordRecoveryPending:recoveryPending,
      progress:{
        ...machine,
        summary:recoveryPending
          ?'飞书记录已经保存，但本地指针仍待对账。'
          :bound
            ?'机器进度已同步；项目分析正文保存在飞书项目文档。'
            :'机器进度可用；项目尚未绑定飞书项目文档，分析正文不会在本地保存。',
        blocker:machine.hasBlocker?'存在卡点，详情见飞书项目文档。':'暂无明确卡点。',
        resume:bound?'上下文恢复摘要请从飞书项目文档读取。':'未绑定飞书项目文档，当前没有持久化的恢复摘要。'
      }
    };
  });
  const projectById=new Map(derived.projects.map(project=>[project.id,project]));
  derived.todos=derived.todos.map(todo=>
    todo.projectId&&projectById.has(todo.projectId)
      ?{...todo,project:projectById.get(todo.projectId).name}
      :todo
  );
  derived.overdue=derived.projects.filter(
    project=>!project.archived&&!project.completed&&project.businessId&&derived.overdue.some(item=>item.id===project.id)
  );
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
      state.confirmations=state.confirmations.filter(
        item=>!(item.type==='project_identity_update_failed'&&item.projectId===projectId)
      );
    });
  }catch(error){
    await store.updateState(state=>{
      if(!state.confirmations.some(item=>item.type==='project_identity_update_failed'&&item.projectId===projectId)){
        state.confirmations.unshift({
          id:newId('cf'),
          type:'project_identity_update_failed',
          projectId,
          text:`「${project.name}」的 PROJECT.md 身份索引更新失败，需要检查本地项目目录。`,
          createdAt:nowIso()
        });
      }
    }).catch(()=>{});
  }
  return persistedProject(store,projectId);
}

export async function createProject({appRoot,store,description,endDate,businessId=null,sourceInboxId}){
  if(typeof description!=='string'||!description.trim()){
    return{needsFollowup:true,question:'请先讲清楚这个项目是做什么的。'};
  }
  if(!endDate)return{needsFollowup:true,question:'这个项目计划哪一天结束？'};
  if(!isValidDateOnly(endDate)){
    return{needsFollowup:true,question:'计划结束日期必须是合法的 YYYY-MM-DD 日期。'};
  }
  if(typeof sourceInboxId!=='string'||!sourceInboxId.trim()){
    throw badRequest('创建项目必须来自收件箱。请先把项目描述记入收件箱。');
  }
  if(businessId!==null&&(typeof businessId!=='string'||!businessId.trim())){
    throw badRequest('businessId 必须是非空字符串或 null。');
  }

  const normalizedDescription=description.trim();
  const before=await store.readState();
  const existing=before.projects.find(project=>project.sourceInboxId===sourceInboxId);
  if(existing)return replayProjectOrConflict(existing,{description:normalizedDescription,endDate});
  const source=before.inbox.find(item=>item.id===sourceInboxId);
  if(!source)throw Object.assign(new Error('来源收件箱事项不存在或已被处理。'),{statusCode:409});
  if(source.text.trim()!==normalizedDescription){
    throw Object.assign(new Error('项目描述必须与来源收件箱事项一致。'),{statusCode:409});
  }

  const config=await store.readConfig();
  if(businessId!==null&&!businessById(config,businessId))throw badRequest('业务板块不存在。');
  const ai=await classifyProjectDescription(normalizedDescription,config.businesses);
  const selectedBusiness=businessId??(
    ai?.confidence>=0.72&&businessById(config,ai.businessId)?ai.businessId:null
  );
  const name=(ai?.name||defaultProjectName(normalizedDescription)).trim();
  const intro=(ai?.intro||compactText(normalizedDescription,130)).trim();
  const createdDate=todayIso();
  const project={
    id:newId('p'),
    businessId:selectedBusiness,
    name,
    intro,
    createdAt:createdDate,
    startDate:createdDate,
    endDate,
    sourceInboxId,
    sourceDescription:normalizedDescription,
    folder:'',
    git:'',
    feishu:'',
    completed:false,
    archived:false,
    progress:{
      percent:0,
      status:'未启动',
      hasBlocker:false,
      lastActivity:null,
      syncedAt:null,
      confidence:.9
    }
  };

  let stage=null;
  try{
    return await store.updateState(async state=>{
      const committed=state.projects.find(candidate=>candidate.sourceInboxId===sourceInboxId);
      if(committed)return replayProjectOrConflict(committed,{description:normalizedDescription,endDate});
      const sourceItem=state.inbox.find(item=>item.id===sourceInboxId);
      if(!sourceItem)throw Object.assign(new Error('来源收件箱事项不存在或已被处理。'),{statusCode:409});
      if(sourceItem.text.trim()!==normalizedDescription){
        throw Object.assign(new Error('项目描述必须与来源收件箱事项一致。'),{statusCode:409});
      }
      recordGetnoteSourceDecision(state,sourceItem,'project_created');
      project.folder=await uniqueProjectFolder({
        appRoot,
        config,
        projects:state.projects,
        name,
        businessId:selectedBusiness
      });
      if(selectedBusiness){
        stage=await prepareIdentityProjectDir(appRoot,config,project,{
          businessName:projectBusinessName(config,project)
        });
      }
      state.projects.unshift(structuredClone(project));
      state.inbox=state.inbox.filter(item=>item.id!==sourceInboxId);
      addActivity(state,{
        type:'project_created',
        projectId:project.id,
        text:`创建项目「${project.name}」${selectedBusiness?'':'，暂放待归类'}`
      });
      return{project:structuredClone(project),unclassified:!selectedBusiness,replay:false};
    });
  }catch(error){
    try{
      const committed=(await store.readState()).projects.find(
        candidate=>candidate.sourceInboxId===sourceInboxId
      );
      if(committed)return replayProjectOrConflict(committed,{description:normalizedDescription,endDate});
    }catch(readbackError){
      if(readbackError?.statusCode===409)throw readbackError;
    }
    return rollbackStage(stage,'创建项目',error);
  }
}

export async function assignProjectBusiness({appRoot,store,projectId,businessId}){
  const config=await store.readConfig();
  const business=businessById(config,businessId);
  if(!business)throw new Error('业务板块不存在');

  let stage=null;
  let result=null;
  try{
    await store.updateState(async state=>{
      const current=state.projects.find(project=>project.id===projectId);
      if(!current)throw new Error('项目不存在');
      const changed=current.businessId!==businessId;
      if(changed){
        const folder=await uniqueProjectFolder({
          appRoot,
          config,
          projects:state.projects,
          name:current.name,
          businessId,
          excludeProjectId:current.id
        });
        const candidate={...current,businessId,folder};
        stage=await prepareIdentityProjectDir(appRoot,config,candidate,{businessName:business.name});
        current.businessId=businessId;
        current.folder=folder;
        addActivity(state,{
          type:'project_classified',
          projectId,
          text:`「${current.name}」归入「${business.name}」`
        });
      }
      result=structuredClone(current);
    });
  }catch(error){
    return rollbackStage(stage,'归类项目',error);
  }

  if(!stage)return await rewriteIdentityFor({appRoot,store,projectId})||result;
  return await persistedProject(store,projectId)||result;
}

export async function updateProject({appRoot,store,projectId,patch}){
  if(typeof projectId!=='string'||!projectId.trim())throw badRequest('projectId 必须是非空字符串。');
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length){
    throw badRequest('项目更新内容不能为空。');
  }
  const allowed=new Set(['intro','git','feishu','completed','archived','endDate']);
  const unknown=Object.keys(patch).find(key=>!allowed.has(key));
  if(unknown)throw badRequest(`项目更新内容包含不支持的字段：${unknown}。`);
  for(const field of ['intro','git','feishu']){
    if(Object.hasOwn(patch,field)&&typeof patch[field]!=='string')throw badRequest(`${field} 必须是字符串。`);
  }
  for(const field of ['completed','archived']){
    if(Object.hasOwn(patch,field)&&typeof patch[field]!=='boolean')throw badRequest(`${field} 必须是布尔值。`);
  }
  if(Object.hasOwn(patch,'endDate')&&!isValidDateOnly(patch.endDate)){
    throw badRequest('endDate 必须是合法的 YYYY-MM-DD 日期。');
  }
  const normalizedFeishu=Object.hasOwn(patch,'feishu')
    ?normalizeFeishuProjectDocumentUrl(patch.feishu,{allowEmpty:true})
    :undefined;

  let updated=null;
  await store.updateState(state=>{
    const project=state.projects.find(item=>item.id===projectId);
    if(!project)throw new Error('项目不存在');
    for(const field of ['intro','git']){
      if(Object.hasOwn(patch,field))project[field]=patch[field].trim();
    }
    if(normalizedFeishu!==undefined&&normalizedFeishu!==(project.feishu||'')){
      project.feishu=normalizedFeishu;
      if(project.progress)project.progress=clearProjectRecordPointer(project.progress);
      if(project.progressBeforeCompletion){
        project.progressBeforeCompletion=clearProjectRecordPointer(project.progressBeforeCompletion);
      }
      state.confirmations=state.confirmations.filter(
        item=>!(item.projectId===project.id&&[
          'project_record_recovery_pending',
          'project_feishu_missing'
        ].includes(item.type))
      );
    }
    if(Object.hasOwn(patch,'completed')){
      const wasCompleted=project.completed===true;
      project.completed=patch.completed;
      if(project.completed&&!wasCompleted){
        project.progressBeforeCompletion=structuredClone(project.progress||{});
        project.progress={...(project.progress||{}),percent:100,status:'已完成',hasBlocker:false};
      }else if(!project.completed&&wasCompleted){
        if(
          project.progressBeforeCompletion&&
          typeof project.progressBeforeCompletion==='object'&&
          !Array.isArray(project.progressBeforeCompletion)
        ){
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
  return Object.assign(
    new Error('项目在同步期间发生变化，本次过期分析未写入；请重新同步。'),
    {statusCode:409,code:'PROJECT_SYNC_STALE'}
  );
}

function remoteSavedPendingError(receipt,cause){
  const error=new Error(
    '飞书项目记录已保存，但本地机器状态尚未提交。系统已保留可恢复凭据，请重新同步或在待确认中对账。',
    {cause}
  );
  error.statusCode=409;
  error.code='PROJECT_RECORD_REMOTE_SAVED_LOCAL_PENDING';
  error.recovery={
    operationId:receipt.operationId,
    revisionId:receipt.revisionId,
    blockId:receipt.blockId,
    recordedAt:receipt.recordedAt
  };
  return error;
}

function missingFeishuConfirmation(state,project){
  if(state.confirmations.some(item=>item.type==='project_feishu_missing'&&item.projectId===project.id))return;
  state.confirmations.unshift({
    id:newId('cf'),
    type:'project_feishu_missing',
    projectId:project.id,
    text:`「${project.name}」尚未绑定飞书项目文档。本次只保存机器进度，项目分析正文未落地。`,
    createdAt:nowIso()
  });
}

function clearProjectRecordConfirmations(state,projectId){
  state.confirmations=state.confirmations.filter(
    item=>!(PROJECT_RECORD_CONFIRMATION_TYPES.has(item.type)&&item.projectId===projectId)
  );
}

async function addRecoveryConfirmation(store,project,receipt){
  await store.updateState(state=>{
    if(state.confirmations.some(
      item=>item.type==='project_record_recovery_pending'&&item.operationId===receipt.operationId
    ))return;
    state.confirmations.unshift({
      id:newId('cf'),
      type:'project_record_recovery_pending',
      projectId:project.id,
      operationId:receipt.operationId,
      text:`「${project.name}」有一条飞书记录已保存但本地指针未提交。operationId=${receipt.operationId}，需要重新同步或人工核对。`,
      createdAt:nowIso()
    });
  }).catch(()=>{});
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

function analysisOperationId(project,sourceDir,analysis){
  return projectRecordOperationId('analysis',{
    project,
    sourceDir,
    filesCount:analysis.filesCount||0,
    gitRemote:analysis.gitRemote||'',
    lastActivity:analysis.progress?.lastActivity||null,
    scan:{
      complete:analysis.scan?.complete??null,
      reasons:analysis.scan?.reasons||[],
      directoriesVisited:analysis.scan?.directoriesVisited??null,
      maxDepthVisited:analysis.scan?.maxDepthVisited??null
    }
  });
}

async function syncProjectUnlocked({
  appRoot,
  store,
  projectId,
  projectRecordClient=defaultProjectRecordClient
}){
  const state=await store.readState();
  const config=await store.readConfig();
  const project=state.projects.find(item=>item.id===projectId);
  if(!project)throw new Error('项目不存在');
  if(!project.businessId)throw new Error('项目尚未归类');
  const sourceDir=projectPath(appRoot,config,project);
  const available=await directoryAvailable(sourceDir);
  const analysis=available
    ?await analyzeProject(appRoot,config,project)
    :{
      progress:unavailableNarrative(project),
      gitRemote:project.git||'',
      filesCount:0,
      dir:sourceDir,
      scan:{
        complete:false,
        reasons:['project_unavailable'],
        directoriesVisited:0,
        maxDepthVisited:0,
        durationMs:0
      }
    };

  const beforeRemote=await store.readState();
  const beforeRemoteProject=beforeRemote.projects.find(item=>item.id===projectId);
  const beforeRemoteConfig=await store.readConfig();
  if(
    !beforeRemoteProject||
    !sameStoredValue(beforeRemoteProject,project)||
    projectPath(appRoot,beforeRemoteConfig,beforeRemoteProject)!==sourceDir
  )throw staleSyncError();

  const recordedAt=nowIso();
  const projectSnapshotHash=snapshotHash(project);
  let record=null;
  let operationId=null;
  let receipt=null;
  if(projectRecordConfigured(project)){
    operationId=analysisOperationId(project,sourceDir,analysis);
    const pendingMachine=machineProgress(analysis.progress,null);
    await store.writeProjectRecordReceipt({
      operationId,
      kind:'analysis',
      projectId:project.id,
      documentUrl:project.feishu,
      recordedAt,
      projectSnapshotHash,
      machineProgress:pendingMachine,
      phase:'remote_pending'
    });
    try{
      const text=narrativeFromProgress(project,analysis.progress,{kind:'analysis',recordedAt});
      record=await projectRecordClient.appendAnalysis(project.feishu,text,{operationId});
      const committedMachine=machineProgress(analysis.progress,{
        revisionId:record.revisionId,
        item:record.item,
        recordedAt,
        operationId
      });
      receipt=await store.writeProjectRecordReceipt({
        operationId,
        kind:'analysis',
        projectId:project.id,
        documentUrl:project.feishu,
        revisionId:record.revisionId,
        blockId:record.item?.blockId,
        recordedAt,
        projectSnapshotHash,
        machineProgress:committedMachine,
        phase:'remote_saved_local_pending'
      });
    }catch(error){
      await store.deleteProjectRecordReceipt(operationId).catch(()=>{});
      throw error;
    }
  }

  let committed=null;
  try{
    await store.updateState(current=>{
      const currentProject=current.projects.find(item=>item.id===projectId);
      if(!currentProject||!sameStoredValue(currentProject,project))throw staleSyncError();
      const recordPointer=record
        ?{
          revisionId:record.revisionId,
          item:record.item,
          recordedAt,
          operationId
        }
        :null;
      currentProject.progress=machineProgress(analysis.progress,recordPointer);
      if(!currentProject.git&&analysis.gitRemote)currentProject.git=analysis.gitRemote;
      if(record){
        clearProjectRecordConfirmations(current,currentProject.id);
        current.confirmations=current.confirmations.filter(
          item=>!(item.type==='project_record_recovery_pending'&&item.operationId===operationId)
        );
      }else missingFeishuConfirmation(current,currentProject);
      if(
        analysis.progress.confidence<.55&&
        !current.confirmations.some(item=>
          item.type==='progress_unclear'&&item.projectId===currentProject.id
        )
      ){
        current.confirmations.unshift({
          id:newId('cf'),
          type:'progress_unclear',
          projectId:currentProject.id,
          text:`「${currentProject.name}」的进度证据不足，需要你确认。`,
          createdAt:nowIso()
        });
      }
      addActivity(current,{
        type:'project_synced',
        projectId:currentProject.id,
        text:`同步「${currentProject.name}」：${currentProject.progress.percent}% · ${currentProject.progress.status}${record?' · 分析正文已写入飞书':' · 未保存分析正文（未绑定飞书项目文档）'}`
      });
      committed=structuredClone(currentProject);
    });
  }catch(error){
    if(record&&receipt){
      await addRecoveryConfirmation(store,project,receipt);
      throw remoteSavedPendingError(receipt,error);
    }
    throw error;
  }

  if(operationId)await store.deleteProjectRecordReceipt(operationId);
  await rewriteIdentityFor({appRoot,store,projectId});
  return {
    progress:committed?.progress||null,
    machineProgress:committed?.progress||null,
    gitRemote:analysis.gitRemote||'',
    filesCount:analysis.filesCount||0,
    dir:analysis.dir||sourceDir,
    scan:analysis.scan||null,
    record:record
      ?{
        saved:true,
        replayed:Boolean(record.replayed),
        documentUrl:project.feishu,
        revisionId:record.revisionId??null,
        blockId:record.item?.blockId??null,
        recordedAt,
        operationId
      }
      :{
        saved:false,
        documentUrl:project.feishu||null,
        recordedAt:null,
        operationId:null
      }
  };
}

export async function syncProject(args){
  return withProjectSyncLease(args.projectId,()=>syncProjectUnlocked(args));
}

async function syncAllProjectsUnlocked({
  appRoot,
  store,
  projectRecordClient=defaultProjectRecordClient
}){
  const state=await store.readState();
  const results=[];
  for(const project of state.projects.filter(item=>item.businessId&&!item.archived)){
    try{
      const analysis=await syncProjectUnlocked({
        appRoot,
        store,
        projectId:project.id,
        projectRecordClient
      });
      results.push({
        id:project.id,
        ok:true,
        progress:analysis.machineProgress,
        record:analysis.record
      });
    }catch(error){
      if(error?.code==='PROJECT_SYNC_STALE'){
        results.push({id:project.id,ok:false,stale:true,code:error.code});
      }else if(error?.code==='PROJECT_RECORD_REMOTE_SAVED_LOCAL_PENDING'){
        results.push({
          id:project.id,
          ok:false,
          remoteSaved:true,
          code:error.code,
          recovery:error.recovery
        });
      }else{
        await store.updateState(current=>{
          if(!current.confirmations.some(
            item=>item.type==='sync_failed'&&item.projectId===project.id
          )){
            current.confirmations.unshift({
              id:newId('cf'),
              type:'sync_failed',
              projectId:project.id,
              text:`「${project.name}」同步失败：${error.message}`,
              createdAt:nowIso()
            });
          }
        });
        results.push({id:project.id,ok:false,error:error.message});
      }
    }
  }
  return results;
}

export async function syncAllProjects(args){
  return withAllProjectSyncLease(()=>syncAllProjectsUnlocked(args));
}

export async function readProjectRecords({
  store,
  projectId,
  limit,
  beforeBlockId=null,
  projectRecordClient=defaultProjectRecordClient
}){
  const project=await persistedProject(store,projectId);
  if(!project)throw new Error('项目不存在');
  if(!projectRecordConfigured(project)){
    throw Object.assign(new Error('项目尚未绑定有效的飞书项目文档。'),{statusCode:409});
  }
  const pageSize=boundedProjectRecordLimit(limit);
  const records=await projectRecordClient.fetch(project.feishu);
  const latest=[...records.items].reverse();
  let start=0;
  if(beforeBlockId){
    const index=latest.findIndex(item=>item.blockId===beforeBlockId);
    if(index<0)throw badRequest('项目记录游标不存在或已经失效。');
    start=index+1;
  }
  const page=latest.slice(start,start+pageSize);
  const nextCursor=start+page.length<latest.length?page.at(-1)?.blockId||null:null;
  return {
    projectId:project.id,
    documentUrl:project.feishu,
    revisionId:records.revisionId??null,
    nextCursor,
    records:page.map(item=>({
      blockId:item.blockId,
      kind:item.kind,
      operationId:item.operationId||null,
      text:item.text
    }))
  };
}

export async function appendProjectSummary({
  store,
  projectId,
  text,
  projectRecordClient=defaultProjectRecordClient
}){
  const project=await persistedProject(store,projectId);
  if(!project)throw new Error('项目不存在');
  if(!projectRecordConfigured(project)){
    throw Object.assign(new Error('项目尚未绑定有效的飞书项目文档。'),{statusCode:409});
  }
  const value=normalizeProjectRecordText(text);
  const operationId=projectRecordOperationId('summary',{
    projectId,
    documentUrl:project.feishu,
    text:value,
    parentBlockId:project.progress?.feishuRecordBlockId||null
  });
  const recordedAt=nowIso();
  const projectSnapshotHash=snapshotHash({id:project.id,feishu:project.feishu});
  await store.writeProjectRecordReceipt({
    operationId,
    kind:'summary',
    projectId,
    documentUrl:project.feishu,
    recordedAt,
    projectSnapshotHash,
    machineProgress:project.progress||null,
    phase:'remote_pending'
  });

  let result;
  let receipt;
  try{
    result=await projectRecordClient.appendSummary(project.feishu,value,{operationId});
    const nextMachine=machineProgress(project.progress||{},{
      revisionId:result.revisionId,
      item:result.item,
      recordedAt,
      operationId
    });
    receipt=await store.writeProjectRecordReceipt({
      operationId,
      kind:'summary',
      projectId,
      documentUrl:project.feishu,
      revisionId:result.revisionId,
      blockId:result.item?.blockId,
      recordedAt,
      projectSnapshotHash,
      machineProgress:nextMachine,
      phase:'remote_saved_local_pending'
    });
  }catch(error){
    await store.deleteProjectRecordReceipt(operationId).catch(()=>{});
    throw error;
  }

  try{
    await store.updateState(state=>{
      const current=state.projects.find(item=>item.id===projectId);
      if(!current||current.feishu!==project.feishu)throw staleSyncError();
      current.progress=machineProgress(current.progress||{},{
        revisionId:result.revisionId,
        item:result.item,
        recordedAt,
        operationId
      });
      state.confirmations=state.confirmations.filter(
        item=>!(item.type==='project_record_recovery_pending'&&item.operationId===operationId)
      );
      addActivity(state,{
        type:'project_summary_saved',
        projectId,
        text:`「${project.name}」阶段总结已保存到飞书项目文档。`
      });
    });
  }catch(error){
    await addRecoveryConfirmation(store,project,receipt);
    throw remoteSavedPendingError(receipt,error);
  }

  await store.deleteProjectRecordReceipt(operationId);
  return {
    saved:true,
    replayed:Boolean(result.replayed),
    projectId,
    documentUrl:project.feishu,
    revisionId:result.revisionId??null,
    blockId:result.item?.blockId??null,
    recordedAt,
    operationId
  };
}
