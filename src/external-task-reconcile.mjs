import {newId,nowIso,compactText} from './utils.mjs';

function normalizeText(value){return String(value??'').replace(/\s+/g,' ').trim().toLocaleLowerCase('zh-CN');}
function isGetnoteTodo(todo){return todo?.source==='getnote_cli'&&todo.done!==true&&todo.externalStatus!=='completed';}
function isGetnoteInbox(item){return item?.source==='getnote_cli'&&item.externalStatus!=='completed';}
function todoByExternalId(state,externalId){return state.todos.find(todo=>todo.source==='getnote_cli'&&todo.externalId===externalId)||null;}
function inboxByExternalId(state,externalId){return state.inbox.find(item=>item.source==='getnote_cli'&&item.externalTaskId===externalId)||null;}
function entityExternalId(entity){return entity.externalId||entity.externalTaskId||null;}
function entityNoteId(entity){return entity.sourceNoteId||null;}
function entitySourceTodoId(entity){return entity.sourceTodoId||null;}
function entityTitle(entity){return entity.title||String(entity.text||'').split('｜来自得到大脑《')[0]||'';}

function trackedNoteFrom(entity){
  const noteId=entityNoteId(entity);
  if(!noteId)return null;
  return{
    noteId,
    title:entity.sourceNoteTitle||'未命名笔记',
    noteType:entity.sourceNoteType||'',
    createdAt:entity.sourceNoteCreatedAt||null,
    updatedAt:entity.sourceNoteUpdatedAt||entity.externalUpdatedAt||null,
    noteUrl:entity.sourceNoteUrl||''
  };
}

export function collectTrackedGetnoteNotes(state={}){
  const notes=new Map();
  for(const todo of Array.isArray(state.todos)?state.todos:[]){
    if(!isGetnoteTodo(todo))continue;
    const note=trackedNoteFrom(todo);if(note&&!notes.has(note.noteId))notes.set(note.noteId,note);
  }
  for(const item of Array.isArray(state.inbox)?state.inbox:[]){
    if(!isGetnoteInbox(item))continue;
    const note=trackedNoteFrom(item);if(note&&!notes.has(note.noteId))notes.set(note.noteId,note);
  }
  return [...notes.values()];
}

function existingEntities(state){
  return [
    ...state.todos.filter(isGetnoteTodo).map(entity=>({kind:'todo',entity})),
    ...state.inbox.filter(isGetnoteInbox).map(entity=>({kind:'inbox',entity}))
  ];
}

function reconcileLegacyIdentity(state,tasks){
  const incomingIds=new Set(tasks.map(task=>task.externalId));
  const existing=existingEntities(state);
  const existingIds=new Set(existing.map(({entity})=>entityExternalId(entity)).filter(Boolean));
  const unmatchedIncoming=tasks.filter(task=>!existingIds.has(task.externalId));
  const unmatchedExisting=existing.filter(({entity})=>!incomingIds.has(entityExternalId(entity)));
  const used=new Set();
  let reconciled=0;

  // If the source starts exposing a stable todo id, safely migrate an old
  // text-fingerprint entity only when note + normalized title still match.
  for(const task of unmatchedIncoming.filter(item=>item.sourceTodoId)){
    const candidates=unmatchedExisting.filter(({entity})=>
      !used.has(entity)&&entityNoteId(entity)===task.sourceNoteId&&!entitySourceTodoId(entity)&&normalizeText(entityTitle(entity))===normalizeText(task.title)
    );
    if(candidates.length!==1)continue;
    const {entity}=candidates[0];
    if(Object.hasOwn(entity,'externalId'))entity.externalId=task.externalId;
    if(Object.hasOwn(entity,'externalTaskId'))entity.externalTaskId=task.externalId;
    entity.sourceTodoId=task.sourceTodoId;
    entity.externalIdentityKind='source_id';
    used.add(entity);reconciled+=1;
  }

  // Fallback rename reconciliation is deliberately conservative: after all
  // exact ids are removed, only a one-to-one unmatched pair in the same note
  // can inherit the previous Workbench entity id.
  const noteIds=new Set(unmatchedIncoming.map(task=>task.sourceNoteId).filter(Boolean));
  for(const noteId of noteIds){
    const incoming=unmatchedIncoming.filter(task=>task.sourceNoteId===noteId&&!task.sourceTodoId&&!existingIds.has(task.externalId));
    const old=unmatchedExisting.filter(({entity})=>!used.has(entity)&&entityNoteId(entity)===noteId&&!entitySourceTodoId(entity));
    if(incoming.length!==1||old.length!==1)continue;
    const task=incoming[0];const {entity}=old[0];
    if(Object.hasOwn(entity,'externalId'))entity.externalId=task.externalId;
    if(Object.hasOwn(entity,'externalTaskId'))entity.externalTaskId=task.externalId;
    entity.externalIdentityKind='fallback_text';
    used.add(entity);reconciled+=1;
  }
  return reconciled;
}

