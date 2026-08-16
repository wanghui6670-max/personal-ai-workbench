import test from 'node:test';
import assert from 'node:assert/strict';
import {applyGetnoteTaskSnapshot,collectTrackedGetnoteNotes} from '../src/external-task-reconcile.mjs';

function state(){return{
  schemaVersion:1,
  inbox:[],inboxAcks:[],
  todos:[],todayPlan:[],todayPlanDate:null,projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]
};}
function task(overrides={}){return{
  externalId:'getnote-new',externalIdentityKind:'text_fingerprint',title:'提交方案',dueDate:'2026-08-20',dueAt:'2026-08-20',startAt:null,allDay:true,timeZone:'Asia/Shanghai',
  updatedAt:'2026-08-15T01:00:00Z',done:false,priority:0,priorityLabel:'',tags:[],sourceNoteId:'note-1',sourceNoteTitle:'产品周会',
  sourceNoteType:'MEETING',sourceNoteCreatedAt:'2026-08-10T01:00:00Z',sourceNoteUpdatedAt:'2026-08-15T01:00:00Z',sourceNoteUrl:'',
  todoSource:'summary',...overrides
};}

test('one-to-one text fingerprint rename preserves Workbench entity and user-owned fields',()=>{
  const current=state();
  current.todos.push({
    id:'td-existing',title:'提交方案',context:'',dueDate:'2026-08-18',done:false,projectId:'project-1',createdAt:'2026-08-11T00:00:00Z',
    source:'getnote_cli',externalId:'legacy-text-id',sourceNoteId:'note-1',sourceNoteTitle:'产品周会',priority:3,priorityLabel:'重要',tags:['用户标签']
  });
  const changes=applyGetnoteTaskSnapshot(current,{active:[task({title:'提交最终方案'})]});
  assert.equal(changes.reconciled,1);
  assert.equal(current.todos.length,1);
  const todo=current.todos[0];
  assert.equal(todo.id,'td-existing');
  assert.equal(todo.externalId,'getnote-new');
  assert.equal(todo.externalIdentityKind,'text_fingerprint');
  assert.equal(todo.projectId,'project-1');
  assert.equal(todo.priority,3);
  assert.equal(todo.priorityLabel,'重要');
  assert.deepEqual(todo.tags,['用户标签']);
});

test('one-to-one Inbox text rename preserves Workbench entity id',()=>{
  const current=state();
  current.inbox.push({id:'in-old',text:'确认预算｜来自得到大脑《预算会》',source:'getnote_cli',externalTaskId:'old-text-id',sourceNoteId:'note-2',sourceNoteTitle:'预算会',createdAt:'2026-08-11T00:00:00Z'});
  const changes=applyGetnoteTaskSnapshot(current,{active:[task({externalId:'new-text-id',sourceNoteId:'note-2',sourceNoteTitle:'预算会',title:'确认最终预算',dueDate:null,dueAt:null})]});
  assert.equal(changes.reconciled,1);
  assert.equal(current.inbox.length,1);
  assert.equal(current.inbox[0].id,'in-old');
  assert.equal(current.inbox[0].externalTaskId,'new-text-id');
});

test('ambiguous same-note text changes are not auto-reconciled',()=>{
  const current=state();
  current.todos.push(
    {id:'td-a',title:'事项 A',context:'',dueDate:'2026-08-20',done:false,projectId:null,createdAt:'x',source:'getnote_cli',externalId:'old-a',sourceNoteId:'same-note'},
    {id:'td-b',title:'事项 B',context:'',dueDate:'2026-08-20',done:false,projectId:null,createdAt:'x',source:'getnote_cli',externalId:'old-b',sourceNoteId:'same-note'}
  );
  const changes=applyGetnoteTaskSnapshot(current,{active:[
    task({externalId:'new-a',sourceNoteId:'same-note',title:'事项 A 新文案'}),
    task({externalId:'new-b',sourceNoteId:'same-note',title:'事项 B 新文案'})
  ]});
  assert.equal(changes.reconciled,0);
  assert.equal(current.todos.some(item=>item.externalId==='old-a'),true);
  assert.equal(current.todos.some(item=>item.externalId==='old-b'),true);
  assert.equal(current.todos.some(item=>item.externalId==='new-a'),true);
  assert.equal(current.todos.some(item=>item.externalId==='new-b'),true);
});

