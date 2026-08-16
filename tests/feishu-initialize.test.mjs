import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { syncFeishuInbox } from '../src/inbox-domain.mjs';
import { inboxContentHash } from '../src/inbox-ack.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-feishu-init-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  const config=await store.readConfig();
  await store.writeConfig({...config,dataSource:{
    provider:'feishu_doc',documentUrl:'https://example.feishu.cn/wiki/init',
    inboxHeading:'收件箱',inboxPrefix:'[INBOX]',lastRevisionId:'seeded',
    lastSyncAt:null,lastSyncStatus:'ok',lastSyncError:null,lastImportedCount:70
  }});
  return store;
}

function remoteItems(count){
  return Array.from({length:count},(_,index)=>({
    blockId:`b${index}`,text:`初始化日记内容 ${index}`,rawText:`初始化日记内容 ${index}`,
    tag:'p',headingPath:['2026-08-16'],explicitInbox:false,order:index
  }));
}

test('explicit initialization rebuilds the whole current diary once, then normal sync returns to append-only',async t=>{
  const store=await fixture(t);
  let items=remoteItems(70);
  let revision=10;
  await store.updateState(state=>{
    state.inbox=[];
    state.inboxAcks=items.map(item=>({blockId:item.blockId,contentHash:inboxContentHash(item.text),acknowledgedAt:'2026-08-16T06:00:00.000Z'}));
  });
  const client={fetch:async()=>({mode:'mixed_diary',sectionFound:false,revisionId:revision,items})};

  const before=await syncFeishuInbox({store,client});
  assert.equal(before.imported,0);
  assert.equal(before.seenSkipped,70);
  assert.equal((await store.readState()).inbox.length,0);

  const initialized=await syncFeishuInbox({store,client,initialize:true});
  assert.equal(initialized.initialized,true);
  assert.equal(initialized.imported,70);
  assert.equal(initialized.baselined,0);
  assert.equal(initialized.firstMixedSync,false);
  let state=await store.readState();
  assert.equal(state.inbox.length,70);
  assert.equal(state.inboxAcks.length,70);
  let config=await store.readConfig();
  assert.match(config.dataSource.initialImportAt,/^2026-|^20\d\d-/);

  await store.updateState(next=>{next.inbox=[];});
  revision=11;
  const same=await syncFeishuInbox({store,client});
  assert.equal(same.imported,0);
  assert.equal(same.seenSkipped,70);
  assert.equal((await store.readState()).inbox.length,0);

  items=[...items,{blockId:'b70',text:'初始化之后新增的待办',rawText:'初始化之后新增的待办',tag:'checkbox',headingPath:['2026-08-16'],explicitInbox:false,order:70}];
  revision=12;
  const after=await syncFeishuInbox({store,client});
  assert.equal(after.imported,1);
  state=await store.readState();
  assert.equal(state.inbox.length,1);
  assert.equal(state.inbox[0].feishuBlockId,'b70');
  assert.equal(state.inboxAcks.length,71);
});
