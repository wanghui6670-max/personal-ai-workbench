import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {CapabilityRegistry} from '../src/harness-core/capability-registry.mjs';
import {ToolBroker} from '../src/harness-core/tool-broker.mjs';
import {ToolPolicy} from '../src/harness-core/tool-policy.mjs';

function tool(overrides={}){
  return{
    name:'project_list',
    capabilityId:'workbench.v3.mcp',
    providerId:'workbench-v3-mcp',
    effect:'read',
    readOnly:true,
    requiresConfirmation:false,
    ...overrides
  };
}

test('shadow Tool Policy makes conservative effect-aware decisions without executing anything',()=>{
  const policy=new ToolPolicy({mode:'shadow'});

  assert.deepEqual(policy.evaluate({tool:tool(),options:{}}),{
    decision:'ALLOW',reason:'effect_safe',effect:'read',mode:'shadow'
  });
  assert.deepEqual(policy.evaluate({tool:tool({name:'panel_navigate',effect:'local_ephemeral'}),options:{}}),{
    decision:'ALLOW',reason:'effect_safe',effect:'local_ephemeral',mode:'shadow'
  });
  assert.deepEqual(policy.evaluate({tool:tool({name:'todo_today',effect:'local_write',readOnly:false,requiresConfirmation:true}),options:{}}),{
    decision:'APPROVAL_REQUIRED',reason:'legacy_confirmation_required',effect:'local_write',mode:'shadow'
  });
  assert.deepEqual(policy.evaluate({tool:tool({name:'unknown_write',effect:'write_unknown',readOnly:false}),options:{}}),{
    decision:'DENY',reason:'unapproved_write_effect',effect:'write_unknown',mode:'shadow'
  });
});

test('legacy route constraints take precedence over effect classification',()=>{
  const policy=new ToolPolicy({mode:'shadow'});
  assert.deepEqual(policy.evaluate({
    tool:tool({name:'customer_read'}),
    options:{allowedNames:['project_list']}
  }),{
    decision:'DENY',reason:'tool_not_allowlisted',effect:'read',mode:'shadow'
  });
  assert.deepEqual(policy.evaluate({
    tool:tool({name:'todo_today',effect:'local_write',readOnly:false,requiresConfirmation:true}),
    options:{readOnlyOnly:true,allowedNames:['todo_today']}
  }),{
    decision:'DENY',reason:'read_only_surface',effect:'local_write',mode:'shadow'
  });
});

test('Tool Broker evaluates shadow policy but does not enforce it in Slice 5',async()=>{
  const registry=new CapabilityRegistry();
  registry.registerProvider({
    id:'fixture-provider',
    capabilities:[{id:'fixture.write',toolNames:['fixture_write']}],
    tools:[{
      name:'fixture_write',capabilityId:'fixture.write',effect:'write_unknown',
      risk:'external_write',readOnly:false,requiresConfirmation:false,inputSchema:{}
    }]
  });
  const evaluations=[];
  const policy={
    mode:'shadow',
    evaluate(input){evaluations.push(input);return{decision:'DENY',reason:'unapproved_write_effect',effect:'write_unknown',mode:'shadow'};}
  };
  let providerCalls=0;
  const broker=new ToolBroker({registry,policy});
  broker.registerInvoker({providerId:'fixture-provider',invoke:async()=>{providerCalls+=1;return{result:'legacy-result'};}});

  const outcome=await broker.call('fixture_write',{value:1},{},{trigger:'test',actor:'test'});
  assert.deepEqual(outcome,{result:'legacy-result'});
  assert.equal(providerCalls,1,'shadow policy must not enforce in this slice');
  assert.equal(evaluations.length,1);
  assert.equal(evaluations[0].tool.name,'fixture_write');
});

test('server composes ToolPolicy in shadow mode without replacing legacy safety gates',async()=>{
  const source=await fsp.readFile('src/server.mjs','utf8');
  assert.match(source,/ToolPolicy/);
  assert.match(source,/new ToolPolicy\(\{mode:'shadow'\}\)/);
  assert.match(source,/new ToolBroker\(\{registry:harnessCapabilityRegistry,executionRecorder:harnessExecutionRecorder,policy:harnessToolPolicy\}\)/);
  assert.match(source,/createHarnessHttp\(\{navigator:harnessNavigator,mcpRegistry,toolBroker:harnessToolBroker\}\)/);
});
