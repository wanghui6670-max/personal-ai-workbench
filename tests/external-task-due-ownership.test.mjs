import test from 'node:test';
import assert from 'node:assert/strict';
import {applyGetnoteTaskSnapshot} from '../src/external-task-reconcile.mjs';

function state(todo){return{
  schemaVersion:1,inbox:[],inboxAcks:[],todos:[todo],todayPlan:[],todayPlanDate:'2026-08-15',projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]
};}
function source(overrides={}){return{
  externalId:'ext-1',externalIdentityKind:'text_fingerprint',title:'提交方案',dueDate:'2026-08-25',dueAt:'2026-08-25',startAt:null,allDay:true,timeZone:'Asia/Shanghai',
  updatedAt:'2026-08-15T00:00:00Z',done:false,priority:0,priorityLabel:'',tags:[],sourceNoteId:'note-1',sourceNoteTitle:'方案会',
  todoSource:'summary',...overrides
};}
function todo(overrides={}){return{
  id:'td-1',title:'提交方案',context:'',dueDate:'2026-08-20',dueAt:'2026-08-20',startAt:null,allDay:true,timeZone:'Asia/Shanghai',
  done:false,projectId:null,createdAt:'2026-08-10T00:00:00Z',source:'getnote_cli',externalId:'ext-1',sourceNoteId:'note-1',
  priority:0,priorityLabel:'',tags:[],...overrides
};}

test('a v2 source-owned due date continues following later GetNote date changes',()=>{
  const current=state(todo({sourceDueDate:'2026-08-20'}));
  const changes=applyGetnoteTaskSnapshot(current,{active:[source()]});
  assert.equal(changes.localDuePreserved,0);
  assert.equal(current.todos[0].dueDate,'2026-08-25');
  assert.equal(current.todos[0].sourceDueDate,'2026-08-25');
  assert.equal(current.todos[0].externalStatus,'active');
});

test('a user-edited due date is preserved while sourceDueDate continues tracking GetNote',()=>{
  const current=state(todo({dueDate:'2026-08-22',dueAt:'2026-08-20T15:00:00',allDay:false,sourceDueDate:'2026-08-20'}));
  const changes=applyGetnoteTaskSnapshot(current,{active:[source()]});
  const saved=current.todos[0];
  assert.equal(changes.localDuePreserved,1);
  assert.equal(saved.dueDate,'2026-08-22');
  assert.equal(saved.dueAt,'2026-08-22','stale source timed value is normalized to the user date');
  assert.equal(saved.allDay,true);
  assert.equal(saved.sourceDueDate,'2026-08-25');
  assert.equal(saved.externalStatus,'active_local_due_date_override');
});

test('legacy GetNote todos without sourceDueDate conservatively preserve a mismatching current due date',()=>{
  const current=state(todo({dueDate:'2026-08-21'}));
  const changes=applyGetnoteTaskSnapshot(current,{active:[source({dueDate:'2026-08-25',dueAt:'2026-08-25'})]});
  assert.equal(changes.localDuePreserved,1);
  assert.equal(current.todos[0].dueDate,'2026-08-21');
  assert.equal(current.todos[0].sourceDueDate,'2026-08-25');
});

test('a v2 source-owned due date moves back to Inbox when GetNote removes the date outside Today',()=>{
  const current=state(todo({sourceDueDate:'2026-08-20'}));
  const changes=applyGetnoteTaskSnapshot(current,{active:[source({dueDate:null,dueAt:null})]});
  assert.equal(changes.localDuePreserved,0);
  assert.equal(changes.movedToInbox,1);
  assert.equal(current.todos.length,0);
  assert.equal(current.inbox.length,1);
  assert.equal(current.inbox[0].id,'td-1');
  assert.equal(current.inbox[0].externalTaskId,'ext-1');
  assert.equal(current.inbox[0].sourceDueDate,null);
  assert.equal(current.inbox[0].sourcePreviousDueDate,'2026-08-20');
  assert.equal(current.inbox[0].externalStatus,'active_without_due_date');
});

test('a legacy Todo with no source due history is preserved conservatively when the first v2 source becomes undated',()=>{
  const current=state(todo());
  const changes=applyGetnoteTaskSnapshot(current,{active:[source({dueDate:null,dueAt:null})]});
  assert.equal(changes.localDuePreserved,1);
  assert.equal(changes.movedToInbox,0);
  assert.equal(current.inbox.length,0);
  assert.equal(current.todos.length,1);
  assert.equal(current.todos[0].dueDate,'2026-08-20');
  assert.equal(current.todos[0].sourceDueDate,null);
  assert.equal(current.todos[0].sourcePreviousDueDate,'2026-08-20');
  assert.equal(current.todos[0].externalStatus,'active_without_due_date_local_override');
});

test('when GetNote removes its date, a local due-date override keeps the Todo even outside Today',()=>{
  const current=state(todo({dueDate:'2026-08-22',sourceDueDate:'2026-08-20'}));
  const changes=applyGetnoteTaskSnapshot(current,{active:[source({dueDate:null,dueAt:null})]});
  assert.equal(changes.localDuePreserved,1);
  assert.equal(changes.movedToInbox,0);
  assert.equal(current.inbox.length,0);
  assert.equal(current.todos.length,1);
  assert.equal(current.todos[0].dueDate,'2026-08-22');
  assert.equal(current.todos[0].sourceDueDate,null);
  assert.equal(current.todos[0].sourcePreviousDueDate,'2026-08-20');
  assert.equal(current.todos[0].externalStatus,'active_without_due_date_local_override');
});

test('Today preservation can later detect a user date edit while the source remains undated',()=>{
  const current=state(todo({dueDate:'2026-08-20',sourceDueDate:'2026-08-20'}));
  current.todayPlan=['td-1'];
  applyGetnoteTaskSnapshot(current,{active:[source({dueDate:null,dueAt:null})]});
  assert.equal(current.todos[0].sourcePreviousDueDate,'2026-08-20');
  current.todos[0].dueDate='2026-08-23';
  current.todos[0].dueAt='2026-08-23';
  const changes=applyGetnoteTaskSnapshot(current,{active:[source({dueDate:null,dueAt:null})]});
  assert.equal(changes.localDuePreserved,1);
  assert.equal(current.todos[0].dueDate,'2026-08-23');
  assert.equal(current.todos[0].externalStatus,'active_without_due_date_local_override');
  assert.deepEqual(current.todayPlan,['td-1']);
});

test('Today-only preservation stops keeping an unchanged source-owned date after the user removes Today',()=>{
  const current=state(todo({dueDate:'2026-08-20',sourceDueDate:'2026-08-20'}));
  current.todayPlan=['td-1'];
  const first=applyGetnoteTaskSnapshot(current,{active:[source({dueDate:null,dueAt:null})]});
  assert.equal(first.todayPreserved,1);
  assert.equal(current.todos[0].externalStatus,'active_without_due_date_today_preserved');
  current.todayPlan=[];
  const second=applyGetnoteTaskSnapshot(current,{active:[source({dueDate:null,dueAt:null})]});
  assert.equal(second.localDuePreserved,0);
  assert.equal(second.movedToInbox,1);
  assert.equal(current.todos.length,0);
  assert.equal(current.inbox.length,1);
  assert.equal(current.inbox[0].sourcePreviousDueDate,'2026-08-20');
});
