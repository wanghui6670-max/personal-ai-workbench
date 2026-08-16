import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { processInbox } from '../src/domain.mjs';
import { inboxContentHash } from '../src/inbox-ack.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-feishu-filter-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return store;
}

test('analysis/project/daily classifications leave Feishu source intact but disappear from local todo intake',async t=>{
  const store=await fixture(t);
  const sensitive='这是不应该进入活动日志的私人日记正文';
  await store.updateState(state=>{
    state.inbox.unshift({id:'in-1',text:sensitive,source:'feishu_doc',feishuBlockId:'blk-1',createdAt:'2026-08-16T01:00:00.000Z'});
    state.inboxAcks.push({blockId:'blk-1',contentHash:inboxContentHash(sensitive),acknowledgedAt:'2026-08-16T01:00:00.000Z'});
  });

  const result=await processInbox({store,itemId:'in-1',command:'不进入待办：analysis'});
  assert.equal(result.filtered,true);
  assert.equal(result.classification,'analysis');
  const state=await store.readState();
  assert.equal(state.inbox.length,0);
  assert.equal(state.todos.length,0);
  assert.equal(state.notes.length,0);
  assert.equal(state.inboxAcks.length,1,'source acknowledgement must remain so the same block is not re-imported');
  assert.equal(state.activities.at(-1)?.type,'feishu_non_todo_filtered');
  assert.doesNotMatch(JSON.stringify(state.activities),new RegExp(sensitive));
});

test('automatic Feishu filter command is rejected for manual inbox items',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>{
    state.inbox.unshift({id:'in-manual',text:'手工记录',source:'manual',createdAt:'2026-08-16T01:00:00.000Z'});
  });
  await assert.rejects(
    ()=>processInbox({store,itemId:'in-manual',command:'不进入待办：daily'}),
    error=>error?.statusCode===409
  );
  assert.equal((await store.readState()).inbox.length,1);
});
