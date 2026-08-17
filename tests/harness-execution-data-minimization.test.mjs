import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ExecutionReceiptStore} from '../src/harness-core/execution-receipt-store.mjs';
import {ExecutionRecorder} from '../src/harness-core/execution-recorder.mjs';

test('Execution receipt never persists unvalidated raw argument key names',async t=>{
  const dataDir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-execution-min-'));
  t.after(()=>fsp.rm(dataDir,{recursive:true,force:true}));
  const store=new ExecutionReceiptStore({dataDir});
  const recorder=new ExecutionRecorder({
    store,
    idFactory:()=> 'ex_sensitive_key',
    clock:(()=>{let i=0;return()=>`2026-08-17T15:20:0${i++}.000Z`;})()
  });
  const sensitiveKey='customer_alice_example_com';
  await recorder.run({
    tool:{name:'project_list',capabilityId:'workbench.v3.mcp',providerId:'workbench-v3-mcp'},
    args:{[sensitiveKey]:'value'},
    context:{trigger:'harness_mcp',actor:'harness-navigator',sessionId:null}
  },async()=>({result:[]}));

  const receipt=await store.read('ex_sensitive_key');
  const serialized=JSON.stringify(receipt);
  assert.equal(serialized.includes(sensitiveKey),false);
  assert.equal(receipt.argumentCount,1);
  assert.equal(Object.hasOwn(receipt,'argumentKeys'),false);
});
