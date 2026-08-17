import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessPolicy, createCapabilityRegistry, createLegacyMcpProvider, createToolBroker } from '../src/harness-core/index.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from '../src/harness-policy.mjs';

test('read tools on the navigator allowlist are ALLOW',()=>{
  const policy=createHarnessPolicy();
  const decision=policy.decide({actor:'harness',session:null,tool:'project_list',effect:'read',risk:'read'});
  assert.equal(decision.decision,'ALLOW');
});

test('requiresConfirmation tools are APPROVAL_REQUIRED and delegated',()=>{
  const policy=createHarnessPolicy({mutatingNames:['todo_create']});
  const decision=policy.decide({actor:'user',session:null,tool:'todo_create',effect:'write',risk:'local-write'});
  assert.equal(decision.decision,'APPROVAL_REQUIRED');
  assert.equal(decision.delegate,'mcp-confirmation');
});

test('joycrew mutate delegates to existing prepare/execute',()=>{
  const policy=createHarnessPolicy({mutatingNames:['joycrew_run_execute']});
  const decision=policy.decide({actor:'user',session:null,tool:'joycrew_run_execute',effect:'write',risk:'external-write'});
  assert.equal(decision.decision,'APPROVAL_REQUIRED');
  assert.equal(decision.delegate,'joycrew-prepare-execute');
});

test('unknown tool is DENY',()=>{
  const policy=createHarnessPolicy();
  const decision=policy.decide({actor:'harness',session:null,tool:'shell_exec',effect:'write',risk:'destructive'});
  assert.equal(decision.decision,'DENY');
});

test('broker does not call provider when approval is required and unconfirmed',async()=>{
  const calls=[];
  const mcp={
    list:()=>[{name:'todo_create',requiresConfirmation:true,readOnly:false}],
    async call(name){calls.push(name);return {result:{ok:true}};}
  };
  const registry=createCapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.write',toolNames:['todo_create']}]
  }));
  const broker=createToolBroker({
    registry,
    policy:createHarnessPolicy({mutatingNames:['todo_create']})
  });
  await assert.rejects(
    ()=>broker.call({name:'todo_create',arguments:{title:'x'},options:{}}),
    error=>error.code==='MCP_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(calls,[]);
});

test('legacy allowlist module still exports the same 21 tools',()=>{
  assert.equal(HARNESS_NAVIGATOR_TOOL_ALLOWLIST.length,21);
  assert.equal(HARNESS_NAVIGATOR_TOOL_ALLOWLIST.includes('todo_create'),false);
});
