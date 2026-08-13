import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { addActivity } from './store.mjs';
import { aiRuntimeConfig, classifyProjectDescription, morningConversation } from './ai.mjs';
import { ensureProjectDir, prepareProjectDir, prepareNewProjectDir, prepareBusinessDirs, stageBusinessDirectoryRename, projectPath, resolveWorkspace, businessById, analyzeProject, defaultProjectName, uniqueProjectFolder, writeProjectMd } from './projects.mjs';
import { newId, nowIso, todayIso, parseDateLike, dueDeltaDays, compactText, sanitizeFolderName } from './utils.mjs';
import { isValidDateOnly } from './validation.mjs';
import { createFeishuJournalClient, FeishuSourceError, sourceConfigured } from './feishu.mjs';

const defaultFeishuJournalClient = createFeishuJournalClient();

function badRequest(message){
  return Object.assign(new Error(message),{statusCode:400,code:'INVALID_REQUEST'});
}

function requirePatchObject(patch,allowedFields,label){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw badRequest(`${label}必须是 JSON 对象。`);
  const keys=Object.keys(patch);
  if(!keys.length)throw badRequest(`${label}不能为空。`);
  const unknown=keys.find(key=>!allowedFields.includes(key));
  if(unknown)throw badRequest(`${label}包含不支持的字段：${unknown}。`);
}

export function projectStatus(project){
  if(project.archived)return '已归档';
  if(project.completed)return '已完成';
  return project.progress?.status||'未启动';
}

function incompleteStatus(progress={}){
  return progress.lastActivity?'进行中':'未启动';
}

function legacyIncompleteProgress(progress={}){
  const status=incompleteStatus(progress);
  const completedText=value=>typeof value==='string'&&/已完成|标记完成|完成状态/.test(value);
  return {
    ...progress,
    percent:Math.min(99,Number.isFinite(progress.percent)?progress.percent:0),
    status,
    summary:completedText(progress.summary)?(status==='进行中'?'项目已恢复为进行中，等待下次主动同步更新进度。':'项目已恢复为未完成，尚未检测到真实工作痕迹。'):progress.summary,
    resume:completedText(progress.resume)?(status==='进行中'?'项目已恢复为进行中；请在需要时主动同步项目进度。':'尚未检测到真实工作痕迹。'):progress.resume,
    blocker:completedText(progress.blocker)?'暂无明确卡点。':progress.blocker
  };
}

function unavailableProgress(project,progress={}){
  const alreadyUnavailable=[progress.summary,progress.resume,progress.blocker].some(value=>typeof value==='string'&&/不存在|不可访问/.test(value));
  const priorPercent=Number.isFinite(progress.percent)?progress.percent:0;
  const priorStatus=progress.status==='已完成'?incompleteStatus(progress):(progress.status||incompleteStatus(progress));
  return {
    ...progress,
    percent:project.completed?100:Math.min(99,priorPercent),
    status:project.completed?'已完成':priorStatus,
    summary:alreadyUnavailable&&progress.summary?progress.summary:'项目目录不存在或不可访问，无法刷新进度。',
    resume:alreadyUnavailable&&progress.resume?progress.resume:'保留上次进度；项目目录恢复可访问后再主动同步。',
    blocker:'项目目录不可访问，需要你确认本地项目路径。',
    confidence:Math.min(.2,Number.isFinite(progress.confidence)?progress.confidence:.2),
    syncedAt:nowIso()
  };
}

function unavailableAnalysis(project,config,appRoot){
  return {
    progress:unavailableProgress(project,project.progress),
    gitRemote:project.git||'',
    filesCount:0,
    dir:projectPath(appRoot,config,project),
    scan:{complete:false,reasons:['project_unavailable'],directoriesVisited:0,maxDepthVisited:0,durationMs:0}
  };
}

async function inspectProjectDirectory(dir){
  if(!dir)return{readable:false,writable:false};
  try{
    const stat=await fsp.lstat(dir);
    if(stat.isSymbolicLink()||!stat.isDirectory())return{readable:false,writable:false};
    await fsp.access(dir,fsConstants.R_OK);
    try{await fsp.access(dir,fsConstants.W_OK);return{readable:true,writable:true};}
    catch{return{readable:true,writable:false};}
  }catch{return{readable:false,writable:false};}
}

function sameStoredValue(left,right){
  return JSON.stringify(left)===JSON.stringify(right);
}

async function rollbackProjectState({store,projectId,before,committed,activity,confirmationId,error,scope}){
  try{
    await store.updateState(state=>{
      const index=state.projects.findIndex(project=>project.id===projectId);
      if(index<0||!sameStoredValue(state.projects[index],committed)){
        const conflict=new Error('项目状态已发生并发变化，拒绝覆盖回滚。');
        conflict.code='PROJECT_ROLLBACK_CONFLICT';
        throw conflict;
      }
      state.projects[index]=structuredClone(before);
      if(activity){
        const activityIndex=state.activities.findIndex(item=>sameStoredValue(item,activity));
        if(activityIndex>=0)state.activities.splice(activityIndex,1);
      }
      if(confirmationId)state.confirmations=state.confirmations.filter(item=>item.id!==confirmationId);
    });
  }catch(rollbackError){
    const combined=new Error(`${scope}失败，且项目状态回滚未完整完成：${rollbackError.message}`,{cause:error});
    combined.code='PROJECT_STATE_ROLLBACK_FAILED';
    throw combined;
  }
  throw error;
}

