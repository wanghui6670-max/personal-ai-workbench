import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbenchRegistry} from '../src/mcp/registry.mjs';
import {HARNESS_NAVIGATOR_TOOL_ALLOWLIST} from '../src/harness-policy.mjs';
import {CapabilityRegistry} from '../src/harness-core/capability-registry.mjs';
import {createLegacyMcpProvider} from '../src/harness-core/legacy-mcp-provider.mjs';
import {ToolPolicy} from '../src/harness-core/tool-policy.mjs';

function realCatalog(){
  const mcpRegistry=createWorkbenchRegistry({
    appRoot:'/tmp/harness-policy-parity',
    store:{},
    joycrewClient:{},
    joycrewActions:{}
  });
  const registry=new CapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({mcpRegistry}));
  return{mcpRegistry,registry};
}

test('shadow Policy ALLOW set exactly matches the current legacy DSH bridge exposure',()=>{
  const {mcpRegistry,registry}=realCatalog();
  const policy=new ToolPolicy({mode:'shadow'});
  const options={readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST};
  const legacyExposed=new Set(mcpRegistry.list(options).map(tool=>tool.name));

  assert.deepEqual(
    [...legacyExposed].sort(),
    [...HARNESS_NAVIGATOR_TOOL_ALLOWLIST].sort(),
    'the fixed Harness allowlist must still resolve to the complete current legacy MCP surface'
  );

  const shadowAllowed=new Set();
  for(const tool of registry.listTools()){
    const verdict=policy.evaluate({tool,options});
    if(verdict.decision==='ALLOW')shadowAllowed.add(tool.name);
    assert.equal(
      verdict.decision==='ALLOW',
      legacyExposed.has(tool.name),
      `${tool.name}: shadow=${verdict.decision}/${verdict.reason}, legacyExposed=${legacyExposed.has(tool.name)}`
    );
  }

  assert.deepEqual([...shadowAllowed].sort(),[...legacyExposed].sort());
});

test('every Tool currently exposed to DSH has a known safe effect and never needs shadow approval',()=>{
  const {mcpRegistry,registry}=realCatalog();
  const policy=new ToolPolicy({mode:'shadow'});
  const options={readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST};
  const exposed=mcpRegistry.list(options).map(tool=>tool.name);

  for(const name of exposed){
    const tool=registry.getTool(name);
    assert.ok(tool,`${name} must exist in Capability Registry`);
    assert.ok(['read','local_ephemeral'].includes(tool.effect),`${name} has unsafe/unknown effect ${tool.effect}`);
    assert.equal(tool.requiresConfirmation,false,`${name} unexpectedly requires legacy confirmation on the read/preview DSH surface`);
    assert.deepEqual(policy.evaluate({tool,options}),{
      decision:'ALLOW',reason:'effect_safe',effect:tool.effect,mode:'shadow'
    });
  }
});

test('representative Workbench write Tools remain outside the DSH surface and shadow Policy denies them',()=>{
  const {registry}=realCatalog();
  const policy=new ToolPolicy({mode:'shadow'});
  const options={readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST};

  for(const name of ['todo_today','inbox_process']){
    const tool=registry.getTool(name);
    assert.ok(tool,`${name} must exist in the real Workbench MCP catalog`);
    const verdict=policy.evaluate({tool,options});
    assert.equal(verdict.decision,'DENY');
    assert.ok(['tool_not_allowlisted','read_only_surface'].includes(verdict.reason));
  }
});
