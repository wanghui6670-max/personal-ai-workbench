import {addActivity} from './store.mjs';
import {processInbox as baseProcessInbox,updateTodo as baseUpdateTodo} from './workbench-core.mjs';
import {newId,nowIso,parseDateLike,compactText} from './utils.mjs';
import {isValidDateOnly} from './validation.mjs';
import {
  clearGetnoteSourceDecision,
  getnoteTodoLinkFields,
  isGetnoteInboxItem,
  recordGetnoteSourceDecision
} from './external-task-decisions.mjs';

function badRequest(message){return Object.assign(new Error(message),{statusCode:400,code:'INVALID_REQUEST'});}

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

const ROUTING_CONFIRMATION_TYPES=new Set(['inbox_intent_unclear','inbox_project_ambiguous']);

function clearRoutingConfirmations(state,inboxId){
  state.confirmations=state.confirmations.filter(entry=>!(entry.inboxId===inboxId&&ROUTING_CONFIRMATION_TYPES.has(entry.type)));
}

function setRoutingConfirmation(state,{inboxId,type,text}){
  const existing=state.confirmations.find(entry=>entry.inboxId===inboxId&&entry.type===type);
  state.confirmations=state.confirmations.filter(entry=>{
    if(entry.inboxId!==inboxId||!ROUTING_CONFIRMATION_TYPES.has(entry.type))return true;
    return entry===existing;
  });
  if(existing){existing.text=text;return existing;}
  const confirmation={id:newId('cf'),type,inboxId,text,createdAt:nowIso()};
  state.confirmations.unshift(confirmation);
  return confirmation;
}

function getnoteTitle(item){
  const raw=String(item.text||'');
  return compactText(raw.split('｜来自得到大脑《')[0]||raw,90);
}

function getnoteTodo(item,{dueDate,projectId=null}){
  return{
    id:item.workbenchEntityId||item.id||newId('td'),
    title:getnoteTitle(item),
    context:item.text||'',
    dueDate,
    dueAt:dueDate,
    startAt:null,
    allDay:true,
    timeZone:item.timeZone||'Asia/Shanghai',
    projectId,
    done:false,
    createdAt:item.workbenchCreatedAt||item.createdAt||nowIso(),
    priority:Number.isFinite(item.localPriority)?item.localPriority:0,
    priorityLabel:item.localPriorityLabel||'',
    tags:Array.isArray(item.localTags)?item.localTags:[],
    ...getnoteTodoLinkFields(item)
  };
}

async function processGetnoteInbox({store,itemId,command,targetProjectId=null}){
  let response;
  await store.updateState(state=>{
    const item=state.inbox.find(candidate=>candidate.id===itemId);
    if(!item)throw new Error('收件箱事项不存在');
    if(!isGetnoteInboxItem(item))throw Object.assign(new Error('GetNote 收件箱事项已变化，请刷新后重试。'),{statusCode:409});
    const explicitProject=targetProjectId?state.projects.find(candidate=>candidate.id===targetProjectId):null;
    if(targetProjectId&&!explicitProject)throw Object.assign(new Error('目标项目不存在。'),{statusCode:400});
    if(explicitProject?.archived)throw Object.assign(new Error('目标项目已归档，不能再接收新的收件箱事项。'),{statusCode:409});

    const instruction=command.trim();
    const due=parseDateLike(instruction);
    const intent=inboxIntent(instruction);
    if(intent.negatedDelete||intent.negatedMemo||intent.negatedTodo||intent.negatedProject||intent.conflicting){
      setRoutingConfirmation(state,{inboxId:itemId,type:'inbox_intent_unclear',text:`收件箱事项「${compactText(item.text,50)}」的处理指令包含否定或多个动作，需要你确认唯一的最终处理方式。`});
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
      recordGetnoteSourceDecision(state,item,'dismissed');
      remove();clearRoutingConfirmations(state,itemId);
      addActivity(state,{type:'inbox_deleted',text:`删除 GetNote 收件箱来源事项：${compactText(item.text,80)}`});
      response={message:'已删除；同一 GetNote 来源身份不会在后续同步中重新出现。'};
      return;
    }
    if(intent.memoIntent&&!targetProjectId&&!/(?:放到|归入|放进).+(?:项目|作为)/.test(instruction)){
      state.notes.unshift({id:newId('n'),text:item.text,createdAt:item.createdAt,projectId:null});
      recordGetnoteSourceDecision(state,item,'memo');
      remove();clearRoutingConfirmations(state,itemId);
      addActivity(state,{type:'note_created',text:`保存 GetNote 来源备忘：${compactText(item.text,80)}`});
      response={message:'已保存为备忘，没有变成任务。'};
      return;
    }
    if(intent.todoIntent){
      clearRoutingConfirmations(state,itemId);
      if(!due){response={needsFollowup:true,question:'这个待办的截止日期是哪一天？'};return;}
      clearGetnoteSourceDecision(state,item.externalTaskId);
      const todo=getnoteTodo(item,{dueDate:due});
      state.todos=state.todos.filter(candidate=>candidate.id!==todo.id);
      state.todos.unshift(todo);remove();
      addActivity(state,{type:'todo_created',todoId:todo.id,text:`创建 GetNote 来源独立待办「${todo.title}」，用户截止 ${due}`});
      response={message:`已创建独立待办，截止 ${due}。`,todo};
      return;
    }
    if(intent.projectIntent){
      clearRoutingConfirmations(state,itemId);
      response={needsProjectCreation:true,description:item.text,parsedEndDate:due,itemId};
      return;
    }
    if(!targetProjectId&&requiresSelection){
      setRoutingConfirmation(state,{inboxId:itemId,type:'inbox_project_ambiguous',text:`收件箱事项「${compactText(item.text,50)}」的项目名称未能唯一完整匹配，需要你选择目标项目。`});
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
        clearGetnoteSourceDecision(state,item.externalTaskId);
        const todo=getnoteTodo(item,{dueDate:due,projectId:project.id});
        state.todos=state.todos.filter(candidate=>candidate.id!==todo.id);
        state.todos.unshift(todo);remove();clearRoutingConfirmations(state,itemId);
        addActivity(state,{type:'todo_created',projectId:project.id,todoId:todo.id,text:`在「${project.name}」创建 GetNote 来源待办「${todo.title}」，用户截止 ${due}`});
        response={message:`已放进「${project.name}」并创建待办，截止 ${due}。`,todo};
        return;
      }
      state.notes.unshift({id:newId('n'),text:item.text,projectId:project.id,createdAt:item.createdAt});
      recordGetnoteSourceDecision(state,item,'project_note');
      remove();clearRoutingConfirmations(state,itemId);
      addActivity(state,{type:'project_note_created',projectId:project.id,text:`归入「${project.name}」项目记录：${compactText(item.text,80)}`});
      response={message:`已归入「${project.name}」作为项目记录。`};
      return;
    }

    setRoutingConfirmation(state,{inboxId:itemId,type:'inbox_intent_unclear',text:`收件箱事项「${compactText(item.text,50)}」还没有明确唯一的处理方式，需要你确认。`});
    response={needsFollowup:true,question:'请明确告诉我：放到哪个项目、做成独立待办、只是备忘、单独建项目，还是删除？'};
  });
  return response;
}

