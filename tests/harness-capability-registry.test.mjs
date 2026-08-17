import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry} from '../src/harness-core/capability-registry.mjs';
import {createLegacyMcpProvider} from '../src/harness-core/legacy-mcp-provider.mjs';

function legacyRegistry(){
  return {
    tools:[
      {name:'legacy.read',description:'read current state',readOnly:true,requiresConfirmation:false,inputSchema:{}},
      {name:'legacy.write',description:'change current state',readOnly:false,requiresConfirmation:true,inputSchema:{type:'object'}}
    ],
    async call(name,args,options){return {result:{name,args,confirmed:options.confirmed===true}};}
  };
}

test('Workbench v3 MCP surface can register as one compatibility capability without renaming tools',()=>{
  const registry=new CapabilityRegistry();
  const provider=createLegacyMcpProvider({mcpRegistry:legacyRegistry()});
  registry.registerProvider(provider);

  assert.deepEqual(registry.listCapabilities().map(item=>item.id),['workbench.v3.mcp']);
  assert.deepEqual(registry.listTools().map(item=>item.name),['legacy.read','legacy.write']);
  assert.equal(registry.getTool('legacy.read').capabilityId,'workbench.v3.mcp');
  assert.equal(registry.getTool('legacy.read').providerId,'workbench-v3-mcp');
  assert.equal(registry.getTool('legacy.write').risk,'external_write');
  assert.equal(registry.getTool('legacy.write').requiresConfirmation,true);
});

test('legacy Workbench MCP tool names with underscores remain valid without renaming',()=>{
  const registry=new CapabilityRegistry();
  const legacy={tools:[
    {name:'feishu_inbox_sync',readOnly:false,requiresConfirmation:true,inputSchema:{}},
    {name:'project_records_read',readOnly:true,requiresConfirmation:false,inputSchema:{}}
  ]};
  registry.registerProvider(createLegacyMcpProvider({mcpRegistry:legacy}));
  assert.deepEqual(registry.listTools().map(item=>item.name),['feishu_inbox_sync','project_records_read']);
});

test('Capability Registry is discovery-only and exposes no provider execution entrypoint',()=>{
  const registry=new CapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({mcpRegistry:legacyRegistry()}));
  assert.equal(Object.hasOwn(registry.getProvider('workbench-v3-mcp'),'call'),false);
  assert.equal(Object.hasOwn(registry.getTool('legacy.read'),'execute'),false);
});

test('Capability Registry fails closed when two providers claim the same tool',()=>{
  const registry=new CapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({mcpRegistry:legacyRegistry()}));
  assert.throws(()=>registry.registerProvider({
    id:'duplicate-provider',
    capabilities:[{id:'duplicate.capability',toolNames:['legacy.read']}],
    tools:[{name:'legacy.read',capabilityId:'duplicate.capability',risk:'read'}]
  }),/tool already registered: legacy\.read/);
});

test('disabled providers disappear from discovery without mutating the legacy registry',()=>{
  const legacy=legacyRegistry();
  const registry=new CapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({mcpRegistry:legacy}));
  registry.setProviderEnabled('workbench-v3-mcp',false);

  assert.deepEqual(registry.listCapabilities(),[]);
  assert.deepEqual(registry.listTools(),[]);
  assert.equal(legacy.tools.length,2);

  registry.setProviderEnabled('workbench-v3-mcp',true);
  assert.deepEqual(registry.listTools().map(item=>item.name),['legacy.read','legacy.write']);
});
