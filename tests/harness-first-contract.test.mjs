import test from 'node:test';
import assert from 'node:assert/strict';

import { createCapabilityRegistry } from '../platform/registry/capability-registry.mjs';
import { createApprovalEngine } from '../platform/runtime/approval-engine.mjs';
import { createToolBroker } from '../platform/runtime/tool-broker.mjs';
import { createSessionManager } from '../platform/runtime/session-manager.mjs';
import { createScheduler } from '../platform/runtime/scheduler.mjs';
import { createAgentRegistry } from '../platform/runtime/agent-registry.mjs';
import { validatePluginManifest, validateCapabilityManifest } from '../platform/contracts/manifests.mjs';
import { personalWorkbenchApp } from '../apps/personal-workbench/manifest.mjs';

test('first principle: core registry does not know business-specific capability names', () => {
  const registry=createCapabilityRegistry();
  registry.register({
    id:'example.readonly',
    version:'1.0.0',
    kind:'information-source',
    tools:[{name:'example.latest',risk:'read',inputSchema:{type:'object'}}]
  });
  assert.equal(registry.has('example.readonly'),true);
  assert.deepEqual(registry.list().map(item=>item.id),['example.readonly']);
});

test('capabilities are installable without changing harness core', () => {
  const registry=createCapabilityRegistry();
  registry.register({id:'aihot',version:'1.0.0',kind:'information-source',tools:[]});
  registry.register({id:'feishu',version:'1.0.0',kind:'business-source',tools:[]});
  assert.deepEqual(registry.list().map(item=>item.id).sort(),['aihot','feishu']);
});

test('duplicate capability ids fail closed', () => {
  const registry=createCapabilityRegistry();
  registry.register({id:'project',version:'1.0.0',kind:'domain',tools:[]});
  assert.throws(()=>registry.register({id:'project',version:'2.0.0',kind:'domain',tools:[]}),/already registered/i);
});

test('approval engine maps risk to policy and requires explicit confirmation for external writes', () => {
  const approval=createApprovalEngine();
  assert.equal(approval.policyFor({risk:'read'}).mode,'auto');
  assert.equal(approval.policyFor({risk:'local-write'}).mode,'auto');
  assert.equal(approval.policyFor({risk:'external-write'}).mode,'confirm');
  assert.equal(approval.policyFor({risk:'destructive'}).mode,'explicit');
});

test('tool broker executes reads automatically and blocks unconfirmed external writes', async () => {
  const approval=createApprovalEngine();
  const broker=createToolBroker({approvalEngine:approval});
  broker.register({name:'demo.read',risk:'read',execute:async()=>({ok:true})});
  broker.register({name:'demo.write',risk:'external-write',execute:async()=>({ok:true})});
  assert.deepEqual(await broker.call('demo.read',{}),{ok:true});
  await assert.rejects(()=>broker.call('demo.write',{}),/approval required/i);
  assert.deepEqual(await broker.call('demo.write',{}, {confirmed:true}),{ok:true});
});

test('tool broker never lets a tool silently escalate its declared risk', () => {
  const approval=createApprovalEngine();
  const broker=createToolBroker({approvalEngine:approval});
  assert.throws(()=>broker.register({name:'bad.tool',risk:'unknown-risk',execute:async()=>null}),/unsupported risk/i);
});

test('sessions are durable business contexts, not just chat transcripts', async () => {
  const manager=createSessionManager();
  const created=await manager.create({
    id:'project:personal-ai-workbench',
    scope:'project',
    goal:'Rebuild as harness-first platform'
  });
  await manager.appendEvent(created.id,{type:'decision',data:{summary:'Harness owns Workbench'}});
  await manager.checkpoint(created.id,{summary:'foundation contract accepted'});
  const resumed=await manager.resume(created.id);
  assert.equal(resumed.scope,'project');
  assert.equal(resumed.goal,'Rebuild as harness-first platform');
  assert.equal(resumed.events.length,1);
  assert.equal(resumed.checkpoints.length,1);
});

test('scheduler resumes a session and delegates work instead of embedding business logic', async () => {
  const calls=[];
  const scheduler=createScheduler({dispatch:async job=>calls.push(job)});
  scheduler.register({id:'morning-brief',schedule:'0 8 * * *',agentId:'chief-of-staff',sessionId:'daily'});
  await scheduler.trigger('morning-brief',{now:'2026-08-17T08:00:00+08:00'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].agentId,'chief-of-staff');
  assert.equal(calls[0].sessionId,'daily');
});

test('agents declare capabilities instead of importing adapters directly', () => {
  const agents=createAgentRegistry();
  agents.register({
    id:'research-agent',
    instructions:'Research relevant developments.',
    capabilities:['aihot','web-research']
  });
  assert.deepEqual(agents.get('research-agent').capabilities,['aihot','web-research']);
});

test('plugin and capability manifests reject executable secrets and unsafe identifiers', () => {
  assert.equal(validatePluginManifest({id:'feishu',version:'1.0.0',adapter:'./adapter.mjs'}).ok,true);
  assert.equal(validateCapabilityManifest({id:'project',version:'1.0.0',kind:'domain'}).ok,true);
  assert.equal(validatePluginManifest({id:'../escape',version:'1.0.0',adapter:'./adapter.mjs'}).ok,false);
  assert.equal(validatePluginManifest({id:'bad',version:'1.0.0',adapter:'./adapter.mjs',token:'secret'}).ok,false);
});

test('personal workbench is an app declaration over capabilities, not the platform owner', () => {
  assert.equal(personalWorkbenchApp.id,'personal-workbench');
  assert.ok(personalWorkbenchApp.capabilities.includes('project'));
  assert.ok(personalWorkbenchApp.capabilities.includes('inbox'));
  assert.ok(personalWorkbenchApp.plugins.includes('feishu'));
  assert.equal(Object.hasOwn(personalWorkbenchApp,'server'),false);
});
