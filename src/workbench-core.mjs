import { addActivity } from './store.mjs';
import { aiRuntimeConfig, morningConversation } from './ai.mjs';
import { prepareBusinessDirs, stageBusinessDirectoryRename, projectPath, resolveWorkspace, businessById } from './projects.mjs';
import { newId, nowIso, todayIso, parseDateLike, dueDeltaDays, compactText, sanitizeFolderName } from './utils.mjs';
import { isValidDateOnly } from './validation.mjs';
import { createFeishuJournalClient, FeishuSourceError, sourceConfigured } from './feishu.mjs';

const defaultFeishuJournalClient=createFeishuJournalClient();

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

export function deriveState(appRoot,state,config,aiEnabled=false){
  const today=todayIso();
  const projects=state.projects.map(project=>{
    const business=businessById(config,project.businessId);
    return {
      ...project,
      business:business?.name||'待归类',
      businessFolder:business?.folder||null,
      absPath:business?projectPath(appRoot,config,project):null,
      status:projectStatus(project)
    };
  });
  const active=projects.filter(project=>!project.archived);
  const overdue=active.filter(project=>!project.completed&&project.endDate&&dueDeltaDays(project.endDate)<0&&project.businessId);
  const unclassified=active.filter(project=>!project.businessId);
  const todos=state.todos.map(todo=>{
    const project=todo.projectId?projects.find(p=>p.id===todo.projectId):null;
    const businessId=todo.businessId||(project?.businessId||null);
    const business=businessId?businessById(config,businessId):null;
    return {...todo,project:project?.name||null,businessId,business:business?.name||null};
  });
  const todayPlan=state.todayPlanDate===today?state.todayPlan:[];
  const todayTodos=todayPlan.map(id=>todos.find(todo=>todo.id===id)).filter(Boolean).filter(todo=>!todo.done);
  return {
    config:{...config,workspaceRootResolved:resolveWorkspace(appRoot,config),dataSource:config.dataSource?{...config.dataSource}:null},
    aiEnabled,
    aiConfig:aiEnabled?aiRuntimeConfig():null,
    projects,
    businesses:config.businesses,
    inbox:state.inbox,
    todos,
    todayPlan,
    todayPlanDate:state.todayPlanDate,
    todayTodos,
    confirmations:state.confirmations,
    notes:state.notes,
    activities:state.activities,
    morningSession:state.morningSessions.find(session=>session.date===today)||null,
    overdue,
    unclassified,
    stats:{
      inbox:state.inbox.length,
      today:todayTodos.length,
      confirmations:state.confirmations.length,
      overdue:overdue.length,
      unclassified:unclassified.length,
      activeProjects:active.filter(project=>!project.completed).length
    }
  };
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
      else if(dataSource&&dataSource.provider==='feishu_doc'&&typeof dataSource.documentUrl==='string'&&dataSource.documentUrl.trim()){
        config.dataSource={
          provider:'feishu_doc',
          documentUrl:dataSource.documentUrl.trim(),
          inboxHeading:typeof dataSource.inboxHeading==='string'&&dataSource.inboxHeading.trim()?dataSource.inboxHeading.trim():'收件箱',
          inboxPrefix:typeof dataSource.inboxPrefix==='string'&&dataSource.inboxPrefix.trim()?dataSource.inboxPrefix.trim():'[INBOX]',
          lastRevisionId:config.dataSource?.lastRevisionId??null,
          lastSyncAt:config.dataSource?.lastSyncAt??null,
          lastSyncStatus:config.dataSource?.lastSyncStatus||'not_synced',
          lastSyncError:config.dataSource?.lastSyncError||null,
          lastImportedCount:Number.isInteger(config.dataSource?.lastImportedCount)?config.dataSource.lastImportedCount:0
        };
      }else throw badRequest('飞书数据源必须包含 provider=feishu_doc 和 documentUrl。');
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
    provider:'feishu_doc',
    documentUrl:dataSource.documentUrl.trim(),
    inboxHeading:typeof dataSource.inboxHeading==='string'&&dataSource.inboxHeading.trim()?dataSource.inboxHeading.trim():'收件箱',
    inboxPrefix:typeof dataSource.inboxPrefix==='string'&&dataSource.inboxPrefix.trim()?dataSource.inboxPrefix.trim():'[INBOX]',
    lastRevisionId:null,
    lastSyncAt:null,
    lastSyncStatus:'not_synced',
    lastSyncError:null,
    lastImportedCount:0
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
      if(current.dataSource){
        current.dataSource.lastSyncAt=nowIso();
        current.dataSource.lastSyncStatus='error';
        current.dataSource.lastSyncError=error instanceof FeishuSourceError?error.message:'飞书文档读取失败';
      }
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
        const ack=ackByBlock.get(remote.blockId);
        if(ack)ack.text=remote.text;
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
        state.confirmations=state.confirmations.filter(item=>item.inboxId!==local.id);
        removed+=1;
        addActivity(state,{type:'inbox_removed_remote',inboxId:local.id,text:'飞书收件箱已删除一个未处理事项。'});
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

function businessCandidatesByCommand(config,command){
  const normalized=command.replace(/\s/g,'');
  const businesses=config?.businesses||[];
  const matches=businesses.filter(biz=>{
    const name=biz.name.replace(/\s/g,'');
    return name.length>=2&&normalized.includes(name);
  });
  return matches;
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
  const config=await store.readConfig();
  let response;
  await store.updateState(state=>{
    const item=state.inbox.find(candidate=>candidate.id===itemId);
    if(!item)throw new Error('收件箱事项不存在');
    const explicitProject=targetProjectId?state.projects.find(candidate=>candidate.id===targetProjectId):null;
    if(targetProjectId&&!explicitProject)throw Object.assign(new Error('目标项目不存在。'),{statusCode:400});
    if(explicitProject?.archived)throw Object.assign(new Error('目标项目已归档，不能再接收新的收件箱事项。'),{statusCode:409});
    const instruction=command.trim();
    const due=parseDateLike(instruction);
    const intent=inboxIntent(instruction);
    if(intent.negatedDelete||intent.negatedMemo||intent.negatedTodo||intent.negatedProject||intent.conflicting){
      setInboxRoutingConfirmation(state,{inboxId:itemId,type:'inbox_intent_unclear',text:`收件箱事项「${compactText(item.text,50)}」的处理指令包含否定或多个动作，需要你确认唯一的最终处理方式。`});
      response={needsFollowup:true,question:'这条指令里有否定或多个处理方式。为避免误删、误归类，请只明确一种最终动作。'};
      return;
    }
    if(due&&!isValidDateOnly(due)){
      response={needsFollowup:true,question:'识别到的日期无效，请给出一个真实存在的日期。'};
      return;
    }
    const {matches,requiresSelection}=projectCandidatesByCommand(state,instruction);
    if(targetProjectId&&!matches.some(candidate=>candidate.id===targetProjectId))throw Object.assign(new Error('目标项目与当前指令不匹配。'),{statusCode:409});
    const remove=()=>{state.inbox=state.inbox.filter(candidate=>candidate.id!==itemId);};
    if(intent.deleteIntent){
      remove();clearInboxRoutingConfirmations(state,itemId);
      addActivity(state,{type:'inbox_deleted',text:`删除收件箱：${compactText(item.text,80)}`});
      response={message:'已删除。'};
      return;
    }
    if(intent.memoIntent&&!targetProjectId&&!/(?:放到|归入|放进).+(?:项目|作为)/.test(instruction)){
      state.notes.unshift({id:newId('n'),text:item.text,createdAt:item.createdAt,projectId:null});
      remove();clearInboxRoutingConfirmations(state,itemId);
      addActivity(state,{type:'note_created',text:`保存备忘：${compactText(item.text,80)}`});
      response={message:'已保存为备忘，没有变成任务。'};
      return;
    }
    if(intent.todoIntent){
      clearInboxRoutingConfirmations(state,itemId);
      if(!due){response={needsFollowup:true,question:'这个待办的截止日期是哪一天？'};return;}
      const bizMatches=businessCandidatesByCommand(config,instruction);
      const businessId=bizMatches.length===1?bizMatches[0].id:null;
      const todo={id:newId('td'),title:compactText(item.text,90),context:item.text,dueDate:due,projectId:null,businessId,done:false,createdAt:nowIso()};
      state.todos.unshift(todo);remove();
      addActivity(state,{type:'todo_created',todoId:todo.id,text:`创建独立待办「${todo.title}」，截止 ${due}${businessId?` · 归入「${bizMatches[0].name}」`:''}`});
      response={message:`已创建独立待办，截止 ${due}${businessId?`，已归入「${bizMatches[0].name}」业务板块`:''}。`,todo};
      return;
    }
    if(intent.projectIntent){
      clearInboxRoutingConfirmations(state,itemId);
      response={needsProjectCreation:true,description:item.text,parsedEndDate:due,itemId};
      return;
    }
    if(!targetProjectId&&requiresSelection){
      setInboxRoutingConfirmation(state,{inboxId:itemId,type:'inbox_project_ambiguous',text:`收件箱事项「${compactText(item.text,50)}」的项目名称未能唯一完整匹配，需要你选择目标项目。`});
      response={
        needsProjectSelection:true,
        question:'项目名称没有唯一完整匹配，请明确选择目标项目。',
        projectCandidates:matches.map(project=>({id:project.id,name:project.name,businessId:project.businessId,folder:project.folder,endDate:project.endDate}))
      };
      return;
    }
    const project=explicitProject||(matches[0]||null);
    if(project){
      if(/待办|任务/.test(instruction)){
        if(!due){response={needsFollowup:true,question:'这个待办的截止日期是哪一天？'};return;}
        const todo={id:newId('td'),title:compactText(item.text,90),context:item.text,dueDate:due,projectId:project.id,businessId:project.businessId||null,done:false,createdAt:nowIso()};
        state.todos.unshift(todo);remove();clearInboxRoutingConfirmations(state,itemId);
        addActivity(state,{type:'todo_created',projectId:project.id,todoId:todo.id,text:`在「${project.name}」创建待办「${todo.title}」，截止 ${due}`});
        response={message:`已放进「${project.name}」并创建待办，截止 ${due}。`,todo};
        return;
      }
      state.notes.unshift({id:newId('n'),text:item.text,projectId:project.id,createdAt:item.createdAt});
      remove();clearInboxRoutingConfirmations(state,itemId);
      addActivity(state,{type:'project_note_created',projectId:project.id,text:`归入「${project.name}」项目记录：${compactText(item.text,80)}`});
      response={message:`已归入「${project.name}」作为项目记录。`};
      return;
    }
    setInboxRoutingConfirmation(state,{inboxId:itemId,type:'inbox_intent_unclear',text:`收件箱事项「${compactText(item.text,50)}」还没有明确唯一的处理方式，需要你确认。`});
    response={needsFollowup:true,question:'请明确告诉我：放到哪个项目、做成独立待办、只是备忘、单独建项目，还是删除？'};
  });
  return response;
}

export function morningCandidates(state,config){
  const recentDays=config.settings?.recentDays??3;
  const dueSoon=config.settings?.dueSoonDays??3;
  const now=Date.now();
  const items=[];
  for(const project of state.projects.filter(project=>!project.archived&&!project.completed&&project.businessId)){
    const last=Date.parse(project.progress?.lastActivity||0)||0;
    const recent=last&&(now-last)<=recentDays*86400000;
    const due=dueDeltaDays(project.endDate);
    if(due<0)continue;
    if(recent||due<=dueSoon){
      items.push({kind:'project',id:project.id,title:project.name,reason:due<=dueSoon?`距离计划结束 ${due} 天`:`最近 ${recentDays} 天有实际工作`,dueDate:project.endDate,progress:project.progress});
    }
  }
  for(const todo of state.todos.filter(todo=>!todo.done)){
    const recent=(now-(Date.parse(todo.createdAt||0)||0))<=recentDays*86400000;
    const due=dueDeltaDays(todo.dueDate);
    if(recent||due<=2){
      items.push({kind:'todo',id:todo.id,title:todo.title,reason:due<0?'待办截止日期已过':due<=2?`截止还有 ${due} 天`:`最近 ${recentDays} 天出现`,dueDate:todo.dueDate,projectId:todo.projectId});
    }
  }
  return items.slice(0,30);
}

export async function morningChat({store,message,sessionId}){
  const state=await store.readState();
  const config=await store.readConfig();
  let session=state.morningSessions.find(candidate=>candidate.id===sessionId);
  if(!session)session={id:newId('ms'),date:todayIso(),messages:[],createdAt:nowIso()};
  const candidates=morningCandidates(state,config);
  const recent=state.activities.filter(activity=>Date.now()-Date.parse(activity.at)<=(config.settings?.recentDays??3)*86400000).slice(0,60);
  const result=await morningConversation({
    recent,
    projects:candidates.filter(candidate=>candidate.kind==='project'),
    todos:candidates.filter(candidate=>candidate.kind==='todo'),
    message,
    history:session.messages.slice(-10)
  });
  const fallbackReply=candidates.length
    ?`我先把值得你今天讨论的事情摆出来：${candidates.slice(0,5).map(candidate=>`「${candidate.title}」(${candidate.reason})`).join('；')}。你决定今天哪些真正进入工作台。`
    :'最近 3 天和临近截止事项里，没有必须主动提出来的内容。';
  const reply=result?.reply||fallbackReply;
  session.messages.push(
    {role:'user',text:message||'帮我过一下今天。',at:nowIso()},
    {role:'assistant',text:reply,at:nowIso()}
  );
  await store.updateState(current=>{
    const index=current.morningSessions.findIndex(candidate=>candidate.id===session.id);
    if(index>=0)current.morningSessions[index]=session;
    else current.morningSessions.unshift(session);
    current.morningSessions=current.morningSessions.slice(0,30);
    addActivity(current,{type:'morning_chat',text:'完成一次早晨工作对焦对话'});
  });
  return{sessionId:session.id,reply,candidates,mentionedIds:result?.mentionedIds||[]};
}

export async function setToday({store,todoId,add}){
  if(typeof todoId!=='string'||!todoId.trim())throw badRequest('todoId 必须是非空字符串。');
  if(typeof add!=='boolean')throw badRequest('add 必须是布尔值。');
  return store.updateState(state=>{
    const todo=state.todos.find(candidate=>candidate.id===todoId);
    if(!todo)throw new Error('待办不存在');
    const date=todayIso();
    if(state.todayPlanDate!==date){state.todayPlan=[];state.todayPlanDate=date;}
    if(add){if(!state.todayPlan.includes(todoId))state.todayPlan.push(todoId);}
    else state.todayPlan=state.todayPlan.filter(id=>id!==todoId);
    addActivity(state,{type:add?'today_added':'today_removed',todoId,text:`${add?'加入':'移出'}今日工作台：「${todo.title}」`});
    return state.todayPlan;
  });
}

export async function updateTodo({store,todoId,patch}){
  if(typeof todoId!=='string'||!todoId.trim())throw badRequest('todoId 必须是非空字符串。');
  requirePatchObject(patch,['title','context','dueDate','done','businessId'],'待办更新内容');
  if(Object.hasOwn(patch,'title')&&(typeof patch.title!=='string'||!patch.title.trim()))throw badRequest('title 必须是非空字符串。');
  if(Object.hasOwn(patch,'context')&&typeof patch.context!=='string')throw badRequest('context 必须是字符串。');
  if(Object.hasOwn(patch,'dueDate')&&!isValidDateOnly(patch.dueDate))throw badRequest('dueDate 必须是合法的 YYYY-MM-DD 日期。');
  if(Object.hasOwn(patch,'done')&&typeof patch.done!=='boolean')throw badRequest('done 必须是布尔值。');
  if(Object.hasOwn(patch,'businessId')&&patch.businessId!==null&&(typeof patch.businessId!=='string'||!patch.businessId.trim()))throw badRequest('businessId 必须是非空字符串或 null。');
  return store.updateState(state=>{
    const todo=state.todos.find(candidate=>candidate.id===todoId);
    if(!todo)throw new Error('待办不存在');
    if(Object.hasOwn(patch,'title'))todo.title=patch.title.trim();
    if(Object.hasOwn(patch,'context'))todo.context=patch.context.trim();
    if(Object.hasOwn(patch,'dueDate'))todo.dueDate=patch.dueDate;
    if(Object.hasOwn(patch,'businessId'))todo.businessId=patch.businessId;
    if(Object.hasOwn(patch,'done')){
      todo.done=patch.done;
      if(todo.done)state.todayPlan=state.todayPlan.filter(id=>id!==todo.id);
    }
    addActivity(state,{type:'todo_updated',todoId,text:`更新待办「${todo.title}」${todo.done?'（已完成）':''}`});
    return todo;
  });
}

export async function createBusiness({appRoot,store,name}){
  if(!name?.trim())throw new Error('请输入业务板块名称');
  return updateConfigWithPreparedBusinessDirs({
    appRoot,
    store,
    exclusiveResultFolder:true,
    mutate:async config=>{
      if(config.businesses.some(business=>business.name===name.trim()))throw new Error('同名业务板块已存在');
      const index=config.businesses.length+1;
      const business={id:newId('biz'),name:name.trim(),folder:`${String(index).padStart(2,'0')}_${sanitizeFolderName(name)}`};
      config.businesses.push(business);
      return business;
    }
  });
}

export async function renameBusiness({appRoot,store,businessId,name}){
  if(!name?.trim())throw new Error('请输入新名称');
  let stage=null;
  try{
    return await store.updateConfig(async config=>{
      const existing=config.businesses.find(business=>business.id===businessId);
      if(!existing)throw new Error('业务板块不存在');
      if(config.businesses.some(business=>business.id!==businessId&&business.name===name.trim()))throw new Error('同名业务板块已存在');
      const prefix=(existing.folder.match(/^(\d+)_/)||[])[1]||String(config.businesses.indexOf(existing)+1).padStart(2,'0');
      const newFolder=`${prefix}_${sanitizeFolderName(name)}`;
      if(config.businesses.some(business=>business.id!==businessId&&business.folder===newFolder))throw new Error('新的业务目录与其他板块冲突，请换一个名称。');
      stage=await stageBusinessDirectoryRename(appRoot,config,existing.folder,newFolder);
      existing.name=name.trim();
      existing.folder=newFolder;
      return{...existing};
    });
  }catch(error){return rollbackStage(stage,'业务板块改名',error);}
}

export async function deleteBusiness({store,businessId}){
  return store.updateConfig(async config=>{
    const state=await store.readState();
    if(state.projects.some(project=>project.businessId===businessId))throw new Error('该业务板块下还有项目，不能删除。先移动或归档这些项目。');
    const before=config.businesses.length;
    config.businesses=config.businesses.filter(business=>business.id!==businessId);
    if(config.businesses.length===before)throw new Error('业务板块不存在');
    return true;
  });
}
