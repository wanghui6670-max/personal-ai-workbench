import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { syncFeishuInbox } from '../src/domain.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-feishu-dedupe-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  const config=await store.readConfig();
  await store.writeConfig({
    ...config,
    dataSource:{
      provider:'feishu_doc',
      documentUrl:'https://example.feishu.cn/wiki/diary',
      inboxHeading:'收件箱',
      inboxPrefix:'[INBOX]',
      lastRevisionId:'seeded',
      lastSyncStatus:'not_synced',
      lastImportedCount:0
    }
  });
  return store;
}

function client(items,revisionId='9'){
  return{
    fetch:async()=>({
      items:items.map((item,index)=>({
        blockId:item.blockId,
        text:item.text,
        tag:item.tag||'p',
        headingPath:item.headingPath||['2026-08-16'],
        explicitInbox:false,
        order:index
      })),
      revisionId,
      documentId:'doc',
      sectionFound:false,
      mode:'mixed_diary'
    })
  };
}

test('exact repeated diary blocks import only once and both source blocks are acknowledged',async t=>{
  const store=await fixture(t);
  const syncClient=client([
    {blockId:'blk_old',text:'联系徐总确认下一次沟通时间'},
    {blockId:'blk_new',text:'联系徐总确认下一次沟通时间'}
  ]);

  const first=await syncFeishuInbox({store,client:syncClient});
  assert.equal(first.imported,1);
  assert.equal(first.deduped,1);
  assert.equal(first.remoteCount,2);
  assert.equal(first.uniqueRemoteCount,1);
  let state=await store.readState();
  assert.equal(state.inbox.length,1);
  assert.equal(state.inbox[0].text,'联系徐总确认下一次沟通时间');
  assert.equal(state.inboxAcks.length,2);

  const second=await syncFeishuInbox({store,client:syncClient});
  assert.equal(second.imported,0);
  state=await store.readState();
  assert.equal(state.inbox.length,1);
});

test('a duplicate of an existing todo is acknowledged but not re-imported for AI review',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>{
    state.todos.unshift({
      id:'td-existing',
      title:'补完固定开场 slogan 三个版本',
      context:'补完固定开场 slogan 三个版本',
      dueDate:'2026-08-20',
      projectId:null,
      done:false,
      createdAt:'2026-08-16T01:00:00.000Z'
    });
  });

  const result=await syncFeishuInbox({
    store,
    client:client([{blockId:'blk_repeat',text:'补完固定开场 slogan 三个版本'}])
  });
  const state=await store.readState();
  assert.equal(result.imported,0);
  assert.equal(result.deduped,1);
  assert.equal(state.inbox.length,0);
  assert.equal(state.inboxAcks.length,1);
});

test('dedupe normalization collapses harmless whitespace and Unicode width differences',async t=>{
  const store=await fixture(t);
  const result=await syncFeishuInbox({
    store,
    client:client([
      {blockId:'blk_a',text:'整理  3 个 slogan'},
      {blockId:'blk_b',text:'整理 3 个 slogan'}
    ])
  });
  assert.equal(result.imported,1);
  assert.equal(result.deduped,1);
  assert.equal((await store.readState()).inbox.length,1);
});
