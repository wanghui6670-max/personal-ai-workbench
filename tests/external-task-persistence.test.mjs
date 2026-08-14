import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { updateExternalTaskIntegration, syncExternalTasks } from '../src/task-sync-domain.mjs';

async function fixture(t,prefix='paw-external-persistence-'){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return{root,store};
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
    journalDocumentUrl:'https://example.feishu.cn/wiki/journal',
    calendarEnabled:true,
    calendarName:'个人工作日历'
  }});
  assert.equal(saved.enabled,true);
  assert.equal(saved.provider,'getnote_cli');
  const config=await store.readConfig();
  assert.equal(config.dataSource,null);
  assert.equal(config.settings.externalTaskPipeline.noteLimit,120);
  assert.equal(config.settings.externalTaskPipeline.cliFlavor,undefined);

  await syncExternalTasks({
    store,
    taskClient:{fetch:async()=>({
      provider:'getnote_cli',noteCount:1,todoCount:1,fetchedAt:'2026-08-14T00:00:00Z',
      completedAvailable:true,completedWarning:null,completed:[],
      active:[{
        externalId:'real-store-1',title:'2026-08-20 10:00 提交真实存储待办',content:'',description:'',
        done:false,priority:0,priorityLabel:'',startAt:null,dueAt:'2026-08-20T10:00:00',dueDate:'2026-08-20',
        allDay:false,timeZone:null,completedAt:null,updatedAt:'2026-08-14T00:00:00Z',tags:[],
        sourceNoteId:'note-1',sourceNoteTitle:'真实会议笔记',sourceNoteUrl:'https://www.biji.com/note/note-1',todoSource:'summary_section'
      }]
    })},
    journalClient:{appendTasks:async()=>({item:{blockId:'journal-1'},replayed:false})},
    calendarWriter:async()=>({enabled:true,path:path.join(root,'calendar.ics'),eventCount:1,writtenAt:'2026-08-14T01:00:00Z'})
  });

  const state=await store.readState();
  const todo=state.todos.find(item=>item.externalId==='real-store-1');
  assert.ok(todo);
  assert.equal(todo.source,'getnote_cli');
  assert.equal(todo.dueDate,'2026-08-20');
  assert.equal(todo.dueAt,'2026-08-20T10:00:00');
  assert.equal(todo.sourceNoteId,'note-1');
  assert.equal(todo.sourceNoteTitle,'真实会议笔记');
  assert.match(todo.context,/https:\/\/www\.biji\.com\/note\/note-1/);
  assert.equal(state.todayPlan.includes(todo.id),false);
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
