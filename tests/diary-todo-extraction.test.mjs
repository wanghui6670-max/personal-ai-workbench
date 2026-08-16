import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { applyDiaryTodoExtraction } from '../src/diary-todo-extraction.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-diary-extract-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));await store.ensure();return store;
}

test('raw mixed diary block is replaced by atomic todo candidates without creating Todo or Today',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>{
    state.projects.push({id:'p-1',name:'常金米业',archived:false,completed:false});
    state.inbox.push({id:'in-raw',text:'很长的复盘背景，然后补发报价单，并联系常金米业确认采购截图。',source:'feishu_doc',feishuBlockId:'blk-1',feishuMode:'mixed_diary',feishuHeadingPath:['8月16日'],createdAt:'2026-08-16T01:00:00.000Z'});
    state.inboxAcks.push({blockId:'blk-1',acknowledgedAt:'2026-08-16T01:00:00.000Z'});
  });
  const result=await applyDiaryTodoExtraction({store,itemId:'in-raw',candidates:[
    {text:'补发报价单',dueDate:null,targetProjectId:null,confidence:.91,reason:'明确下一步动作'},
    {text:'联系常金米业确认采购截图',dueDate:'2026-08-20',targetProjectId:'p-1',confidence:.9,reason:'明确项目动作'}
  ]});
  assert.equal(result.extracted,2);
  const state=await store.readState();
  assert.equal(state.inbox.some(item=>item.id==='in-raw'),false);
  assert.deepEqual(state.inbox.map(item=>item.text),['补发报价单','联系常金米业确认采购截图']);
  assert.ok(state.inbox.every(item=>item.source==='feishu_todo_candidate'));
  assert.ok(state.inbox.every(item=>item.feishuSourceBlockId==='blk-1'));
  assert.equal(state.inbox[1].suggestedProjectId,'p-1');
  assert.equal(state.inbox[1].suggestedDueDate,'2026-08-20');
  assert.equal(state.todos.length,0);
  assert.equal(state.todayPlan.length,0);
  assert.equal(state.inboxAcks.length,1,'source ACK remains so normal Feishu sync never re-imports the raw block');
  assert.doesNotMatch(JSON.stringify(state.activities),/很长的复盘背景/,'activity log must not copy private diary narrative');
});

test('zero extracted todos removes raw diary block but keeps source acknowledgement',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>{
    state.inbox.push({id:'in-analysis',text:'采集库的价值是选题和结构。',source:'feishu_doc',feishuBlockId:'blk-a',feishuMode:'mixed_diary',createdAt:'2026-08-16T01:00:00.000Z'});
    state.inboxAcks.push({blockId:'blk-a',acknowledgedAt:'2026-08-16T01:00:00.000Z'});
  });
  const result=await applyDiaryTodoExtraction({store,itemId:'in-analysis',candidates:[]});
  assert.equal(result.filtered,true);
  const state=await store.readState();
  assert.equal(state.inbox.length,0);assert.equal(state.inboxAcks.length,1);assert.equal(state.todos.length,0);
});

test('candidate extraction exact-deduplicates against existing pending items and todos',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>{
    state.inbox.push({id:'in-existing',text:'补发报价单',source:'manual',createdAt:'2026-08-16T00:00:00.000Z'});
    state.inbox.push({id:'in-raw',text:'复盘后记得补发报价单',source:'feishu_doc',feishuBlockId:'blk-2',feishuMode:'mixed_diary',createdAt:'2026-08-16T01:00:00.000Z'});
    state.inboxAcks.push({blockId:'blk-2',acknowledgedAt:'2026-08-16T01:00:00.000Z'});
  });
  const result=await applyDiaryTodoExtraction({store,itemId:'in-raw',candidates:[{text:'补发报价单',dueDate:null,targetProjectId:null,confidence:.9,reason:'重复'}]});
  assert.equal(result.extracted,0);assert.equal(result.deduped,1);
  const state=await store.readState();assert.deepEqual(state.inbox.map(item=>item.id),['in-existing']);
});

test('extraction cannot operate on manual or already-extracted candidates',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>state.inbox.push({id:'in-manual',text:'手工事项',source:'manual',createdAt:'2026-08-16T01:00:00.000Z'}));
  await assert.rejects(()=>applyDiaryTodoExtraction({store,itemId:'in-manual',candidates:[]}),error=>error?.statusCode===409);
});
