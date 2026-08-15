import {newId,nowIso,compactText} from './utils.mjs';

function normalizeText(value){return String(value??'').replace(/\s+/g,' ').trim().toLocaleLowerCase('zh-CN');}
function isGetnoteTodo(todo){return todo?.source==='getnote_cli'&&todo.done!==true&&todo.externalStatus!=='completed';}
function isGetnoteInbox(item){return item?.source==='getnote_cli'&&item.externalStatus!=='completed';}
function todoByExternalId(state,externalId){return state.todos.find(todo=>todo.source==='getnote_cli'&&todo.externalId===externalId)||null;}
function inboxByExternalId(state,externalId){return state.inbox.find(item=>item.source==='getnote_cli'&&item.externalTaskId===externalId)||null;}
function entityExternalId(entity){return entity.externalId||entity.externalTaskId||null;}
function entityNoteId(entity){return entity.sourceNoteId||null;}
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

function reconcileFingerprintRename(state,tasks){
  const incomingIds=new Set(tasks.map(task=>task.externalId));
  const existing=existingEntities(state);
  const existingIds=new Set(existing.map(({entity})=>entityExternalId(entity)).filter(Boolean));
  const unmatchedIncoming=tasks.filter(task=>!existingIds.has(task.externalId));
  const unmatchedExisting=existing.filter(({entity})=>!incomingIds.has(entityExternalId(entity)));
  const used=new Set();
  let reconciled=0;

  // Current official GetNote meeting_todos items expose text + completed only,
  // so identity is a text fingerprint. A changed title is inherited only when
  // one old entity and one new item remain in the same note after exact IDs are
  // removed. Any ambiguity stays separate instead of being guessed by similarity.
  const noteIds=new Set(unmatchedIncoming.map(task=>task.sourceNoteId).filter(Boolean));
  for(const noteId of noteIds){
    const incoming=unmatchedIncoming.filter(task=>task.sourceNoteId===noteId&&!existingIds.has(task.externalId));
    const old=unmatchedExisting.filter(({entity})=>!used.has(entity)&&entityNoteId(entity)===noteId);
    if(incoming.length!==1||old.length!==1)continue;
    const task=incoming[0];const {entity}=old[0];
    if(Object.hasOwn(entity,'externalId'))entity.externalId=task.externalId;
    if(Object.hasOwn(entity,'externalTaskId'))entity.externalTaskId=task.externalId;
    entity.externalIdentityKind='text_fingerprint';
    used.add(entity);reconciled+=1;
  }
  return reconciled;
}

function todoContext(task){
  const parts=[`来源：得到大脑《${task.sourceNoteTitle||'未命名笔记'}》`,`笔记 ID：${task.sourceNoteId||'unknown'}`];
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
  externalIdentityKind:task.externalIdentityKind||'text_fingerprint',
  todoSource:task.todoSource||''
};}
function localStateFromTodo(todo,now){return{
  workbenchEntityId:todo.id,
  workbenchCreatedAt:todo.createdAt||now,
  localProjectId:todo.projectId??null,
  localPriority:todo.priority??0,
  localPriorityLabel:todo.priorityLabel||'',
  localTags:Array.isArray(todo.tags)?todo.tags:[]
};}
function localStateFromInbox(item,task,now){return{
  id:item?.workbenchEntityId||item?.id||newId('td'),
  createdAt:item?.workbenchCreatedAt||item?.createdAt||now,
  projectId:item?.localProjectId??null,
  priority:Number.isFinite(item?.localPriority)?item.localPriority:(task.priority||0),
  priorityLabel:item?.localPriorityLabel||task.priorityLabel||'',
  tags:Array.isArray(item?.localTags)?item.localTags:(Array.isArray(task.tags)?task.tags:[])
};}
function localDueReference(todo,incomingSourceDueDate=null){
  if(typeof todo?.sourceDueDate==='string'&&todo.sourceDueDate)return todo.sourceDueDate;
  if(typeof todo?.sourcePreviousDueDate==='string'&&todo.sourcePreviousDueDate)return todo.sourcePreviousDueDate;
  // Legacy GetNote todos predate sourceDueDate. On the first v2 sync, a
  // mismatch is treated conservatively as a user-owned local date rather than
  // silently overwriting it with a newly observed source date.
  if(incomingSourceDueDate&&typeof todo?.dueDate==='string'&&todo.dueDate)return incomingSourceDueDate;
  return null;
}
function hasLocalDueOverride(todo,incomingSourceDueDate=null){
  if(!todo||typeof todo.dueDate!=='string'||!todo.dueDate)return false;
  const reference=localDueReference(todo,incomingSourceDueDate);
  return Boolean(reference&&todo.dueDate!==reference);
}
function localSchedule(todo){
  const dueDate=todo.dueDate;
  const dueAt=typeof todo.dueAt==='string'&&todo.dueAt.startsWith(`${dueDate}T`)?todo.dueAt:dueDate;
  const keepTimed=dueAt!==dueDate;
  const startAt=keepTimed&&typeof todo.startAt==='string'&&todo.startAt.startsWith(`${dueDate}T`)?todo.startAt:null;
  return{
    dueDate,
    dueAt,
    startAt,
    allDay:keepTimed?todo.allDay===true:true,
    timeZone:todo.timeZone||null
  };
}
function priorSourceDue(todo){return todo?.sourceDueDate||todo?.sourcePreviousDueDate||todo?.dueDate||null;}

