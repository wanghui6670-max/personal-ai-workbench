import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry} from '../src/harness-core/capability-registry.mjs';
import {ToolBroker} from '../src/harness-core/tool-broker.mjs';
import {createLegacyMcpInvoker} from '../src/harness-core/legacy-mcp-invoker.mjs';

function registryFixture(){
  const registry=new CapabilityRegistry();
  registry.registerProvider({
    id:'fixture-provider',
    capabilities:[{id:'fixture.reads',toolNames:['fixture_read']}],
    tools:[{name:'fixture_read',capabilityId:'fixture.reads',risk:'read',readOnly:true,inputSchema:{type:'object'}}]
  });
  return registry;
}

test('Tool Broker resolves discovery metadata then delegates to the registered provider invoker',async()=>{
  const registry=registryFixture();
  const broker=new ToolBroker({registry});
  const calls=[];
  broker.registerInvoker({
    providerId:'fixture-provider',
    invoke:async(name,args,options)=>{calls.push({name,args,options});return{result:{ok:true,name,args}};}
  });

  const outcome=await broker.call('fixture_read',{projectId:'p1'},{readOnlyOnly:true});
  assert.deepEqual(outcome,{result:{ok:true,name:'fixture_read',args:{projectId:'p1'}}});
  assert.deepEqual(calls,[{name:'fixture_read',args:{projectId:'p1'},options:{readOnlyOnly:true}}]);
});

test('Tool Broker fails closed when the capability provider is disabled or unknown',async()=>{
  const registry=registryFixture();
  const broker=new ToolBroker({registry});
  broker.registerInvoker({providerId:'fixture-provider',invoke:async()=>({result:'ok'})});

  registry.setProviderEnabled('fixture-provider',false);
  await assert.rejects(()=>broker.call('fixture_read',{}),error=>error?.code==='MCP_TOOL_NOT_FOUND');
  await assert.rejects(()=>broker.call('missing_tool',{}),error=>error?.code==='MCP_TOOL_NOT_FOUND');
});

test('Tool Broker refuses a discovered tool when no execution adapter is registered',async()=>{
  const broker=new ToolBroker({registry:registryFixture()});
  await assert.rejects(()=>broker.call('fixture_read',{}),error=>error?.code==='HARNESS_PROVIDER_UNAVAILABLE');
});

test('legacy MCP invoker preserves the existing MCP registry arguments, options and result contract',async()=>{
  const calls=[];
  const mcpRegistry={
    async call(name,args,options){calls.push({name,args,options});return{result:[{id:'p1'}],state:{ok:true}};}
  };
  const invoker=createLegacyMcpInvoker({mcpRegistry});
  assert.equal(invoker.providerId,'workbench-v3-mcp');
  const outcome=await invoker.invoke('project_list',{includeArchived:false},{readOnlyOnly:true,allowedNames:['project_list']});
  assert.deepEqual(outcome,{result:[{id:'p1'}],state:{ok:true}});
  assert.deepEqual(calls,[{name:'project_list',args:{includeArchived:false},options:{readOnlyOnly:true,allowedNames:['project_list']}}]);
});