export async function processInbox({store,itemId,command,targetProjectId=null}){
  if(typeof itemId!=='string'||!itemId.trim())throw badRequest('itemId 必须是非空字符串。');
  if(typeof command!=='string')throw badRequest('command 必须是字符串。');
  if(targetProjectId!==null&&(typeof targetProjectId!=='string'||!targetProjectId.trim()))throw badRequest('targetProjectId 必须是非空字符串或 null。');
  if(!command.trim())return{needsFollowup:true,question:'告诉我这条内容要怎么处理。'};
  const snapshot=await store.readState();
  const item=snapshot.inbox.find(candidate=>candidate.id===itemId);
  if(!item)throw new Error('收件箱事项不存在');
  if(!isGetnoteInboxItem(item))return baseProcessInbox({store,itemId,command,targetProjectId});
  return processGetnoteInbox({store,itemId,command,targetProjectId});
}

function requirePatchObject(patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw badRequest('待办更新内容必须是 JSON 对象。');
  const keys=Object.keys(patch);
  if(!keys.length)throw badRequest('待办更新内容不能为空。');
  const unknown=keys.find(key=>!['title','context','dueDate','done'].includes(key));
  if(unknown)throw badRequest(`待办更新内容包含不支持的字段：${unknown}。`);
}

export async function updateTodo({store,todoId,patch}){
  if(typeof todoId!=='string'||!todoId.trim())throw badRequest('todoId 必须是非空字符串。');
  requirePatchObject(patch);
  if(Object.hasOwn(patch,'title')&&(typeof patch.title!=='string'||!patch.title.trim()))throw badRequest('title 必须是非空字符串。');
  if(Object.hasOwn(patch,'context')&&typeof patch.context!=='string')throw badRequest('context 必须是字符串。');
  if(Object.hasOwn(patch,'dueDate')&&!isValidDateOnly(patch.dueDate))throw badRequest('dueDate 必须是合法的 YYYY-MM-DD 日期。');
  if(Object.hasOwn(patch,'done')&&typeof patch.done!=='boolean')throw badRequest('done 必须是布尔值。');

  const snapshot=await store.readState();
  const existing=snapshot.todos.find(candidate=>candidate.id===todoId);
  if(!existing)throw new Error('待办不存在');
  if(existing.source!=='getnote_cli'||!Object.hasOwn(patch,'dueDate')){
    return baseUpdateTodo({store,todoId,patch});
  }

  return store.updateState(state=>{
    const todo=state.todos.find(candidate=>candidate.id===todoId);
    if(!todo)throw new Error('待办不存在');
    if(todo.source!=='getnote_cli')throw Object.assign(new Error('待办来源已变化，请刷新后重试。'),{statusCode:409});
    if(Object.hasOwn(patch,'title'))todo.title=patch.title.trim();
    if(Object.hasOwn(patch,'context'))todo.context=patch.context.trim();
    if(Object.hasOwn(patch,'dueDate')){
      todo.dueDate=patch.dueDate;
      todo.dueAt=patch.dueDate;
      todo.startAt=null;
      todo.allDay=true;
      todo.dueDateOwner='user';
      todo.externalStatus='active_local_due_date_override';
    }
    if(Object.hasOwn(patch,'done')){
      todo.done=patch.done;
      if(todo.done)state.todayPlan=state.todayPlan.filter(id=>id!==todo.id);
    }
    addActivity(state,{type:'todo_updated',todoId,text:`更新待办「${todo.title}」${todo.done?'（已完成）':''}`});
    return todo;
  });
}
