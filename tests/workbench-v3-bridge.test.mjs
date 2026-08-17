import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkbenchTools } from '../src/mcp/tools.mjs';
import { createWorkbenchV3BridgePlugin } from '../plugins/workbench-v3-bridge/index.mjs';

const noopContext=()=>({appRoot:'/tmp/workbench',store:{},state:{inbox:[],projects:[],todos:[],activities:[],confirmations:[]},config:{businesses:[]},aiEnabled:false});

test('V3 bridge reuses the existing allow-listed tools instead of reimplementing business rules', () => {
  const existing=createWorkbenchTools();
  const plugin=createWorkbenchV3BridgePlugin({contextProvider:noopContext});
  const bridged=plugin.capabilities.flatMap(capability=>capability.tools);
  const byName=new Map(bridged.map(tool=>[tool.name,tool]));
  for(const legacy of existing){
    const tool=byName.get(legacy.name);
    assert.ok(tool,`missing bridged tool ${legacy.name}`);
    assert.equal(tool.risk,legacy.readOnly===true?'read':legacy.requiresConfirmation===true?'local-write':'read');
  }
});

test('V3 bridge splits workbench semantics into installable capabilities', () => {
  const plugin=createWorkbenchV3BridgePlugin({contextProvider:noopContext});
  const ids=plugin.capabilities.map(item=>item.id).sort();
  assert.ok(ids.includes('project'));
  assert.ok(ids.includes('inbox'));
  assert.ok(ids.includes('todo'));
  assert.ok(ids.includes('workbench-navigation'));
});

test('bridged tool execution resolves fresh context at call time', async () => {
  let generation=0;
  const plugin=createWorkbenchV3BridgePlugin({contextProvider:async()=>({
    appRoot:'/tmp/workbench',
    store:{},
    state:{inbox:[{id:'in-1',text:`generation-${++generation}`}],projects:[],todos:[],activities:[],confirmations:[]},
    config:{businesses:[]},
    aiEnabled:false
  })});
  const inbox=plugin.capabilities.find(item=>item.id==='inbox');
  const search=inbox.tools.find(tool=>tool.name==='inbox_search');
  const first=await search.execute({query:'generation'});
  const second=await search.execute({query:'generation'});
  assert.equal(first[0].text,'generation-1');
  assert.equal(second[0].text,'generation-2');
});
