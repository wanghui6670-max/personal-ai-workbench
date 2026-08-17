import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ExecutionReceiptStore} from '../src/harness-core/execution-receipt-store.mjs';
import {ExecutionRecorder} from '../src/harness-core/execution-recorder.mjs';

async function tempDataDir(t){
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-execution-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  return dir;
}

function deterministicRecorder(store){
  let clock=0;
  return new ExecutionRecorder({
    store,
    idFactory:()=> 'ex_test_1',
    clock:()=>`2026-08-17T15:00:0${clock++}.000Z`
  });
}

test('Execution receipts persist only audit metadata, never raw arguments, results or error messages',async t=>{
  const dataDir=await tempDataDir(t);
  const store=new ExecutionReceiptStore({dataDir});
  const recorder=deterministicRecorder(store);
  const tool={name:'customer_lookup',capabilityId:'crm.read',providerId:'crm-provider'};

  const success=await recorder.run({
    tool,
    args:{query:'secret-customer-name',token:'secret-token-value'},
    context:{trigger:'harness_mcp',actor:'harness-navigator',sessionId:null}
  },async()=>({result:{customer:'secret-result-name'}}));
  assert.deepEqual(success.outcome,{result:{customer:'secret-result-name'}});
  assert.equal(success.executionId,'ex_test_1');

  const receipt=await store.read('ex_test_1');
  assert.equal(receipt.status,'succeeded');
  assert.equal(receipt.toolName,'customer_lookup');
  assert.equal(receipt.capabilityId,'crm.read');
  assert.equal(receipt.providerId,'crm-provider');
  assert.deepEqual(receipt.argumentKeys,['query','token']);
  const serialized=JSON.stringify(receipt);
  for(const forbidden of ['secret-customer-name','secret-token-value','secret-result-name'])assert.equal(serialized.includes(forbidden),false);

  const failedStore=new ExecutionReceiptStore({dataDir});
  const failedRecorder=new ExecutionRecorder({
    store:failedStore,
    idFactory:()=> 'ex_test_2',
    clock:(()=>{let i=2;return()=>`2026-08-17T15:00:0${i++}.000Z`;})()
  });
  await assert.rejects(()=>failedRecorder.run({
    tool,
    args:{query:'another-secret'},
    context:{trigger:'harness_mcp',actor:'harness-navigator'}
  },async()=>{throw Object.assign(new Error('sensitive customer failure details'),{code:'CRM_TIMEOUT'});}),/sensitive customer failure details/);
  const failed=await store.read('ex_test_2');
  assert.equal(failed.status,'failed');
  assert.equal(failed.errorCode,'CRM_TIMEOUT');
  assert.equal(JSON.stringify(failed).includes('sensitive customer failure details'),false);
});

test('Execution store uses private immutable start/finish receipts and treats a missing finish as incomplete',async t=>{
  const dataDir=await tempDataDir(t);
  const store=new ExecutionReceiptStore({dataDir});
  await store.ensure();
  const harnessDir=path.join(dataDir,'harness');
  const executionsDir=path.join(harnessDir,'executions');
  assert.equal((await fsp.stat(harnessDir)).mode&0o777,0o700);
  assert.equal((await fsp.stat(executionsDir)).mode&0o777,0o700);

  await store.writeStart({
    version:1,id:'ex_incomplete',trigger:'harness_mcp',actor:'harness-navigator',sessionId:null,
    toolName:'project_list',capabilityId:'workbench.v3.mcp',providerId:'workbench-v3-mcp',argumentKeys:[],startedAt:'2026-08-17T15:00:00.000Z'
  });
  const incomplete=await store.read('ex_incomplete');
  assert.equal(incomplete.status,'incomplete');
  const startStat=await fsp.stat(path.join(executionsDir,'execution-ex_incomplete-start.json'));
  assert.equal(startStat.mode&0o777,0o600);
});

test('Execution store rejects unsafe extra fields and unsafe symlinked directories',async t=>{
  const dataDir=await tempDataDir(t);
  const store=new ExecutionReceiptStore({dataDir});
  await assert.rejects(()=>store.writeStart({
    version:1,id:'ex_unsafe',trigger:'harness_mcp',actor:'harness-navigator',sessionId:null,
    toolName:'project_list',capabilityId:'workbench.v3.mcp',providerId:'workbench-v3-mcp',argumentKeys:[],startedAt:'2026-08-17T15:00:00.000Z',
    args:{secret:'must-not-persist'}
  }),error=>error?.code==='EXECUTION_RECEIPT_UNSAFE_FIELD');

  const target=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-execution-target-'));
  t.after(()=>fsp.rm(target,{recursive:true,force:true}));
  await fsp.symlink(target,path.join(dataDir,'harness'));
  const unsafe=new ExecutionReceiptStore({dataDir});
  await assert.rejects(()=>unsafe.ensure(),/Harness execution receipt 目录不是安全目录/);
});