export function applyGetnoteTaskSnapshot(state,{active=[],completed=[]}={}){
  const now=nowIso();
  const all=[...active,...completed];
  const reconciled=reconcileFingerprintRename(state,all);
  let created=0,updated=0,completedCount=0,undated=0,scheduled=0,todayPreserved=0,movedToInbox=0,movedToTodo=0,localDuePreserved=0;

  for(const task of active){
    const existingTodo=todoByExternalId(state,task.externalId);
    const existingInbox=inboxByExternalId(state,task.externalId);
    if(!task.dueDate){
      undated+=1;
      const localOverride=existingTodo&&hasLocalDueOverride(existingTodo);
      const todayOwned=existingTodo&&state.todayPlan.includes(existingTodo.id);
      if(existingTodo&&(todayOwned||localOverride)){
        const before=JSON.stringify(existingTodo);
        Object.assign(existingTodo,sourcePatch(task,now),localSchedule(existingTodo),{
          title:compactText(task.title,200),context:todoContext(task),done:false,
          externalStatus:localOverride?'active_without_due_date_local_override':'active_without_due_date_today_preserved',
          sourcePreviousDueDate:priorSourceDue(existingTodo),
          sourceDueDate:null
        });
        if(JSON.stringify(existingTodo)!==before)updated+=1;
        if(existingInbox)state.inbox=state.inbox.filter(item=>item.id!==existingInbox.id);
        if(todayOwned)todayPreserved+=1;
        if(localOverride)localDuePreserved+=1;
        continue;
      }

      const local=existingTodo?localStateFromTodo(existingTodo,now):null;
      const patch={
        text:inboxText(task),externalTaskId:task.externalId,externalStatus:'active_without_due_date',sourceDueDate:null,
        sourcePreviousDueDate:existingTodo?priorSourceDue(existingTodo):(existingInbox?.sourcePreviousDueDate||null),
        ...sourcePatch(task,now),
        ...(local||{})
      };
      if(existingInbox){
        const before=JSON.stringify(existingInbox);
        Object.assign(existingInbox,patch);
        if(local){
          existingInbox.workbenchEntityId=local.workbenchEntityId;
          existingInbox.workbenchCreatedAt=local.workbenchCreatedAt;
          existingInbox.localProjectId=local.localProjectId;
          existingInbox.localPriority=local.localPriority;
          existingInbox.localPriorityLabel=local.localPriorityLabel;
          existingInbox.localTags=local.localTags;
        }
        if(JSON.stringify(existingInbox)!==before)updated+=1;
      }else{
        state.inbox.unshift({id:local?.workbenchEntityId||newId('in'),...patch,createdAt:local?.workbenchCreatedAt||now});
        if(existingTodo)movedToInbox+=1;else created+=1;
      }
      if(existingTodo)state.todos=state.todos.filter(todo=>todo.id!==existingTodo.id);
      continue;
    }

    scheduled+=1;
    const sourceSchedule={dueDate:task.dueDate,startAt:task.startAt,dueAt:task.dueAt,allDay:task.allDay,timeZone:task.timeZone};
    if(existingTodo){
      if(existingInbox)state.inbox=state.inbox.filter(item=>item.id!==existingInbox.id);
      const before=JSON.stringify(existingTodo);
      const localOverride=hasLocalDueOverride(existingTodo,task.dueDate);
      const local={
        projectId:existingTodo.projectId??null,
        priority:existingTodo.priority??0,
        priorityLabel:existingTodo.priorityLabel||'',
        tags:Array.isArray(existingTodo.tags)?existingTodo.tags:[],
        createdAt:existingTodo.createdAt||now
      };
      Object.assign(existingTodo,
        sourcePatch(task,now),
        {
          title:compactText(task.title,200),context:todoContext(task),done:false,
          externalId:task.externalId,
          externalStatus:localOverride?'active_local_due_date_override':'active',
          sourceDueDate:task.dueDate,
          sourcePreviousDueDate:null
        },
        localOverride?localSchedule(existingTodo):sourceSchedule,
        local
      );
      if(localOverride)localDuePreserved+=1;
      if(JSON.stringify(existingTodo)!==before)updated+=1;
    }else{
      const local=localStateFromInbox(existingInbox,task,now);
      if(existingInbox)state.inbox=state.inbox.filter(item=>item.id!==existingInbox.id);
      state.todos.unshift({
        id:local.id,...sourcePatch(task,now),title:compactText(task.title,200),context:todoContext(task),done:false,
        externalId:task.externalId,externalStatus:'active',sourceDueDate:task.dueDate,sourcePreviousDueDate:null,
        ...sourceSchedule,projectId:local.projectId,priority:local.priority,priorityLabel:local.priorityLabel,tags:local.tags,createdAt:local.createdAt
      });
      if(existingInbox)movedToTodo+=1;else created+=1;
    }
  }

  for(const task of completed){
    const todo=todoByExternalId(state,task.externalId);
    const inbox=inboxByExternalId(state,task.externalId);
    if(inbox){
      state.inbox=state.inbox.filter(item=>item.id!==inbox.id);
      if(!todo)completedCount+=1;
    }
    if(!todo)continue;
    if(!todo.done)completedCount+=1;
    Object.assign(todo,sourcePatch(task,now),{
      done:true,externalStatus:'completed',completedAt:task.completedAt||now,sourceDueDate:task.dueDate||todo.sourceDueDate||null
    });
    state.todayPlan=state.todayPlan.filter(id=>id!==todo.id);
  }
  return{created,updated,completed:completedCount,undated,scheduled,reconciled,todayPreserved,movedToInbox,movedToTodo,localDuePreserved};
}