export function deriveState(appRoot,state,config,aiEnabled=false){
  const today=todayIso();
  const projects=state.projects.map(p=>{
    const biz=businessById(config,p.businessId);
    return {...p,business:biz?.name||'待归类',businessFolder:biz?.folder||null,absPath:biz?projectPath(appRoot,config,p):null,status:projectStatus(p)};
  });
  const active=projects.filter(p=>!p.archived);
  const overdue=active.filter(p=>!p.completed&&p.endDate&&dueDeltaDays(p.endDate)<0&&p.businessId);
  const unclassified=active.filter(p=>!p.businessId);
  const todos=state.todos.map(t=>({...t,project:projects.find(p=>p.id===t.projectId)?.name||null}));
  const todayPlan=state.todayPlanDate===today?state.todayPlan:[];
  const todayTodos=todayPlan.map(id=>todos.find(t=>t.id===id)).filter(Boolean).filter(t=>!t.done);
  return {
    config:{...config,workspaceRootResolved:resolveWorkspace(appRoot,config),dataSource:config.dataSource?{...config.dataSource}:null},
    aiEnabled, aiConfig:aiEnabled?{provider:'openai',...aiRuntimeConfig()}:null, projects, businesses:config.businesses, inbox:state.inbox, todos, todayPlan, todayPlanDate:state.todayPlanDate,
    todayTodos, confirmations:state.confirmations, notes:state.notes, activities:state.activities,
    morningSession: state.morningSessions.find(s=>s.date===today) || null,
    overdue, unclassified,
    stats:{inbox:state.inbox.length,today:todayTodos.length,confirmations:state.confirmations.length,overdue:overdue.length,unclassified:unclassified.length,activeProjects:active.filter(p=>!p.completed).length}
  };
}

