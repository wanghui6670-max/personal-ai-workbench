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

test('real JsonStore persists the new integration and validates imported task metadata',async t=>{
  const {root,store}=await fixture(t);
  await store.updateConfig(config=>{
    config.dataSource={provider:'feishu_doc',documentUrl:'https://example.feishu.cn/wiki/legacy',inboxHeading:'收件箱',inboxPrefix:'[INBOX]'};
    return true;
  });

  const saved=await updateExternalTaskIntegration({store,patch:{
    enabled:true,
    cliFlavor:'dida365',
    journalDocumentUrl:'https://example.feishu.cn/wiki/journal',
    calendarEnabled:true,
    calendarName:'个人工作日历'
  }});
  assert.equal(saved.enabled,true);
  const config=await store.readConfig();
  assert.equal(config.dataSource,null);
  assert.equal(config.settings.externalTaskPipeline.cliFlavor,'dida365');

  await syncExternalTasks({
    store,
    taskClient:{fetch:async()=>({
      provider:'dida_cli',cliFlavor:'dida365',host:'dida365.com',fetchedAt:'2026-08-14T00:00:00Z',
      completedAvailable:true,completedWarning:null,completed:[],
      active:[{
        externalId:'real-store-1',externalProjectId:'project-1',title:'真实存储待办',content:'保留外部元数据',description:'',
        done:false,status:0,statusLabel:'normal',priority:3,priorityLabel:'high',
        startAt:'2026-08-20T09:00:00+08:00',dueAt:'2026-08-20T10:00:00+08:00',dueDate:'2026-08-20',
        allDay:false,timeZone:'Asia/Shanghai',completedAt:null,updatedAt:'2026-08-14T00:00:00Z',tags:['工作']
      }]
    })},
    journalClient:{appendTasks:async()=>({item:{blockId:'journal-1'},replayed:false})},
    calendarWriter:async()=>({enabled:true,path:path.join(root,'calendar.ics'),eventCount:1,writtenAt:'2026-08-14T01:00:00Z'})
  });

  const state=await store.readState();
  const todo=state.todos.find(item=>item.externalId==='real-store-1');
  assert.ok(todo);
  assert.equal(todo.source,'dida_cli');
  assert.equal(todo.dueDate,'2026-08-20');
  assert.equal(todo.startAt,'2026-08-20T09:00:00+08:00');
  assert.deepEqual(todo.tags,['工作']);
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
