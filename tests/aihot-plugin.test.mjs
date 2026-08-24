import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarnessPlatform } from '../platform/runtime/platform.mjs';
import { createPluginLoader } from '../platform/runtime/plugin-loader.mjs';
import { createAIHotPlugin } from '../plugins/aihot/index.mjs';

test('AIHot installs without modifying harness core and exposes read-only tools', async () => {
  const calls=[];
  const fetchImpl=async (url,options={})=>{
    calls.push({url:String(url),options});
    return {
      ok:true,
      status:200,
      headers:new Map(),
      async json(){return {items:[{title:'Harness-first architecture'}]};}
    };
  };
  const platform=createHarnessPlatform();
  const loader=createPluginLoader({platform});
  await loader.install(createAIHotPlugin({fetchImpl}));
  assert.equal(platform.plugins.has('aihot'),true);
  assert.equal(platform.capabilities.has('aihot'),true);
  const tools=platform.capabilities.get('aihot').tools;
  assert.deepEqual(tools.map(tool=>tool.name).sort(),['aihot.daily','aihot.latest']);
  assert.ok(tools.every(tool=>tool.risk==='read'));
  const result=await platform.tools.call('aihot.latest',{limit:10});
  assert.deepEqual(result,{items:[{title:'Harness-first architecture'}]});
  assert.match(calls[0].url,/^https:\/\/aihot\.virxact\.com\/api\/public\/items\?/);
});

test('AIHot never accepts arbitrary URLs from agent arguments', async () => {
  const calls=[];
  const fetchImpl=async url=>{
    calls.push(String(url));
    return {ok:true,status:200,headers:new Map(),async json(){return {items:[]};}};
  };
  const platform=createHarnessPlatform();
  const loader=createPluginLoader({platform});
  await loader.install(createAIHotPlugin({fetchImpl}));
  await platform.tools.call('aihot.latest',{url:'https://evil.example/',limit:1});
  assert.equal(calls.length,1);
  assert.match(calls[0],/^https:\/\/aihot\.virxact\.com\//);
  assert.equal(calls[0].includes('evil.example'),false);
});

test('AIHot fails closed on non-success or oversized responses', async () => {
  const platform=createHarnessPlatform();
  const loader=createPluginLoader({platform});
  await loader.install(createAIHotPlugin({fetchImpl:async()=>({ok:false,status:429,headers:new Map(),async json(){return {};}})}));
  await assert.rejects(()=>platform.tools.call('aihot.latest',{}),/AIHot request failed: 429/);
});
