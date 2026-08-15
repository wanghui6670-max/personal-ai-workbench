import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/store.mjs';
import {processInbox,updateTodo} from '../src/domain.mjs';
import {applyGetnoteTaskSnapshot} from '../src/external-task-reconcile.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-getnote-decisions-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return store;
}

function sourceTask(overrides={}){
  return{
    externalId:'getnote-task-1',
    externalIdentityKind:'text_fingerprint',
    title:'跟进客户',
    content:'',
    description:'',
    done:false,
    priority:0,
    priorityLabel:'',
    startAt:null,
    dueAt:null,
    dueDate:null,
    allDay:true,
    timeZone:'Asia/Shanghai',
    completedAt:null,
    updatedAt:'2026-08-16T00:00:00Z',
    tags:[],
    sourceNoteId:'note-1',
    sourceNoteTitle:'客户会议',
    sourceNoteType:'MEETING',
    sourceNoteCreatedAt:'2026-08-15T00:00:00Z',
    sourceNoteUpdatedAt:'2026-08-16T00:00:00Z',
    sourceNoteUrl:'https://www.biji.com/note/note-1',
    todoSource:'meeting_todos',
    ...overrides
  };
}

async function seedUndatedInbox(store,id='in_getnote_1'){
  await store.updateState(state=>{
    state.inbox.unshift({
      id,
      text:'跟进客户｜来自得到大脑《客户会议》',
      source:'getnote_cli',
      externalTaskId:'getnote-task-1',
      externalIdentityKind:'text_fingerprint',
      externalStatus:'active_without_due_date',
      sourceDueDate:null,
      sourcePreviousDueDate:null,
      sourceNoteId:'note-1',
      sourceNoteTitle:'客户会议',
      sourceNoteType:'MEETING',
      sourceNoteCreatedAt:'2026-08-15T00:00:00Z',
      sourceNoteUpdatedAt:'2026-08-16T00:00:00Z',
      sourceNoteUrl:'https://www.biji.com/note/note-1',
      todoSource:'meeting_todos',
      timeZone:'Asia/Shanghai',
      createdAt:'2026-08-16T00:00:00Z'
    });
  });
}

test('deleting a GetNote inbox item persists an exact source decision and prevents re-import',async t=>{
  const store=await fixture(t);
  await seedUndatedInbox(store);

  const result=await processInbox({store,itemId:'in_getnote_1',command:'删除'});
  assert.match(result.message,/不会在后续同步中重新出现/);

  let state=await store.readState();
  assert.equal(state.inbox.length,0);
  assert.equal(state.externalTaskDecisions.length,1);
  assert.equal(state.externalTaskDecisions[0].externalId,'getnote-task-1');
  assert.equal(state.externalTaskDecisions[0].disposition,'dismissed');

  const changes=await store.updateState(current=>applyGetnoteTaskSnapshot(current,{active:[sourceTask()]}));
  assert.equal(changes.suppressed,1);
  state=await store.readState();
  assert.equal(state.inbox.length,0);
  assert.equal(state.todos.length,0);

  const completion=await store.updateState(current=>applyGetnoteTaskSnapshot(current,{
    completed:[sourceTask({done:true,completedAt:'2026-08-16T01:00:00Z'})]
  }));
  assert.equal(completion.clearedDecisions,1);
  state=await store.readState();
  assert.deepEqual(state.externalTaskDecisions,[]);
});

test('manual GetNote Inbox -> Todo conversion keeps one entity and a user-owned due date across syncs',async t=>{
  const store=await fixture(t);
  await seedUndatedInbox(store);

  const result=await processInbox({
    store,
    itemId:'in_getnote_1',
    command:'做成独立待办，截止 2026-08-25'
  });
  assert.equal(result.todo.id,'in_getnote_1');
  assert.equal(result.todo.externalId,'getnote-task-1');
  assert.equal(result.todo.dueDateOwner,'user');
  assert.equal(result.todo.dueDate,'2026-08-25');

  let changes=await store.updateState(current=>applyGetnoteTaskSnapshot(current,{active:[sourceTask()]}));
  assert.equal(changes.localDuePreserved,1);
  let state=await store.readState();
  assert.equal(state.inbox.length,0);
  assert.equal(state.todos.length,1);
  assert.equal(state.todos[0].id,'in_getnote_1');
  assert.equal(state.todos[0].dueDate,'2026-08-25');
  assert.equal(state.todos[0].dueDateOwner,'user');

  changes=await store.updateState(current=>applyGetnoteTaskSnapshot(current,{active:[sourceTask({
    dueDate:'2026-08-30',
    dueAt:'2026-08-30',
    allDay:true
  })]}));
  assert.equal(changes.localDuePreserved,1);
  state=await store.readState();
  assert.equal(state.todos[0].dueDate,'2026-08-25');
  assert.equal(state.todos[0].sourceDueDate,'2026-08-30');
  assert.equal(state.todos[0].dueDateOwner,'user');
});

test('editing a GetNote Todo due date explicitly transfers due-date ownership to the user',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>applyGetnoteTaskSnapshot(state,{active:[sourceTask({
    dueDate:'2026-08-20',
    dueAt:'2026-08-20'
  })]}));

  let state=await store.readState();
  const todo=state.todos[0];
  assert.equal(todo.dueDateOwner,'source');

  const updated=await updateTodo({store,todoId:todo.id,patch:{dueDate:'2026-08-22'}});
  assert.equal(updated.dueDateOwner,'user');
  assert.equal(updated.dueAt,'2026-08-22');
  assert.equal(updated.allDay,true);

  const changes=await store.updateState(current=>applyGetnoteTaskSnapshot(current,{active:[sourceTask({
    dueDate:'2026-08-26',
    dueAt:'2026-08-26'
  })]}));
  assert.equal(changes.localDuePreserved,1);
  state=await store.readState();
  assert.equal(state.todos[0].dueDate,'2026-08-22');
  assert.equal(state.todos[0].sourceDueDate,'2026-08-26');
  assert.equal(state.todos[0].dueDateOwner,'user');
});

test('source-decision state rejects narrative payload fields and unsupported dispositions',async t=>{
  const store=await fixture(t);
  await assert.rejects(
    store.updateState(state=>{
      state.externalTaskDecisions=[{
        id:'xd_safe',
        source:'getnote_cli',
        externalId:'getnote-task-1',
        sourceNoteId:'note-1',
        disposition:'dismissed',
        decidedAt:'2026-08-16T00:00:00Z',
        text:'不应进入 tombstone 的正文'
      }];
    }),
    /不是允许的来源决策字段/
  );

  await assert.rejects(
    store.updateState(state=>{
      state.externalTaskDecisions=[{
        id:'xd_safe',
        source:'getnote_cli',
        externalId:'getnote-task-1',
        sourceNoteId:'note-1',
        disposition:'archive_forever',
        decidedAt:'2026-08-16T00:00:00Z'
      }];
    }),
    /disposition 不受支持/
  );
});

test('GetNote due-date ownership is fail-closed to source or user',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>applyGetnoteTaskSnapshot(state,{active:[sourceTask({
    dueDate:'2026-08-20',
    dueAt:'2026-08-20'
  })]}));

  await assert.rejects(
    store.updateState(state=>{state.todos[0].dueDateOwner='assistant';}),
    /dueDateOwner 必须是 source 或 user/
  );
});
