import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { CaptureReceiptStore } from '../src/capture-receipts.mjs';
import { captureInbox } from '../src/capture-domain.mjs';

function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return{promise,resolve};
}

test('backup synthesizes a hash-only receipt while capture receipt persistence is in flight',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-capture-backup-race-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();

  const entered=deferred();
  const release=deferred();
  const originalWrite=CaptureReceiptStore.prototype.write;
  CaptureReceiptStore.prototype.write=async function(input){
    entered.resolve();
    await release.promise;
    return originalWrite.call(this,input);
  };
  t.after(()=>{CaptureReceiptStore.prototype.write=originalWrite;});

  const captureId='capture-backup-race-01';
  const text='备份不得在收据写入窗口丢失采集幂等身份';
  const capturePromise=captureInbox({store,captureId,text});
  await entered.promise;

  const backupPath=await store.backupNow();
  const payload=JSON.parse(await fsp.readFile(backupPath,'utf8'));
  const receipt=payload.captureReceipts.find(item=>item.captureId===captureId);
  assert.ok(receipt);
  assert.match(receipt.contentHash,/^[a-f0-9]{64}$/);
  assert.equal(receipt.inboxId,payload.state.inbox.find(item=>item.captureId===captureId).id);
  assert.doesNotMatch(JSON.stringify(receipt),new RegExp(text));

  release.resolve();
  await capturePromise;
  assert.equal((await store.listCaptureReceipts()).filter(item=>item.captureId===captureId).length,1);
});
