import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarnessPlatform } from '../platform/runtime/platform.mjs';
import { createPluginLoader } from '../platform/runtime/plugin-loader.mjs';

function aihotPlugin(){
  return {
    manifest:{id:'aihot',version:'1.0.0',adapter:'./adapter.mjs'},
    capabilities:[{
      id:'aihot',
      version:'1.0.0',
      kind:'information-source',
      tools:[{
        name:'aihot.latest',
        risk:'read',
        execute:async()=>({items:[{title:'Harness-first'}]})
      }]
    }]
  };
}

test('plugin loader installs a capability without editing harness core', async () => {
  const platform=createHarnessPlatform();
  const loader=createPluginLoader({platform});
  await loader.install(aihotPlugin());
  assert.equal(platform.capabilities.has('aihot'),true);
  assert.ok(platform.tools.get('aihot.latest'));
  assert.deepEqual(await platform.tools.call('aihot.latest',{}),{items:[{title:'Harness-first'}]});
});

test('agent execution is capability-scoped', async () => {
  const platform=createHarnessPlatform();
  const loader=createPluginLoader({platform});
  await loader.install(aihotPlugin());
  platform.agents.register({id:'research-agent',instructions:'research',capabilities:['aihot']});
  const runtime=platform.runtimeForAgent('research-agent');
  assert.deepEqual(runtime.tools.map(tool=>tool.name),['aihot.latest']);
  assert.deepEqual(await runtime.call('aihot.latest',{}),{items:[{title:'Harness-first'}]});
  await assert.rejects(()=>runtime.call('unknown.tool',{}),/not available to agent/i);
});

test('plugin install fails atomically when a tool name collides', async () => {
  const platform=createHarnessPlatform();
  platform.tools.register({name:'aihot.latest',risk:'read',execute:async()=>({})});
  const loader=createPluginLoader({platform});
  await assert.rejects(()=>loader.install(aihotPlugin()),/tool already registered/i);
  assert.equal(platform.capabilities.has('aihot'),false);
});

test('an app can be mounted only when required capabilities and plugins exist', async () => {
  const platform=createHarnessPlatform();
  const loader=createPluginLoader({platform});
  await loader.install(aihotPlugin());
  const app={id:'intel',version:'1.0.0',capabilities:['aihot'],plugins:['aihot'],agents:[],views:['feed']};
  const mounted=platform.mountApp(app);
  assert.equal(mounted.id,'intel');
  assert.equal(platform.apps.get('intel').views[0],'feed');
  assert.throws(()=>platform.mountApp({id:'broken',version:'1.0.0',capabilities:['missing'],plugins:[],agents:[],views:[]}),/missing capability/i);
});
