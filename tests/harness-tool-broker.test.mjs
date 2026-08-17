import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry, createLegacyMcpProvider, createToolBroker } from '../src/harness-core/index.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from '../src/harness-policy.mjs';

function fakeRegistry(tools){
  const calls=[];
  return {
    calls,
    list(options={}){
      calls.push({kind:'list',options});
      return tools.filter(tool=>{
        if(options.readOnlyOnly&&tool.readOnly!==true)return false;
        if(options.allowedNames&&!options.allowedNames.includes(tool.name)&&!(options.allowedNames.has?.(tool.name)))return false;
        return true;
      }).map(({execute,...meta})=>meta);
    },
    async call(name,args={},options={}){
      calls.push({kind:'call',name,args,options});
      const tool=tools.find(item=>item.name===name);
      if(!tool)throw Object.assign(new Error(`未知 MCP 工具：${name}`),{code:'MCP_TOOL_NOT_FOUND'});
      if(options.readOnlyOnly&&tool.readOnly!==true){
        throw Object.assign(new Error(`工具 ${name} 不在本次调用的能力白名单中。`),{code:'MCP_TOOL_NOT_ALLOWED'});
      }
      if(tool.requiresConfirmation&&!options.confirmed){
        throw Object.assign(new Error(`工具 ${name} 会改变工作台状态，必须先展示影响范围并获得确认。`),{code:'MCP_CONFIRMATION_REQUIRED',statusCode:409});
      }
      return {result:{ok:true,name},tool:{name}};
    }
  };
}

test('broker resolves a registered tool and forwards to mcpRegistry.call',async()=>{
  const mcp=fakeRegistry([{name:'project_list',readOnly:true}]);
  const registry=createCapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.read',toolNames:['project_list']}]
  }));
  const broker=createToolBroker({registry});
  const outcome=await broker.call({
    name:'project_list',
    arguments:{includeArchived:false},
    options:{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST},
    trigger:'harness-http'
  });
  assert.equal(outcome.result.ok,true);
  assert.equal(mcp.calls.at(-1).kind,'call');
  assert.equal(mcp.calls.at(-1).name,'project_list');
  assert.deepEqual(mcp.calls.at(-1).options,{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST});
});

test('broker preserves MCP_CONFIRMATION_REQUIRED',async()=>{
  const mcp=fakeRegistry([{name:'todo_create',readOnly:false,requiresConfirmation:true}]);
  const registry=createCapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.write',toolNames:['todo_create']}]
  }));
  const broker=createToolBroker({registry});
  await assert.rejects(
    ()=>broker.call({name:'todo_create',arguments:{title:'x'},options:{}}),
    error=>error.code==='MCP_CONFIRMATION_REQUIRED'
  );
});

test('unknown tool stays MCP_TOOL_NOT_FOUND',async()=>{
  const mcp=fakeRegistry([]);
  const registry=createCapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.read',toolNames:['project_list']}]
  }));
  const broker=createToolBroker({registry});
  await assert.rejects(
    ()=>broker.call({name:'nope',arguments:{}}),
    error=>error.code==='MCP_TOOL_NOT_FOUND'
  );
});