function todoContext(task){
  const parts=[`来源：得到大脑《${task.sourceNoteTitle||'未命名笔记'}》`,`笔记 ID：${task.sourceNoteId||'unknown'}`];
  if(task.sourceTodoId)parts.push(`得到待办 ID：${task.sourceTodoId}`);
  if(task.sourceNoteUrl)parts.push(`笔记链接：${task.sourceNoteUrl}`);
  if(task.todoSource)parts.push(`待办解析来源：${task.todoSource}`);
  return compactText(parts.join('\n'),2000);
}
function inboxText(task){return compactText(`${task.title}｜来自得到大脑《${task.sourceNoteTitle||'未命名笔记'}》`,1000);}
function sourcePatch(task,now){return{
  source:'getnote_cli',
  externalUpdatedAt:task.updatedAt||now,
  sourceNoteId:task.sourceNoteId,
  sourceNoteTitle:task.sourceNoteTitle,
  sourceNoteType:task.sourceNoteType||'',
  sourceNoteCreatedAt:task.sourceNoteCreatedAt||null,
  sourceNoteUpdatedAt:task.sourceNoteUpdatedAt||task.updatedAt||null,
  sourceNoteUrl:task.sourceNoteUrl||'',
  sourceTodoId:task.sourceTodoId||null,
  externalIdentityKind:task.identityKind||'fallback_text',
  todoSource:task.todoSource||''
};}

export function applyGetnoteTaskSnapshot(state,{active=[],completed=[]}={}){
  const now=nowIso();
  const all=[...active,...completed];
  const reconciled=reconcileLegacyIdentity(state,all);
  let created=0,updated=0,completedCount=0,undated=0,scheduled=0,todayPreserved=0;

  for(const task of active){
    const existingTodo=todoByExternalId(state,task.externalId);
    const existingInbox=inboxByExternalId(state,task.externalId);
    if(!task.dueDate){
      undated+=1;
      if(existingTodo&&state.todayPlan.includes(existingTodo.id)){
        const before=JSON.stringify(existingTodo);
        Object.assign(existingTodo,sourcePatch(task,now),{
          title:compactText(task.title,200),context:todoContext(task),done:false,
          externalStatus:'active_without_due_date_today_preserved',sourceDueDate:null
        });
        if(JSON.stringify(existingTodo)!==before)updated+=1;
        if(existingInbox)state.inbox=state.inbox.filter(item=>item.id!==existingInbox.id);
        todayPreserved+=1;
        continue;
      }
      if(existingTodo)state.todos=state.todos.filter(todo=>todo.id!==existingTodo.id);
      const patch={
        text:inboxText(task),externalTaskId:task.externalId,externalStatus:'active_without_due_date',sourceDueDate:null,
        ...sourcePatch(task,now)
      };
      if(existingInbox){
        const before=JSON.stringify(existingInbox);Object.assign(existingInbox,patch);if(JSON.stringify(existingInbox)!==before)updated+=1;
      }else{state.inbox.unshift({id:newId('in'),...patch,createdAt:now});created+=1;}
      continue;
    }

    scheduled+=1;
    if(existingInbox)state.inbox=state.inbox.filter(item=>item.id!==existingInbox.id);
    const common={
      title:compactText(task.title,200),context:todoContext(task),dueDate:task.dueDate,done:false,
      externalId:task.externalId,externalStatus:'active',sourceDueDate:task.dueDate,
      startAt:task.startAt,dueAt:task.dueAt,allDay:task.allDay,timeZone:task.timeZone,
      ...sourcePatch(task,now)
    };
    if(existingTodo){
      const before=JSON.stringify(existingTodo);
      const local={
        projectId:existingTodo.projectId??null,
        priority:existingTodo.priority??0,
        priorityLabel:existingTodo.priorityLabel||'',
        tags:Array.isArray(existingTodo.tags)?existingTodo.tags:[],
        createdAt:existingTodo.createdAt||now
      };
      Object.assign(existingTodo,common,local);
      if(JSON.stringify(existingTodo)!==before)updated+=1;
    }else{
      state.todos.unshift({
        id:newId('td'),...common,projectId:null,priority:task.priority||0,
        priorityLabel:task.priorityLabel||'',tags:Array.isArray(task.tags)?task.tags:[],createdAt:now
      });
      created+=1;
    }
  }

  for(const task of completed){
    const todo=todoByExternalId(state,task.externalId);
    const inbox=inboxByExternalId(state,task.externalId);
    if(inbox)state.inbox=state.inbox.filter(item=>item.id!==inbox.id);
    if(!todo)continue;
    if(!todo.done)completedCount+=1;
    Object.assign(todo,sourcePatch(task,now),{
      done:true,externalStatus:'completed',completedAt:task.completedAt||now,sourceDueDate:task.dueDate||todo.sourceDueDate||null
    });
    state.todayPlan=state.todayPlan.filter(id=>id!==todo.id);
  }
  return{created,updated,completed:completedCount,undated,scheduled,reconciled,todayPreserved};
}
