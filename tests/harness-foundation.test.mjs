import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CapabilityRegistry,HarnessRuntime,ApprovalEngine,SessionStore,nextRunAt} from '../platform/index.mjs';
import {createAihotProofPack} from '../platform/examples/aihot-pack.mjs';
import {personalWorkbenchPack} from '../packs/personal-workbench/manifest.mjs';

test('first-principles core installs business packs without knowing their domain',()=>{
  const registry=new CapabilityRegistry();
  registry.install(personalWorkbenchPack);
  assert.equal(registry.getCapability('workbench.project').packId,'personal-workbench');
  assert.equal(registry.listPacks().length,1);
});

test('duplicate capability registration fails closed',()=>{
  const registry=new CapabilityRegistry();
  registry.install(personalWorkbenchPack);
  assert.throws(()=>registry.install({...personalWorkbenchPack,id:'personal-workbench-copy'}),/already registered/);
});

test('AIHot proof pack installs without any harness-core modification',async()=>{
  const runtime=new HarnessRuntime();
  runtime.install(createAihotProofPack({latest:async({limit})=>[{title:'Harness',limit}]}));
  assert.deepEqual(runtime.describe().packs,['aihot']);
  const output=await runtime.invoke('aihot.latest',{limit:3},{agentId:'research-agent'});
  assert.equal(output.ok,true);
  assert.deepEqual(output.result,[{title:'Harness',limit:3}]);
});

test('approval engine auto-runs reads and blocks external writes until confirmed',async()=>{
  const runtime=new HarnessRuntime({approval:new ApprovalEngine()});
  runtime.install({id:'test-pack',name:'Test',version:'1.0.0',tools:[
    {name:'test.read',risk:'read',execute:async()=>({ok:true})},
    {name:'test.write',risk:'external_write',execute:async()=>({written:true})},
    {name:'test.delete',risk:'destructive',execute:async()=>({deleted:true})}
  ]});
  assert.equal((await runtime.invoke('test.read')).ok,true);
  assert.deepEqual(await runtime.invoke('test.write'),{ok:false,status:'approval_required',approval:'confirm',risk:'external_write'});
  assert.equal((await runtime.invoke('test.write',{}, {approved:true})).ok,true);
  assert.equal((await runtime.invoke('test.delete',{}, {approved:true})).ok,false);
  assert.equal((await runtime.invoke('test.delete',{}, {explicit:true})).ok,true);
});

test('session store persists checkpoints and tool events atomically',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-session-'));
  const sessions=new SessionStore({root});
  await sessions.create({id:'project:personal-ai-workbench',scope:'project',goal:'Harness-first migration'});
  const runtime=new HarnessRuntime({sessions});
  runtime.install(createAihotProofPack({latest:async()=>[]}));
  await runtime.invoke('aihot.latest',{}, {sessionId:'project:personal-ai-workbench',agentId:'research-agent'});
  await sessions.checkpoint('project:personal-ai-workbench',{summary:'Foundation ready',memory:{decision:'Harness owns Workbench'}});
  const restored=await sessions.load('project:personal-ai-workbench');
  assert.equal(restored.goal,'Harness-first migration');
  assert.equal(restored.events.length,1);
  assert.equal(restored.checkpoints.at(-1).summary,'Foundation ready');
  assert.equal(restored.memory.decision,'Harness owns Workbench');
});

test('daily scheduler computes the next run deterministically',()=>{
  const from=new Date('2026-08-17T07:30:00');
  assert.equal(nextRunAt({type:'daily',time:'08:00',enabled:true},from).toISOString(),'2026-08-17T08:00:00.000Z');
});

test('Workbench v3 registry adapter preserves read/write boundaries while moving ownership to Harness',async()=>{
  const calls=[];
  const legacyRegistry={
    tools:[
      {name:'legacy.read',description:'read',readOnly:true,requiresConfirmation:false,inputSchema:{}},
      {name:'legacy.write',description:'write',readOnly:false,requiresConfirmation:true,inputSchema:{}}
    ],
    async call(name,args,options){calls.push({name,args,options});return {result:{name,confirmed:options.confirmed}};}
  };
  const {createWorkbenchV3RegistryPack}=await import('../platform/adapters/workbench-v3-registry-pack.mjs');
  const runtime=new HarnessRuntime();
  runtime.install(createWorkbenchV3RegistryPack({mcpRegistry:legacyRegistry}));
  assert.equal((await runtime.invoke('legacy.read',{q:1})).ok,true);
  assert.deepEqual(await runtime.invoke('legacy.write',{q:2}),{ok:false,status:'approval_required',approval:'confirm',risk:'external_write'});
  const written=await runtime.invoke('legacy.write',{q:2},{approved:true});
  assert.equal(written.ok,true);
  assert.equal(written.result.confirmed,true);
  assert.deepEqual(calls.map(call=>call.name),['legacy.read','legacy.write']);
});