export async function createProject({appRoot,store,description,endDate,businessId=null,sourceInboxId}){
  if(typeof description!=='string'||!description.trim()) return {needsFollowup:true,question:'请先讲清楚这个项目是做什么的。'};
  if(!endDate) return {needsFollowup:true,question:'这个项目计划哪一天结束？'};
  if(!isValidDateOnly(endDate))return {needsFollowup:true,question:'计划结束日期必须是合法的 YYYY-MM-DD 日期。'};
  if(typeof sourceInboxId!=='string'||!sourceInboxId.trim())throw badRequest('创建项目必须来自收件箱。请先把项目描述记入收件箱。');
  if(businessId!==null&&(typeof businessId!=='string'||!businessId.trim()))throw badRequest('businessId 必须是非空字符串或 null。');
  const normalizedDescription=description.trim();
  const replayOrConflict=existing=>{
    if(existing.sourceDescription===normalizedDescription&&existing.endDate===endDate)return{project:structuredClone(existing),unclassified:!existing.businessId,replay:true};
    throw Object.assign(new Error('该收件箱事项已用于创建参数不同的项目。'),{statusCode:409});
  };
  const before=await store.readState();
  const existing=before.projects.find(project=>project.sourceInboxId===sourceInboxId);
  if(existing)return replayOrConflict(existing);
  const source=before.inbox.find(item=>item.id===sourceInboxId);
  if(!source)throw Object.assign(new Error('来源收件箱事项不存在或已被处理。'),{statusCode:409});
  if(source.text.trim()!==normalizedDescription)throw Object.assign(new Error('项目描述必须与来源收件箱事项一致。'),{statusCode:409});
  const config=await store.readConfig();
  if(businessId!==null&&!businessById(config,businessId))throw badRequest('业务板块不存在。');
  const ai=await classifyProjectDescription(description,config.businesses);
  const selectedBusiness = businessId ?? (ai?.confidence>=0.72 && businessById(config,ai.businessId) ? ai.businessId : null);
  const name=(ai?.name||defaultProjectName(description)).trim();
  const intro=(ai?.intro||compactText(description,130)).trim();
  const project={
    id:newId('p'),businessId:selectedBusiness,name,intro,createdAt:todayIso(),startDate:todayIso(),endDate,sourceInboxId,sourceDescription:normalizedDescription,
    folder:'',git:'',feishu:'',completed:false,archived:false,
    progress:{percent:0,summary:'项目已建立，但还没有真实工作痕迹。',resume:'尚未检测到真实工作痕迹。',blocker:'暂无明确卡点。',lastActivity:null,status:'未启动',confidence:.9,syncedAt:null}
  };
  let stage=null;
  try{
    return await store.updateState(async state=>{
      const committed=state.projects.find(candidate=>candidate.sourceInboxId===sourceInboxId);
      if(committed)return replayOrConflict(committed);
      const sourceItem=state.inbox.find(item=>item.id===sourceInboxId);
      if(!sourceItem)throw Object.assign(new Error('来源收件箱事项不存在或已被处理。'),{statusCode:409});
      if(sourceItem.text.trim()!==normalizedDescription)throw Object.assign(new Error('项目描述必须与来源收件箱事项一致。'),{statusCode:409});
      project.folder=await uniqueProjectFolder({appRoot,config,projects:state.projects,name,businessId:selectedBusiness});
      if(selectedBusiness)stage=await prepareNewProjectDir(appRoot,config,project);
      state.projects.unshift({...project});
      state.inbox=state.inbox.filter(item=>item.id!==sourceInboxId);
      addActivity(state,{type:'project_created',projectId:project.id,text:`创建项目「${project.name}」${selectedBusiness?'':'，暂放待归类'}`});
      return {project:structuredClone(project),unclassified:!selectedBusiness,replay:false};
    });
  }catch(error){
    try{
      const committed=(await store.readState()).projects.find(candidate=>candidate.sourceInboxId===sourceInboxId);
      if(committed)return replayOrConflict(committed);
    }catch(readbackError){if(readbackError?.statusCode===409)throw readbackError;}
    return rollbackStage(stage,'创建项目',error);
  }
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

async function updateConfigWithPreparedBusinessDirs({appRoot,store,mutate,exclusiveResultFolder=false}){
  let stage=null;
  try{
    return await store.updateConfig(async config=>{
      const result=await mutate(config);
      stage=await prepareBusinessDirs(appRoot,config,{exclusiveFolder:exclusiveResultFolder?result?.folder:null});
      return result;
    });
  }catch(error){return rollbackStage(stage,'保存业务配置',error);}
}

export async function updateWorkbenchConfig({appRoot,store,workspaceRoot,settings,dataSource}){
  return updateConfigWithPreparedBusinessDirs({appRoot,store,mutate:async config=>{
    if(typeof workspaceRoot==='string'&&workspaceRoot.trim())config.workspaceRoot=workspaceRoot.trim();
    if(settings&&typeof settings==='object')config.settings={...config.settings,...settings};
    if(dataSource!==undefined){
      if(dataSource===null)config.dataSource=null;
      else if(dataSource&&dataSource.provider==='feishu_doc'&&typeof dataSource.documentUrl==='string'&&dataSource.documentUrl.trim())config.dataSource={
        provider:'feishu_doc',documentUrl:dataSource.documentUrl.trim(),
        inboxHeading:typeof dataSource.inboxHeading==='string'&&dataSource.inboxHeading.trim()?dataSource.inboxHeading.trim():'收件箱',
        inboxPrefix:typeof dataSource.inboxPrefix==='string'&&dataSource.inboxPrefix.trim()?dataSource.inboxPrefix.trim():'[INBOX]',
        lastRevisionId:config.dataSource?.lastRevisionId??null,lastSyncAt:config.dataSource?.lastSyncAt??null,
        lastSyncStatus:config.dataSource?.lastSyncStatus||'not_synced',lastSyncError:config.dataSource?.lastSyncError||null,
        lastImportedCount:Number.isInteger(config.dataSource?.lastImportedCount)?config.dataSource.lastImportedCount:0
      };
      else throw badRequest('飞书数据源必须包含 provider=feishu_doc 和 documentUrl。');
    }
    return structuredClone(config);
  }});
}

export async function configureDataSource({store,dataSource}){
  if(dataSource===null){
    return store.updateConfig(config=>{config.dataSource=null;return structuredClone(config);});
  }
  if(!dataSource||dataSource.provider!=='feishu_doc'||typeof dataSource.documentUrl!=='string'||!dataSource.documentUrl.trim()){
    throw badRequest('飞书数据源必须包含 provider=feishu_doc 和 documentUrl。');
  }
  const next={
    provider:'feishu_doc',documentUrl:dataSource.documentUrl.trim(),
    inboxHeading:typeof dataSource.inboxHeading==='string'&&dataSource.inboxHeading.trim()?dataSource.inboxHeading.trim():'收件箱',
    inboxPrefix:typeof dataSource.inboxPrefix==='string'&&dataSource.inboxPrefix.trim()?dataSource.inboxPrefix.trim():'[INBOX]',
    lastRevisionId:null,lastSyncAt:null,lastSyncStatus:'not_synced',lastSyncError:null,lastImportedCount:0
  };
  return store.updateConfig(config=>{config.dataSource=next;return structuredClone(config);});
}

function feishuSyncSummary(config,extra={}){
  const source=config?.dataSource;
  return {
    configured:sourceConfigured(source),
    provider:source?.provider||null,
    documentUrl:source?.documentUrl||null,
    revisionId:source?.lastRevisionId??null,
    syncedAt:source?.lastSyncAt??null,
    status:source?.lastSyncStatus||'not_configured',
    importedCount:Number.isInteger(source?.lastImportedCount)?source.lastImportedCount:0,
    ...extra
  };
}

export async function syncFeishuInbox({store,client=defaultFeishuJournalClient}={}){
  const config=await store.readConfig();
  if(!sourceConfigured(config.dataSource))return feishuSyncSummary(config,{imported:0,removed:0,reason:'not_configured'});
  let fetched;
  try{
    fetched=await client.fetch(config.dataSource);
  }catch(error){
    await store.updateConfig(current=>{
      if(current.dataSource){current.dataSource.lastSyncAt=nowIso();current.dataSource.lastSyncStatus='error';current.dataSource.lastSyncError=error instanceof FeishuSourceError?error.message:'飞书文档读取失败';}
      return structuredClone(current);
    }).catch(()=>{});
    throw error;
  }
  const remoteByBlock=new Map(fetched.items.map(item=>[item.blockId,item]));
  let imported=0,removed=0,updated=0;
  await store.updateState(state=>{
    state.inboxAcks=Array.isArray(state.inboxAcks)?state.inboxAcks:[];
    const ackByBlock=new Map(state.inboxAcks.map(item=>[item.blockId,item]));
    const localByBlock=new Map(state.inbox.filter(item=>item.feishuBlockId).map(item=>[item.feishuBlockId,item]));
    for(const remote of fetched.items){
      const local=localByBlock.get(remote.blockId);
      if(local){
        if(local.text!==remote.text){local.text=remote.text;updated+=1;}
        const ack=ackByBlock.get(remote.blockId);if(ack)ack.text=remote.text;
        continue;
      }
      const priorAck=ackByBlock.get(remote.blockId);
      if(priorAck&&priorAck.text===remote.text)continue;
      const item={id:newId('in'),text:remote.text,source:'feishu_doc',feishuBlockId:remote.blockId,createdAt:nowIso()};
      state.inbox.unshift(item);
      if(priorAck)Object.assign(priorAck,{text:remote.text,acknowledgedAt:nowIso()});
      else state.inboxAcks.push({blockId:remote.blockId,text:remote.text,acknowledgedAt:nowIso()});
      imported+=1;
      addActivity(state,{type:'inbox_synced',inboxId:item.id,text:`从飞书收件箱同步：${compactText(remote.text,80)}`});
    }
    for(const local of state.inbox.filter(item=>item.source==='feishu_doc'&&item.feishuBlockId)){
      if(!remoteByBlock.has(local.feishuBlockId)){
        state.inbox=state.inbox.filter(item=>item.id!==local.id);
        removed+=1;
        addActivity(state,{type:'inbox_removed_remote',inboxId:local.id,text:`飞书收件箱已删除：${compactText(local.text,80)}`});
      }
    }
  });
  await store.updateConfig(current=>{
    if(current.dataSource){
      current.dataSource.lastRevisionId=fetched.revisionId===null?null:String(fetched.revisionId);
      current.dataSource.lastSyncAt=nowIso();
      current.dataSource.lastSyncStatus='ok';
      current.dataSource.lastSyncError=null;
      current.dataSource.lastImportedCount=fetched.items.length;
    }
    return structuredClone(current);
  });
  return feishuSyncSummary(await store.readConfig(),{imported,removed,updated,remoteCount:fetched.items.length,sectionFound:fetched.sectionFound});
}

export async function assignProjectBusiness({appRoot,store,projectId,businessId}){
  const config=await store.readConfig(); const biz=businessById(config,businessId); if(!biz)throw new Error('业务板块不存在');
  let project,stage=null;
  try{
    await store.updateState(async state=>{
      const current=state.projects.find(p=>p.id===projectId);if(!current)throw new Error('项目不存在');
      const changed=current.businessId!==businessId;
      const folder=changed?await uniqueProjectFolder({appRoot,config,projects:state.projects,name:current.name,businessId,excludeProjectId:current.id}):current.folder;
      const candidate={...current,businessId,folder};
      // A new classification creates an exclusive, reversible filesystem stage.
      // Re-applying the same classification keeps the existing merge semantics
      // and must never put a pre-existing project directory on a delete list.
      stage=changed
        ?await prepareNewProjectDir(appRoot,config,candidate)
        :await prepareProjectDir(appRoot,config,candidate);
      if(changed){
        current.businessId=businessId;
        current.folder=folder;
        addActivity(state,{type:'project_classified',projectId,text:`「${current.name}」归入「${biz.name}」`});
      }
      project={...current};
    });
    return project;
  }catch(error){return rollbackStage(stage,'归类项目',error);}
}

export async function syncProject({appRoot,store,projectId}){
  const state=await store.readState(); const config=await store.readConfig(); const project=state.projects.find(p=>p.id===projectId); if(!project)throw new Error('项目不存在');
  if(!project.businessId) throw new Error('项目尚未归类');
  const sourceDir=projectPath(appRoot,config,project);
  const directory=await inspectProjectDirectory(sourceDir);
  let analysis;
  if(directory.readable&&directory.writable){
    try{analysis=await analyzeProject(appRoot,config,project);}
    catch{analysis=unavailableAnalysis(project,config,appRoot);}
  }else analysis=unavailableAnalysis(project,config,appRoot);
  await store.updateState(async current=>{
    const p=current.projects.find(x=>x.id===projectId);
    const currentConfig=await store.readConfig();
    if(!p||!sameStoredValue(p,project)||projectPath(appRoot,currentConfig,p)!==sourceDir){
      const stale=new Error('项目在同步期间发生变化，本次过期分析未写入；请重新同步。');
      stale.statusCode=409;
      stale.code='PROJECT_SYNC_STALE';
      throw stale;
    }
    p.progress=analysis.progress;
    if(!p.git&&analysis.gitRemote)p.git=analysis.gitRemote;
    if(analysis.progress.confidence<.55 && !current.confirmations.some(c=>c.type==='progress_unclear'&&c.projectId===p.id)) current.confirmations.unshift({id:newId('cf'),type:'progress_unclear',projectId:p.id,text:`「${p.name}」的进度证据不足，需要你确认。`,createdAt:nowIso()});
    if(directory.readable&&directory.writable)await writeProjectMd(analysis.dir,p,{root:resolveWorkspace(appRoot,config)});
    addActivity(current,{type:'project_synced',projectId:p.id,text:`同步「${p.name}」：${analysis.progress.percent}% · ${analysis.progress.summary}`});
  });
  return analysis;
}

export async function syncAllProjects({appRoot,store}){
  const state=await store.readState(); const results=[];
  for(const p of state.projects.filter(p=>p.businessId&&!p.archived)){
    try{const a=await syncProject({appRoot,store,projectId:p.id});results.push({id:p.id,ok:true,progress:a.progress});}
    catch(e){
      if(e?.code==='PROJECT_SYNC_STALE'){
        results.push({id:p.id,ok:false,stale:true,code:'PROJECT_SYNC_STALE'});
        continue;
      }
      await store.updateState(s=>{if(!s.confirmations.some(c=>c.type==='sync_failed'&&c.projectId===p.id))s.confirmations.unshift({id:newId('cf'),type:'sync_failed',projectId:p.id,text:`「${p.name}」同步失败：${e.message}`,createdAt:nowIso()});});
      results.push({id:p.id,ok:false,error:e.message});
    }
  }
  return results;
}

export async function addInbox({store,text,source='manual',client=defaultFeishuJournalClient}){
  if(!text?.trim())throw new Error('请输入内容');
  const normalized=text.trim();
  const config=await store.readConfig();
  let remote=null;
  if(source!=='feishu_doc'&&sourceConfigured(config.dataSource)){
    remote=await client.appendAndFetch(config.dataSource,normalized);
    source='feishu_doc';
  }
  const item={id:newId('in'),text:normalized,source,createdAt:nowIso(),...(remote?.item?.blockId?{feishuBlockId:remote.item.blockId}:{})};
  await store.updateState(state=>{
    const existing=remote?.item?.blockId&&state.inbox.find(candidate=>candidate.feishuBlockId===remote.item.blockId);
    if(existing){Object.assign(existing,item,{id:existing.id});return;}
    state.inbox.unshift(item);
    if(item.feishuBlockId){
      state.inboxAcks=Array.isArray(state.inboxAcks)?state.inboxAcks:[];
      if(!state.inboxAcks.some(ack=>ack.blockId===item.feishuBlockId))state.inboxAcks.push({blockId:item.feishuBlockId,text:item.text,acknowledgedAt:nowIso()});
    }
    addActivity(state,{type:'inbox_captured',text:`收件箱新增：${compactText(item.text,80)}`,inboxId:item.id});
  });
  return item;
}

function projectCandidatesByCommand(state,command){
  const normalized=command.replace(/\s/g,'');
  const active=state.projects.filter(project=>!project.archived);
  const exact=active.filter(project=>normalized.includes(project.name.replace(/\s/g,'')));
  if(exact.length)return{matches:exact,requiresSelection:exact.length>1};
  const prefix=active.filter(project=>{
    const name=project.name.replace(/\s/g,'');
    return name.length>=4&&normalized.includes(name.slice(0,4));
  });
  return{matches:prefix,requiresSelection:prefix.length>0};
}

function hasNegatedIntent(command,terms){
  return terms.some(term=>new RegExp(`(?:不要|别|不想|不用|不可|不能|禁止)(?:再|把|将|去|要)?[^，。；;！？!?]{0,8}${term}`).test(command));
}

function inboxIntent(command){
  const deleteIntent=/删除|丢弃|不要了/.test(command);
  const memoIntent=/只是备忘|备忘|记录一下|不用变成任务/.test(command);
  const todoIntent=/独立待办/.test(command);
  const projectIntent=/单独建项目|新建项目|建项目/.test(command);
  const negatedDelete=hasNegatedIntent(command,['删除','丢弃']);
  const negatedMemo=hasNegatedIntent(command,['备忘','记录']);
  const negatedTodo=hasNegatedIntent(command,['独立待办']);
  const negatedProject=hasNegatedIntent(command,['单独建项目','新建项目','建项目']);
  const positive=[deleteIntent&&!negatedDelete,memoIntent&&!negatedMemo,todoIntent&&!negatedTodo,projectIntent&&!negatedProject].filter(Boolean).length;
  return{deleteIntent,memoIntent,todoIntent,projectIntent,negatedDelete,negatedMemo,negatedTodo,negatedProject,conflicting:positive>1};
}

const INBOX_ROUTING_CONFIRMATION_TYPES=new Set(['inbox_intent_unclear','inbox_project_ambiguous']);

function clearInboxRoutingConfirmations(state,inboxId){
  state.confirmations=state.confirmations.filter(entry=>!(entry.inboxId===inboxId&&INBOX_ROUTING_CONFIRMATION_TYPES.has(entry.type)));
}

function setInboxRoutingConfirmation(state,{inboxId,type,text}){
  const existing=state.confirmations.find(entry=>entry.inboxId===inboxId&&entry.type===type);
  state.confirmations=state.confirmations.filter(entry=>{
    if(entry.inboxId!==inboxId||!INBOX_ROUTING_CONFIRMATION_TYPES.has(entry.type))return true;
    return entry===existing;
  });
  if(existing){existing.text=text;return existing;}
  const confirmation={id:newId('cf'),type,inboxId,text,createdAt:nowIso()};
  state.confirmations.unshift(confirmation);
  return confirmation;
}

export async function processInbox({store,itemId,command,targetProjectId=null}){
  if(typeof itemId!=='string'||!itemId.trim())throw badRequest('itemId 必须是非空字符串。');
  if(typeof command!=='string')throw badRequest('command 必须是字符串。');
  if(targetProjectId!==null&&(typeof targetProjectId!=='string'||!targetProjectId.trim()))throw badRequest('targetProjectId 必须是非空字符串或 null。');
  if(!command.trim())return{needsFollowup:true,question:'告诉我这条内容要怎么处理。'};
  let response;
  await store.updateState(state=>{
    const item=state.inbox.find(x=>x.id===itemId); if(!item)throw new Error('收件箱事项不存在');
    const explicitProject=targetProjectId?state.projects.find(candidate=>candidate.id===targetProjectId):null;
    if(targetProjectId&&!explicitProject)throw Object.assign(new Error('目标项目不存在。'),{statusCode:400});
    if(explicitProject?.archived)throw Object.assign(new Error('目标项目已归档，不能再接收新的收件箱事项。'),{statusCode:409});
    const c=command.trim(); const due=parseDateLike(c);const intent=inboxIntent(c);
    if(intent.negatedDelete||intent.negatedMemo||intent.negatedTodo||intent.negatedProject||intent.conflicting){
      setInboxRoutingConfirmation(state,{inboxId:itemId,type:'inbox_intent_unclear',text:`收件箱事项「${compactText(item.text,50)}」的处理指令包含否定或多个动作，需要你确认唯一的最终处理方式。`});
      response={needsFollowup:true,question:'这条指令里有否定或多个处理方式。为避免误删、误归类，请只明确一种最终动作。'};return;
    }
    if(due&&!isValidDateOnly(due)){response={needsFollowup:true,question:'识别到的日期无效，请给出一个真实存在的日期。'};return;}
    const {matches,requiresSelection}=projectCandidatesByCommand(state,c);
    if(targetProjectId&&!matches.some(candidate=>candidate.id===targetProjectId))throw Object.assign(new Error('目标项目与当前指令不匹配。'),{statusCode:409});
    const remove=()=>{state.inbox=state.inbox.filter(x=>x.id!==itemId);};
    if(intent.deleteIntent){remove();clearInboxRoutingConfirmations(state,itemId);addActivity(state,{type:'inbox_deleted',text:`删除收件箱：${compactText(item.text,80)}`});response={message:'已删除。'};return;}
    if(intent.memoIntent&&!targetProjectId&&!/(?:放到|归入|放进).+(?:项目|作为)/.test(c)){
      state.notes.unshift({id:newId('n'),text:item.text,createdAt:item.createdAt,projectId:null});remove();clearInboxRoutingConfirmations(state,itemId);addActivity(state,{type:'note_created',text:`保存备忘：${compactText(item.text,80)}`});response={message:'已保存为备忘，没有变成任务。'};return;
    }
    if(intent.todoIntent){
      clearInboxRoutingConfirmations(state,itemId);
      if(!due){response={needsFollowup:true,question:'这个待办的截止日期是哪一天？'};return;}
      const todo={id:newId('td'),title:compactText(item.text,90),context:item.text,dueDate:due,projectId:null,done:false,createdAt:nowIso()};state.todos.unshift(todo);remove();addActivity(state,{type:'todo_created',todoId:todo.id,text:`创建独立待办「${todo.title}」，截止 ${due}`});response={message:`已创建独立待办，截止 ${due}。`,todo};return;
    }
    if(intent.projectIntent){
      clearInboxRoutingConfirmations(state,itemId);
      response={needsProjectCreation:true,description:item.text,parsedEndDate:due,itemId};return;
    }
    if(!targetProjectId&&requiresSelection){
      setInboxRoutingConfirmation(state,{inboxId:itemId,type:'inbox_project_ambiguous',text:`收件箱事项「${compactText(item.text,50)}」的项目名称未能唯一完整匹配，需要你选择目标项目。`});
      response={needsProjectSelection:true,question:'项目名称没有唯一完整匹配，请明确选择目标项目。',projectCandidates:matches.map(project=>({
        id:project.id,name:project.name,businessId:project.businessId,folder:project.folder,endDate:project.endDate
      }))};return;
    }
    const project=explicitProject||(matches[0]||null);
    if(project){
      const clearAmbiguous=()=>clearInboxRoutingConfirmations(state,itemId);
      if(/待办|任务/.test(c)){
        if(!due){response={needsFollowup:true,question:'这个待办的截止日期是哪一天？'};return;}
        const todo={id:newId('td'),title:compactText(item.text,90),context:item.text,dueDate:due,projectId:project.id,done:false,createdAt:nowIso()};state.todos.unshift(todo);remove();clearAmbiguous();addActivity(state,{type:'todo_created',projectId:project.id,todoId:todo.id,text:`在「${project.name}」创建待办「${todo.title}」，截止 ${due}`});response={message:`已放进「${project.name}」并创建待办，截止 ${due}。`,todo};return;
      }
      state.notes.unshift({id:newId('n'),text:item.text,projectId:project.id,createdAt:item.createdAt});remove();clearAmbiguous();addActivity(state,{type:'project_note_created',projectId:project.id,text:`归入「${project.name}」项目记录：${compactText(item.text,80)}`});response={message:`已归入「${project.name}」作为项目记录。`};return;
    }
    setInboxRoutingConfirmation(state,{inboxId:itemId,type:'inbox_intent_unclear',text:`收件箱事项「${compactText(item.text,50)}」还没有明确唯一的处理方式，需要你确认。`});
    response={needsFollowup:true,question:'请明确告诉我：放到哪个项目、做成独立待办、只是备忘、单独建项目，还是删除？'};
  });
  return response;
}

export function morningCandidates(state,config){
  const recentDays=config.settings?.recentDays??3, dueSoon=config.settings?.dueSoonDays??3, now=Date.now(); const items=[];
  for(const p of state.projects.filter(p=>!p.archived&&!p.completed&&p.businessId)){
    const last=Date.parse(p.progress?.lastActivity||0)||0; const recent=last&&(now-last)<=recentDays*86400000; const due=dueDeltaDays(p.endDate);
    if(due<0)continue; // 逾期独立管理
    if(recent||due<=dueSoon)items.push({kind:'project',id:p.id,title:p.name,reason:due<=dueSoon?`距离计划结束 ${due} 天`:`最近 ${recentDays} 天有实际工作`,dueDate:p.endDate,progress:p.progress});
  }
  for(const t of state.todos.filter(t=>!t.done)){
    const recent=(now-(Date.parse(t.createdAt||0)||0))<=recentDays*86400000; const due=dueDeltaDays(t.dueDate);
    if(recent||due<=2)items.push({kind:'todo',id:t.id,title:t.title,reason:due<0?'待办截止日期已过':due<=2?`截止还有 ${due} 天`:`最近 ${recentDays} 天出现`,dueDate:t.dueDate,projectId:t.projectId});
  }
  return items.slice(0,30);
}

export async function morningChat({store,message,sessionId}){
  const state=await store.readState(), config=await store.readConfig();
  let session=state.morningSessions.find(s=>s.id===sessionId);
  if(!session){session={id:newId('ms'),date:todayIso(),messages:[],createdAt:nowIso()};}
  const candidates=morningCandidates(state,config);
  const recent=state.activities.filter(a=>Date.now()-Date.parse(a.at)<=(config.settings?.recentDays??3)*86400000).slice(0,60);
  const result=await morningConversation({recent,projects:candidates.filter(x=>x.kind==='project'),todos:candidates.filter(x=>x.kind==='todo'),message,history:session.messages.slice(-10)});
  const fallbackReply=candidates.length?`我先把值得你今天讨论的事情摆出来：${candidates.slice(0,5).map(x=>`「${x.title}」(${x.reason})`).join('；')}。你决定今天哪些真正进入工作台。`:'最近 3 天和临近截止事项里，没有必须主动提出来的内容。';
  const reply=result?.reply||fallbackReply;
  session.messages.push({role:'user',text:message||'帮我过一下今天。',at:nowIso()},{role:'assistant',text:reply,at:nowIso()});
  await store.updateState(s=>{
    const i=s.morningSessions.findIndex(x=>x.id===session.id);if(i>=0)s.morningSessions[i]=session;else s.morningSessions.unshift(session);
    s.morningSessions=s.morningSessions.slice(0,30);
    addActivity(s,{type:'morning_chat',text:'完成一次早晨工作对焦对话'});
  });
  return {sessionId:session.id,reply,candidates,mentionedIds:result?.mentionedIds||[]};
}

export async function setToday({store,todoId,add}){
  if(typeof todoId!=='string'||!todoId.trim())throw badRequest('todoId 必须是非空字符串。');
  if(typeof add!=='boolean')throw badRequest('add 必须是布尔值。');
  return store.updateState(state=>{
    const todo=state.todos.find(t=>t.id===todoId);if(!todo)throw new Error('待办不存在');
    const date=todayIso();
    if(state.todayPlanDate!==date){state.todayPlan=[];state.todayPlanDate=date;}
    if(add){if(!state.todayPlan.includes(todoId))state.todayPlan.push(todoId);}else state.todayPlan=state.todayPlan.filter(id=>id!==todoId);
    addActivity(state,{type:add?'today_added':'today_removed',todoId,text:`${add?'加入':'移出'}今日工作台：「${todo.title}」`});
    return state.todayPlan;
  });
}

export async function updateTodo({store,todoId,patch}){
  if(typeof todoId!=='string'||!todoId.trim())throw badRequest('todoId 必须是非空字符串。');
  requirePatchObject(patch,['title','context','dueDate','done'],'待办更新内容');
  if(Object.hasOwn(patch,'title')&&(typeof patch.title!=='string'||!patch.title.trim()))throw badRequest('title 必须是非空字符串。');
  if(Object.hasOwn(patch,'context')&&typeof patch.context!=='string')throw badRequest('context 必须是字符串。');
  if(Object.hasOwn(patch,'dueDate')&&!isValidDateOnly(patch.dueDate))throw badRequest('dueDate 必须是合法的 YYYY-MM-DD 日期。');
  if(Object.hasOwn(patch,'done')&&typeof patch.done!=='boolean')throw badRequest('done 必须是布尔值。');
  return store.updateState(state=>{
    const t=state.todos.find(x=>x.id===todoId);if(!t)throw new Error('待办不存在');
    if(Object.hasOwn(patch,'title'))t.title=patch.title.trim();
    if(Object.hasOwn(patch,'context'))t.context=patch.context.trim();
    if(Object.hasOwn(patch,'dueDate'))t.dueDate=patch.dueDate;
    if(Object.hasOwn(patch,'done')){t.done=patch.done;if(t.done)state.todayPlan=state.todayPlan.filter(id=>id!==t.id);}
    addActivity(state,{type:'todo_updated',todoId,text:`更新待办「${t.title}」${t.done?'（已完成）':''}`});return t;
  });
}

export async function updateProject({appRoot,store,projectId,patch}){
  if(typeof projectId!=='string'||!projectId.trim())throw badRequest('projectId 必须是非空字符串。');
  requirePatchObject(patch,['intro','git','feishu','completed','archived','endDate'],'项目更新内容');
  for(const field of ['intro','git','feishu'])if(Object.hasOwn(patch,field)&&typeof patch[field]!=='string')throw badRequest(`${field} 必须是字符串。`);
  for(const field of ['completed','archived'])if(Object.hasOwn(patch,field)&&typeof patch[field]!=='boolean')throw badRequest(`${field} 必须是布尔值。`);
  if(Object.hasOwn(patch,'endDate')&&!isValidDateOnly(patch.endDate))throw badRequest('endDate 必须是合法的 YYYY-MM-DD 日期。');
  const config=await store.readConfig();let updated,before,activity;
  await store.updateState(state=>{
    const p=state.projects.find(x=>x.id===projectId);if(!p)throw new Error('项目不存在');
    before=structuredClone(p);
    for(const k of ['intro','git','feishu'])if(Object.hasOwn(patch,k))p[k]=patch[k].trim();
    if(Object.hasOwn(patch,'completed')){
      const wasCompleted=p.completed===true;
      p.completed=patch.completed;
      if(p.completed){
        if(!wasCompleted)p.progressBeforeCompletion=structuredClone(p.progress||{});
        p.progress={...(p.progress||{}),percent:100,status:'已完成',summary:'项目已标记完成。',resume:'项目已完成。',blocker:'暂无明确卡点。'};
      }else if(wasCompleted){
        p.progress=p.progressBeforeCompletion&&typeof p.progressBeforeCompletion==='object'&&!Array.isArray(p.progressBeforeCompletion)
          ?structuredClone(p.progressBeforeCompletion)
          :legacyIncompleteProgress(p.progress||{});
        delete p.progressBeforeCompletion;
      }
    }
    if(Object.hasOwn(patch,'archived'))p.archived=patch.archived;
    // Baseline dates are not silently changed. Explicit project edit is required.
    if(Object.hasOwn(patch,'endDate'))p.endDate=patch.endDate;
    updated=structuredClone(p);
    addActivity(state,{type:'project_updated',projectId,text:`更新项目「${p.name}」`});
    activity=structuredClone(state.activities[0]);
  });
  try{if(updated.businessId)await ensureProjectDir(appRoot,config,updated);}
  catch(error){return rollbackProjectState({store,projectId,before,committed:updated,activity,error,scope:'更新 PROJECT.md'});}
  return updated;
}

export async function createBusiness({appRoot,store,name}){
  if(!name?.trim())throw new Error('请输入业务板块名称');
  return updateConfigWithPreparedBusinessDirs({appRoot,store,exclusiveResultFolder:true,mutate:async config=>{
    if(config.businesses.some(b=>b.name===name.trim()))throw new Error('同名业务板块已存在');
    const index=config.businesses.length+1;const biz={id:newId('biz'),name:name.trim(),folder:`${String(index).padStart(2,'0')}_${sanitizeFolderName(name)}`};config.businesses.push(biz);return biz;
  }});
}

export async function renameBusiness({appRoot,store,businessId,name}){
  if(!name?.trim())throw new Error('请输入新名称');
  let stage=null;
  try{
    return await store.updateConfig(async config=>{
      const existing=config.businesses.find(x=>x.id===businessId);if(!existing)throw new Error('业务板块不存在');
      if(config.businesses.some(b=>b.id!==businessId&&b.name===name.trim()))throw new Error('同名业务板块已存在');
      const prefix=(existing.folder.match(/^(\d+)_/)||[])[1]||String(config.businesses.indexOf(existing)+1).padStart(2,'0');
      const newFolder=`${prefix}_${sanitizeFolderName(name)}`;
      if(config.businesses.some(b=>b.id!==businessId&&b.folder===newFolder))throw new Error('新的业务目录与其他板块冲突，请换一个名称。');
      stage=await stageBusinessDirectoryRename(appRoot,config,existing.folder,newFolder);
      existing.name=name.trim();existing.folder=newFolder;return {...existing};
    });
  }catch(error){return rollbackStage(stage,'业务板块改名',error);}
}

export async function deleteBusiness({store,businessId}){
  return store.updateConfig(async config=>{
    const state=await store.readState();if(state.projects.some(p=>p.businessId===businessId))throw new Error('该业务板块下还有项目，不能删除。先移动或归档这些项目。');
    const before=config.businesses.length;config.businesses=config.businesses.filter(b=>b.id!==businessId);if(config.businesses.length===before)throw new Error('业务板块不存在');return true;
  });
}
