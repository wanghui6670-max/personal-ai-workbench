import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { updateExternalTaskIntegration, syncExternalTasks } from '../src/task-sync-domain.mjs';
import {applyGetnoteTaskSnapshot} from '../src/external-task-reconcile.mjs';

async function fixture(t,prefix='paw-external-persistence-'){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return{root,store};
}

function sourceTask(overrides={}){
  return{
    externalId:'real-store-1',externalIdentityKind:'text_fingerprint',title:'2026-08-20 10:00 提交真实存储待办',content:'',description:'',
    done:false,priority:0,priorityLabel:'',startAt:null,dueAt:'2026-08-20T10:00:00',dueDate:'2026-08-20',
    allDay:false,timeZone:'Asia/Shanghai',completedAt:null,updatedAt:'2026-08-14T00:00:00Z',tags:[],
    sourceNoteId:'note-1',sourceNoteTitle:'真实会议笔记',sourceNoteType:'MEETING',
    sourceNoteCreatedAt:'2026-08-10T00:00:00Z',sourceNoteUpdatedAt:'2026-08-14T00:00:00Z',
    sourceNoteUrl:'https://www.biji.com/note/note-1',todoSource:'summary_section',
    ...overrides
  };
}

test('real JsonStore persists GetNote integration and imported note metadata',async t=>{
  const {root,store}=await fixture(t);
  await store.updateConfig(config=>{
    config.dataSource={provider:'feishu_doc',documentUrl:'https://example.feishu.cn/wiki/legacy',inboxHeading:'收件箱',inboxPrefix:'[INBOX]'};
    return true;
  });

  const saved=await updateExternalTaskIntegration({store,patch:{
    enabled:true,
    noteLimit:120,
    timeZone:'Asia/Shanghai',
    journalDocumentUrl:'https://example.feishu.cn/wiki/journal',
    calendarEnabled:true,
    calendarName:'个人工作日历'
  }});
  assert.equal(saved.enabled,true);
  assert.equal(saved.provider,'getnote_cli');
  assert.equal(saved.timeZone,'Asia/Shanghai');
  const config=await store.readConfig();
  assert.equal(config.dataSource,null);
  assert.equal(config.settings.externalTaskPipeline.noteLimit,120);
  assert.equal(config.settings.externalTaskPipeline.cliFlavor,undefined);

  await syncExternalTasks({
    store,
    taskClient:{fetch:async input=>{
      assert.equal(input.timeZone,'Asia/Shanghai');
      assert.deepEqual(input.trackedNotes,[]);
      return{
        provider:'getnote_cli',noteCount:1,recentNoteCount:1,trackedNoteCount:0,todoCount:1,fetchedAt:'2026-08-14T00:00:00Z',
        completedAvailable:true,completedWarning:null,completed:[],active:[sourceTask()]
      };
    }},
    journalClient:{appendTasks:async()=>({item:{blockId:'journal-1'},replayed:false})},
    calendarWriter:async()=>({enabled:true,path:path.join(root,'calendar.ics'),eventCount:1,writtenAt:'2026-08-14T01:00:00Z'})
  });

  const state=await store.readState();
  const todo=state.todos.find(item=>item.externalId==='real-store-1');
  assert.ok(todo);
  assert.equal(todo.source,'getnote_cli');
  assert.equal(todo.externalIdentityKind,'text_fingerprint');
  assert.equal(todo.dueDate,'2026-08-20');
  assert.equal(todo.dueAt,'2026-08-20T10:00:00');
  assert.equal(todo.timeZone,'Asia/Shanghai');
  assert.equal(todo.sourceNoteId,'note-1');
  assert.equal(todo.sourceNoteTitle,'真实会议笔记');
  assert.equal(todo.sourceNoteCreatedAt,'2026-08-10T00:00:00Z');
  assert.match(todo.context,/https:\/\/www\.biji\.com\/note\/note-1/);
  assert.equal(state.todayPlan.includes(todo.id),false);
});

test('dated -> Inbox -> dated local identity and user fields survive real JsonStore normalization',async t=>{
  const {store}=await fixture(t,'paw-external-state-roundtrip-');
  await store.updateState(state=>{
    state.projects.push({
      id:'p_local',name:'本地项目',intro:'',businessId:'biz_ai',folder:'本地项目',createdAt:'2026-08-01T00:00:00Z',startDate:'2026-08-01',endDate:'2026-09-01',git:'',feishu:'',sourceDescription:'',completed:false,archived:false
    });
    state.todos.push({
      id:'td_stable',title:'联系供应商',context:'',dueDate:'2026-08-20',done:false,projectId:'p_local',createdAt:'2026-08-10T00:00:00Z',
      priority:6,priorityLabel:'用户重要',tags:['客户','本地'],source:'getnote_cli',externalId:'stable-external',sourceNoteId:'note-stable'
    });
  });

  await store.updateState(state=>applyGetnoteTaskSnapshot(state,{active:[sourceTask({
    externalId:'stable-external',sourceNoteId:'note-stable',title:'联系供应商',dueDate:null,dueAt:null,startAt:null,allDay:true
  })]}));
  let persisted=await store.readState();
  assert.equal(persisted.todos.length,0);
  assert.equal(persisted.inbox.length,1);
  const inbox=persisted.inbox[0];
  assert.equal(inbox.id,'td_stable');
  assert.equal(inbox.workbenchEntityId,'td_stable');
  assert.equal(inbox.localProjectId,'p_local');
  assert.equal(inbox.localPriority,6);
  assert.equal(inbox.localPriorityLabel,'用户重要');
  assert.deepEqual(inbox.localTags,['客户','本地']);

  await store.updateState(state=>applyGetnoteTaskSnapshot(state,{active:[sourceTask({
    externalId:'stable-external',sourceNoteId:'note-stable',title:'联系供应商',dueDate:'2026-08-28',dueAt:'2026-08-28'
  })]}));
  persisted=await store.readState();
  assert.equal(persisted.inbox.length,0);
  const todo=persisted.todos.find(item=>item.externalId==='stable-external');
  assert.ok(todo);
  assert.equal(todo.id,'td_stable');
  assert.equal(todo.projectId,'p_local');
  assert.equal(todo.priority,6);
  assert.equal(todo.priorityLabel,'用户重要');
  assert.deepEqual(todo.tags,['客户','本地']);
  assert.equal(todo.createdAt,'2026-08-10T00:00:00Z');
});

test('unsafe Feishu journal URLs are rejected even when the integration remains disabled',async t=>{
  const {store}=await fixture(t,'paw-external-url-');
  await assert.rejects(
    updateExternalTaskIntegration({
      store,
      patch:{enabled:false,journalDocumentUrl:'javascript:alert(1)'}
    }),
    error=>error.statusCode===400&&error.code==='INVALID_FEISHU_JOURNAL'
  );
  const config=await store.readConfig();
  assert.equal(config.settings.externalTaskPipeline,undefined);
});