test('source date removal never ejects a user-selected Today task',()=>{
  const current=state();
  current.todayPlanDate='2026-08-15';
  current.todos.push({
    id:'td-today',title:'联系供应商',context:'',dueDate:'2026-08-16',sourceDueDate:'2026-08-16',done:false,projectId:null,
    createdAt:'2026-08-11T00:00:00Z',source:'getnote_cli',externalId:'same-id',sourceNoteId:'note-3'
  });
  current.todayPlan=['td-today'];
  const changes=applyGetnoteTaskSnapshot(current,{active:[task({externalId:'same-id',sourceNoteId:'note-3',title:'联系供应商',dueDate:null,dueAt:null})]});
  assert.equal(changes.todayPreserved,1);
  assert.equal(changes.localDuePreserved,0);
  assert.deepEqual(current.todayPlan,['td-today']);
  assert.equal(current.todos[0].externalStatus,'active_without_due_date_today_preserved');
  assert.equal(current.todos[0].sourceDueDate,null);
  assert.equal(current.todos[0].sourcePreviousDueDate,'2026-08-16');
  assert.equal(current.inbox.length,0);
});

test('dated -> Inbox -> dated keeps one Workbench entity and local project/priority/tags',()=>{
  const current=state();
  current.todos.push({
    id:'td-stable',title:'联系供应商',context:'',dueDate:'2026-08-16',sourceDueDate:'2026-08-16',done:false,projectId:'project-local',createdAt:'2026-08-11T00:00:00Z',
    source:'getnote_cli',externalId:'same-id',sourceNoteId:'note-3',priority:7,priorityLabel:'我定的重要',tags:['客户','本地']
  });

  const undated=task({externalId:'same-id',sourceNoteId:'note-3',title:'联系供应商',dueDate:null,dueAt:null});
  applyGetnoteTaskSnapshot(current,{active:[undated]});
  assert.equal(current.todos.length,0);
  assert.equal(current.inbox.length,1);
  const inbox=current.inbox[0];
  assert.equal(inbox.id,'td-stable');
  assert.equal(inbox.workbenchEntityId,'td-stable');
  assert.equal(inbox.localProjectId,'project-local');
  assert.equal(inbox.localPriority,7);
  assert.equal(inbox.localPriorityLabel,'我定的重要');
  assert.deepEqual(inbox.localTags,['客户','本地']);
  assert.equal(inbox.sourcePreviousDueDate,'2026-08-16');

  const redated=task({externalId:'same-id',sourceNoteId:'note-3',title:'联系供应商',dueDate:'2026-08-25',dueAt:'2026-08-25'});
  applyGetnoteTaskSnapshot(current,{active:[redated]});
  assert.equal(current.inbox.length,0);
  assert.equal(current.todos.length,1);
  const restored=current.todos[0];
  assert.equal(restored.id,'td-stable');
  assert.equal(restored.dueDate,'2026-08-25');
  assert.equal(restored.sourceDueDate,'2026-08-25');
  assert.equal(restored.projectId,'project-local');
  assert.equal(restored.priority,7);
  assert.equal(restored.priorityLabel,'我定的重要');
  assert.deepEqual(restored.tags,['客户','本地']);
  assert.equal(restored.createdAt,'2026-08-11T00:00:00Z');
});

test('an initially undated task keeps its Workbench entity id when a source date later appears',()=>{
  const current=state();
  const undated=task({externalId:'new-undated',sourceNoteId:'note-u',dueDate:null,dueAt:null});
  applyGetnoteTaskSnapshot(current,{active:[undated]});
  const firstId=current.inbox[0].id;
  applyGetnoteTaskSnapshot(current,{active:[task({externalId:'new-undated',sourceNoteId:'note-u',dueDate:'2026-08-30',dueAt:'2026-08-30'})]});
  assert.equal(current.inbox.length,0);
  assert.equal(current.todos[0].id,firstId);
});

test('tracked notes include unresolved Todo and Inbox sources but exclude completed tasks',()=>{
  const current=state();
  current.todos.push(
    {id:'td-a',title:'A',context:'',dueDate:'2026-08-20',done:false,projectId:null,createdAt:'x',source:'getnote_cli',externalId:'a',sourceNoteId:'old-note',sourceNoteTitle:'旧会议',sourceNoteCreatedAt:'2026-05-01T00:00:00Z'},
    {id:'td-b',title:'B',context:'',dueDate:'2026-08-20',done:true,projectId:null,createdAt:'x',source:'getnote_cli',externalId:'b',sourceNoteId:'done-note'}
  );
  current.inbox.push({id:'in-a',text:'C',source:'getnote_cli',externalTaskId:'c',sourceNoteId:'inbox-note',sourceNoteTitle:'待定会',createdAt:'x'});
  const notes=collectTrackedGetnoteNotes(current);
  assert.deepEqual(notes.map(item=>item.noteId).sort(),['inbox-note','old-note']);
  assert.equal(notes.find(item=>item.noteId==='old-note').createdAt,'2026-05-01T00:00:00Z');
});
