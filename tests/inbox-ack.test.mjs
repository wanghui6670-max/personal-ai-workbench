import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { syncFeishuInbox, addInbox } from '../src/domain.mjs';
import { parseFeishuInboxXml } from '../src/feishu.mjs';
import { inboxContentHash } from '../src/inbox-ack.mjs';

function xml(items){
  return `<title id="doc">日记</title><h1 id="heading">收件箱</h1>${items.map(item=>`<p id="${item.id}">[INBOX] ${item.text}</p>`).join('')}<h1 id="journal">每日工作日记</h1>`;
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-inbox-ack-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  const config=await store.readConfig();
  await store.writeConfig({
    ...config,
    dataSource:{
      provider:'feishu_doc',
      documentUrl:'https://example.feishu.cn/wiki/inbox',
      inboxHeading:'收件箱',
      inboxPrefix:'[INBOX]',
      lastSyncStatus:'not_synced',
      lastImportedCount:0
    }
  });
  return store;
}

function clientFrom(getXml){
  return {
    fetch:async()=>{
      const content=getXml();
      return {content,revisionId:'7',documentId:'doc',...parseFeishuInboxXml(content)};
    }
  };
}

test('legacy plaintext inbox acknowledgements migrate to SHA-256 without retaining text',async t=>{
  const store=await fixture(t);
  const raw=JSON.parse(await fsp.readFile(store.stateFile,'utf8'));
  raw.inboxAcks=[{blockId:'blk_legacy',text:'旧敏感收件箱正文',acknowledgedAt:'2026-08-13T01:00:00.000Z'}];
  await fsp.writeFile(store.stateFile,JSON.stringify(raw,null,2),'utf8');

  await store.ensure();

  const state=await store.readState();
  assert.deepEqual(state.inboxAcks,[{
    blockId:'blk_legacy',
    contentHash:inboxContentHash('旧敏感收件箱正文'),
    acknowledgedAt:'2026-08-13T01:00:00.000Z'
  }]);
  const persisted=await fsp.readFile(store.stateFile,'utf8');
  assert.doesNotMatch(persisted,/旧敏感收件箱正文/);
  assert.doesNotMatch(persisted,/"text"\s*:/);
});

test('Feishu sync stores only a content hash and unchanged blocks do not re-import',async t=>{
  const store=await fixture(t);
  let current=xml([{id:'blk_1',text:'需要处理的事项'}]);
  const client=clientFrom(()=>current);

  let result=await syncFeishuInbox({store,client});
  assert.equal(result.imported,1);
  let state=await store.readState();
  assert.equal(state.inbox.length,1);
  assert.deepEqual(state.inboxAcks,[{
    blockId:'blk_1',
    contentHash:inboxContentHash('需要处理的事项'),
    acknowledgedAt:state.inboxAcks[0].acknowledgedAt
  }]);
  assert.equal(Object.hasOwn(state.inboxAcks[0],'text'),false);

  await store.updateState(next=>{next.inbox=[];});
  result=await syncFeishuInbox({store,client});
  assert.equal(result.imported,0);
  assert.equal(result.seenSkipped,1);
  assert.equal((await store.readState()).inbox.length,0);
});

test('editing an acknowledged Feishu block never re-imports it and preserves the first-seen hash',async t=>{
  const store=await fixture(t);
  let current=xml([{id:'blk_edit',text:'原内容'}]);
  const client=clientFrom(()=>current);
  await syncFeishuInbox({store,client});
  await store.updateState(state=>{state.inbox=[];});

  current=xml([{id:'blk_edit',text:'编辑后的内容'}]);
  const result=await syncFeishuInbox({store,client});
  assert.equal(result.imported,0);
  assert.equal(result.updated,0);
  assert.equal(result.seenSkipped,1);
  const state=await store.readState();
  assert.equal(state.inbox.length,0);
  assert.equal(state.inboxAcks[0].contentHash,inboxContentHash('原内容'));
});

test('remote deletion never mutates local pending state and seen acknowledgements remain permanent',async t=>{
  const store=await fixture(t);
  let current=xml([{id:'blk_delete',text:'删除后仍由本地决定是否处理'}]);
  const client=clientFrom(()=>current);
  await syncFeishuInbox({store,client});
  const item=(await store.readState()).inbox[0];
  await store.updateState(state=>{
    state.confirmations.push({
      id:'cf_delete',
      type:'inbox_intent_unclear',
      inboxId:item.id,
      text:'关联待确认',
      createdAt:'2026-08-13T01:00:00.000Z'
    });
  });

  current=xml([]);
  const result=await syncFeishuInbox({store,client});
  assert.equal(result.removed,0);
  const state=await store.readState();
  assert.equal(state.inbox.length,1);
  assert.equal(state.inboxAcks.length,1);
  assert.equal(state.confirmations.some(entry=>entry.inboxId===item.id),true);
});

test('a deleted remote block that later reappears is still treated as already seen',async t=>{
  const store=await fixture(t);
  let current=xml([{id:'blk_reappear',text:'第一次出现'}]);
  const client=clientFrom(()=>current);
  await syncFeishuInbox({store,client});
  await store.updateState(state=>{state.inbox=[];});

  current=xml([]);
  await syncFeishuInbox({store,client});
  current=xml([{id:'blk_reappear',text:'重新出现但内容改了'}]);
  const result=await syncFeishuInbox({store,client});
  assert.equal(result.imported,0);
  assert.equal(result.seenSkipped,1);
  assert.equal((await store.readState()).inbox.length,0);
});

test('remote-first local capture stores a hash-only acknowledgement after readback',async t=>{
  const store=await fixture(t);
  const client={
    appendAndFetch:async(_config,text)=>({
      item:{blockId:'blk_capture',text},
      revisionId:'8',
      items:[{blockId:'blk_capture',text}]
    })
  };
  await addInbox({store,text:'手机采集内容',source:'iphone-shortcut',client});
  const state=await store.readState();
  assert.equal(state.inboxAcks[0].blockId,'blk_capture');
  assert.equal(state.inboxAcks[0].contentHash,inboxContentHash('手机采集内容'));
  assert.equal(Object.hasOwn(state.inboxAcks[0],'text'),false);
});
