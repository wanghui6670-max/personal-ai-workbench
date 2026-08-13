import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { CaptureReceiptStore } from '../src/capture-receipts.mjs';
import { captureInbox } from '../src/capture-domain.mjs';

function emptyState(overrides={}){
  return {
    schemaVersion:1,inbox:[],inboxAcks:[],todos:[],todayPlan:[],todayPlanDate:null,
    projects:[],confirmations:[],notes:[],activities:[],morningSessions:[],
    ...overrides
  };
}

async function fixture(t,label='workbench-backup-receipts-'){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),label));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return {root,store,captures:new CaptureReceiptStore(store.dataDir)};
}

async function seedReceipts(store,captures,{captureId='capture-backup-01',operationId='pa_backup_01'}={}){
  await captures.write({
    captureId,
    text:'不应进入备份的采集正文',
    inboxId:'in_processed_capture',
    feishuBlockId:'capture_block_01',
    createdAt:'2026-08-13T10:00:00.000Z'
  });
  await store.writeProjectRecordReceipt({
    operationId,
    kind:'analysis',
    projectId:'p_backup',
    documentUrl:'https://example.feishu.cn/wiki/project',
    revisionId:'12',
    blockId:'project_block_12',
    recordedAt:'2026-08-13T10:01:00.000Z',
    projectSnapshotHash:'a'.repeat(64),
    machineProgress:{percent:35,status:'进行中',hasBlocker:false,confidence:.8},
    phase:'remote_saved_local_pending'
  });
}

test('manual and daily backups include hash-only capture and project recovery receipts',async t=>{
  const {store,captures}=await fixture(t);
  await seedReceipts(store,captures);

  await store.writeState(emptyState({
    projects:[{id:'p_backup',name:'备份项目',endDate:'2026-09-01'}]
  }));
  const dailyName=(await fsp.readdir(store.backupDir)).find(name=>/^state-\d{4}-\d{2}-\d{2}\.json$/.test(name));
  assert.ok(dailyName);
  const daily=JSON.parse(await fsp.readFile(path.join(store.backupDir,dailyName),'utf8'));
  const manual=JSON.parse(await fsp.readFile(await store.backupNow(),'utf8'));

  for(const payload of [daily,manual]){
    assert.equal(payload.backupVersion,2);
    assert.equal(payload.captureReceipts.length,1);
    assert.equal(payload.projectRecordReceipts.length,1);
    assert.match(payload.captureReceipts[0].contentHash,/^[a-f0-9]{64}$/);
    assert.equal(payload.projectRecordReceipts[0].operationId,'pa_backup_01');
    assert.equal(
      payload.state.confirmations.some(item=>item.type==='project_record_recovery_pending'),
      false,
      'synthetic recovery confirmations must not be persisted into backups'
    );
    assert.doesNotMatch(JSON.stringify(payload),/不应进入备份的采集正文/);
  }
});

test('full restore replaces receipt sets and preserves processed capture replay safety',async t=>{
  const {store,captures}=await fixture(t,'workbench-restore-receipts-');
  await seedReceipts(store,captures);
  await store.writeState(emptyState({
    projects:[{id:'p_backup',name:'备份项目',endDate:'2026-09-01'}]
  }));
  const payload=JSON.parse(await fsp.readFile(await store.backupNow(),'utf8'));

  await seedReceipts(store,captures,{captureId:'capture-later-02',operationId:'pa_later_02'});
  assert.equal((await store.listCaptureReceipts()).length,2);
  assert.equal((await store.listProjectRecordReceipts()).length,2);

  await store.restore({
    state:payload.state,
    config:payload.config,
    includeConfig:true,
    captureReceipts:payload.captureReceipts,
    includeCaptureReceipts:true,
    projectRecordReceipts:payload.projectRecordReceipts,
    includeProjectRecordReceipts:true
  });

  assert.deepEqual((await store.listCaptureReceipts()).map(item=>item.captureId),['capture-backup-01']);
  assert.deepEqual((await store.listProjectRecordReceipts()).map(item=>item.operationId),['pa_backup_01']);
  const visible=await store.readState();
  assert.equal(visible.confirmations.some(item=>
    item.type==='project_record_recovery_pending'&&item.operationId==='pa_backup_01'
  ),true);

  const replay=await captureInbox({
    store,
    captureId:'capture-backup-01',
    text:'不应进入备份的采集正文',
    client:{appendAndFetch:async()=>{throw new Error('restored receipt replay must not write remotely');}}
  });
  assert.equal(replay.replayed,true);
  assert.equal(replay.processed,true);
  assert.equal(replay.item,null);
});

test('legacy restore without receipt fields preserves current idempotency credentials',async t=>{
  const {store,captures}=await fixture(t,'workbench-legacy-receipts-');
  await seedReceipts(store,captures);
  const config=await store.readConfig();

  await store.restore({state:emptyState(),config,includeConfig:true});

  assert.deepEqual((await store.listCaptureReceipts()).map(item=>item.captureId),['capture-backup-01']);
  assert.deepEqual((await store.listProjectRecordReceipts()).map(item=>item.operationId),['pa_backup_01']);
});

test('invalid receipt backup fails before state or credentials change',async t=>{
  const {store,captures}=await fixture(t,'workbench-invalid-receipts-');
  await seedReceipts(store,captures);
  const beforeState=await store.readState();
  const beforeCaptures=await store.listCaptureReceipts();
  const beforeProjects=await store.listProjectRecordReceipts();

  await assert.rejects(store.restore({
    state:emptyState(),
    captureReceipts:[{
      version:1,
      captureId:'capture-invalid-01',
      contentHash:'not-a-sha256',
      inboxId:null,
      feishuBlockId:null,
      createdAt:'2026-08-13T10:00:00.000Z'
    }],
    includeCaptureReceipts:true
  }),/contentHash 必须是 SHA-256/);

  assert.deepEqual(await store.readState(),beforeState);
  assert.deepEqual(await store.listCaptureReceipts(),beforeCaptures);
  assert.deepEqual(await store.listProjectRecordReceipts(),beforeProjects);
});
