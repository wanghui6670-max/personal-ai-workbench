import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry} from '../src/harness-core/capability-registry.mjs';
import {createLegacyMcpProvider} from '../src/harness-core/legacy-mcp-provider.mjs';

function legacyRegistry(){
  return {
    tools:[
      {name:'project_list',readOnly:true,requiresConfirmation:false,inputSchema:{}},
      {name:'panel_navigate',readOnly:true,requiresConfirmation:false,inputSchema:{}},
      {name:'joycrew_workspace_open',readOnly:true,requiresConfirmation:false,inputSchema:{}},
      {name:'joycrew_run_prepare',readOnly:true,requiresConfirmation:false,inputSchema:{}},
      {name:'todo_today',readOnly:false,requiresConfirmation:true,inputSchema:{}},
      {name:'explicit_external_write',readOnly:false,requiresConfirmation:true,effect:'external_write',inputSchema:{}}
    ]
  };
}

test('legacy readOnly is compatibility metadata, not the authoritative Harness effect',()=>{
  const registry=new CapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({mcpRegistry:legacyRegistry()}));

  assert.equal(registry.getTool('project_list').readOnly,true);
  assert.equal(registry.getTool('project_list').effect,'read');

  assert.equal(registry.getTool('panel_navigate').readOnly,true);
  assert.equal(registry.getTool('panel_navigate').effect,'local_ephemeral');
  assert.equal(registry.getTool('joycrew_workspace_open').readOnly,true);
  assert.equal(registry.getTool('joycrew_workspace_open').effect,'local_ephemeral');

  assert.equal(registry.getTool('joycrew_run_prepare').readOnly,true);
  assert.equal(registry.getTool('joycrew_run_prepare').effect,'local_ephemeral');

  assert.equal(registry.getTool('todo_today').readOnly,false);
  assert.equal(registry.getTool('todo_today').effect,'write_unknown');

  assert.equal(registry.getTool('explicit_external_write').effect,'external_write');
});

test('Capability Registry preserves explicit effect metadata independently from legacy risk labels',()=>{
  const registry=new CapabilityRegistry();
  registry.registerProvider({
    id:'native-provider',
    capabilities:[{id:'native.capability',toolNames:['native_write']}],
    tools:[{
      name:'native_write',
      capabilityId:'native.capability',
      effect:'local_write',
      risk:'read',
      readOnly:true,
      inputSchema:{}
    }]
  });
  const tool=registry.getTool('native_write');
  assert.equal(tool.effect,'local_write');
  assert.equal(tool.readOnly,true);
});

test('Capability Registry fails closed on unsupported Tool effects',()=>{
  const registry=new CapabilityRegistry();
  assert.throws(()=>registry.registerProvider({
    id:'bad-provider',
    capabilities:[{id:'bad.capability',toolNames:['bad_tool']}],
    tools:[{name:'bad_tool',capabilityId:'bad.capability',effect:'magic_side_effect'}]
  }),/unsupported tool effect: magic_side_effect/);
});
