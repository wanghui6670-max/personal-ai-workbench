import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry, createLegacyMcpProvider } from '../src/harness-core/index.mjs';

function fakeRegistry(tools){
  return {
    list(){return tools.map(({execute,...meta})=>meta);},
    async call(name,args={},options={}){
      const tool=tools.find(item=>item.name===name);
      if(!tool)throw Object.assign(new Error(`未知 MCP 工具：${name}`),{code:'MCP_TOOL_NOT_FOUND',statusCode:404});
      return {result:{ok:true,name,args,options},tool:{name}};
    },
    tools
  };
}

test('registry lists capabilities and tools from a registered provider',()=>{
  const mcp=fakeRegistry([
    {name:'project_list',readOnly:true},
    {name:'todo_create',readOnly:false},
    {name:'secret_tool',readOnly:true}
  ]);
  const provider=createLegacyMcpProvider({
    id:'legacy-mcp',
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.read',toolNames:['project_list']}]
  });
  const registry=createCapabilityRegistry();
  registry.registerProvider(provider);

  const caps=registry.listCapabilities();
  assert.deepEqual(caps,[{
    id:'workbench.read',
    providerId:'legacy-mcp',
    toolNames:['project_list'],
    status:'enabled'
  }]);
  assert.deepEqual(registry.listTools().map(tool=>tool.name),['project_list']);
  assert.equal(registry.listTools().some(tool=>tool.name==='secret_tool'),false);
  assert.equal(registry.listTools().some(tool=>tool.name==='todo_create'),false);
});

test('unregistered tool cannot be discovered and cannot be called',async()=>{
  const mcp=fakeRegistry([{name:'project_list',readOnly:true}]);
  const provider=createLegacyMcpProvider({
    id:'legacy-mcp',
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.read',toolNames:['project_list']}]
  });
  const registry=createCapabilityRegistry();
  registry.registerProvider(provider);
  await assert.rejects(
    ()=>provider.call('secret_tool',{}),
    error=>error.code==='MCP_TOOL_NOT_FOUND'
  );
});

test('disabled provider capabilities are unavailable',()=>{
  const mcp=fakeRegistry([{name:'project_list',readOnly:true}]);
  const provider=createLegacyMcpProvider({
    id:'legacy-mcp',
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.read',toolNames:['project_list']}]
  });
  const registry=createCapabilityRegistry();
  registry.registerProvider(provider);
  registry.setProviderEnabled('legacy-mcp',false);
  assert.deepEqual(registry.listCapabilities(),[]);
  assert.deepEqual(registry.listTools(),[]);
  assert.equal(registry.listCapabilities({includeDisabled:true})[0].status,'disabled');
});

test('legacy provider does not rename mcpRegistry tools',()=>{
  const mcp=fakeRegistry([{name:'joycrew_run_prepare',readOnly:true}]);
  const provider=createLegacyMcpProvider({
    mcpRegistry:mcp,
    capabilities:[{id:'joycrew.preview',toolNames:['joycrew_run_prepare']}]
  });
  assert.equal(provider.listTools()[0].name,'joycrew_run_prepare');
});
