import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { batchDeleteInboxLocal } from '../src/inbox-batch-domain.mjs';
import { inboxContentHash } from '../src/inbox-ack.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-batch-delete-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return store;
}

test('batch delete removes selected local inbox items in one state update while preserving Feishu acknowledgements',async t=>{
  const store=await fixture(t);
  const sensitiveA='私人飞书日记 A';
  const sensitiveB='私人飞书日记 B';
  await store.updateState(state=>{
    state.inbox.unshift(
      {id:'in-a',text:sensitiveA,source:'feishu_doc',feishuBlockId:'blk-a',createdAt:'2026-08-16T01:00:00.000Z'},
      {id:'in-b',text:sensitiveB,source:'feishu_doc',feishuBlockId:'blk-b',createdAt:'2026-08-16T01:00:00.000Z'},
      {id:'in-keep',text:'保留',source:'manual',createdAt:'2026-08-16T01:00:00.000Z'}
    );
    state.inboxAcks.push(
      {blockId:'blk-a',contentHash:inboxContentHash(sensitiveA),acknowledgedAt:'2026-08-16T01:00:00.000Z'},
      {blockId:'blk-b',contentHash:inboxContentHash(sensitiveB),acknowledgedAt:'2026-08-16T01:00:00.000Z'}
    );
    state.confirmations.unshift({id:'cf-a',inboxId:'in-a',type:'inbox_intent_unclear',text:'待确认',createdAt:'2026-08-16T01:00:00.000Z'});
  });

  const result=await batchDeleteInboxLocal({store,itemIds:['in-a','in-b','missing']});
  assert.equal(result.requested,3);
  assert.equal(result.deleted,2);
  assert.equal(result.missing,1);
  assert.deepEqual(new Set(result.deletedIds),new Set(['in-a','in-b']));

  const state=await store.readState();
  assert.deepEqual(state.inbox.map(item=>item.id),['in-keep']);
  assert.equal(state.inboxAcks.length,2,'Feishu seen-source acknowledgements must remain');
  assert.equal(state.confirmations.some(item=>item.inboxId==='in-a'),false);
  assert.equal(state.activities.at(-1)?.type,'inbox_batch_deleted');
  assert.doesNotMatch(JSON.stringify(state.activities),new RegExp(`${sensitiveA}|${sensitiveB}`));
});

test('batch delete rejects empty and oversized requests',async t=>{
  const store=await fixture(t);
  await assert.rejects(()=>batchDeleteInboxLocal({store,itemIds:[]}),error=>error?.statusCode===400);
  await assert.rejects(()=>batchDeleteInboxLocal({store,itemIds:Array.from({length:501},(_,index)=>`in-${index}`)}),error=>error?.statusCode===400);
});
