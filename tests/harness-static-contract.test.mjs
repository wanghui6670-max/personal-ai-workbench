import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { normalizeInputSchema } from '../harness/joycrew-tool-bridge.mjs';

const BANNED_PLUGINS=[
  '@deepseek-ai/dsh-tool-bash','@deepseek-ai/dsh-tool-fs','@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-jobs','@deepseek-ai/dsh-subagent','@deepseek-ai/dsh-workflow',
  '@deepseek-ai/dsh-mcp-client','@deepseek-ai/dsh-session-persistence'
];

test('P0 Cordis composition contains no execution or persistence plugin',async()=>{
  const config=await fsp.readFile('harness/navigator.cordis.yml','utf8');
  const pluginNames=[...config.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(match=>match[1]);
  for(const banned of BANNED_PLUGINS){
    assert.equal(pluginNames.some(name=>name.startsWith(banned)),false,banned);
  }
  assert.equal(pluginNames.includes('./joycrew-tool-bridge.mjs'),true);
  assert.equal(pluginNames.includes('@deepseek-ai/dsh-sdk-jsonrpc-server'),true);
});

test('browser Navigator keeps conversation state in module memory only',async()=>{
  const source=await fsp.readFile('public/harness-navigator.js','utf8');
  for(const forbidden of ['localStorage','sessionStorage','indexedDB','IndexedDB']){
    assert.equal(source.includes(forbidden),false,forbidden);
  }
  assert.equal(source.includes('/api/harness/navigator'),true);
});

test('bridge normalizes Workbench nullable anyOf schemas to the Harness subset',()=>{
  const normalized=normalizeInputSchema({
    type:'object',properties:{id:{anyOf:[{type:'string'},{type:'null'}]}}
  });
  assert.equal('anyOf' in normalized.properties.id,false);
  assert.deepEqual(normalized.properties.id.oneOf,[{type:'string'},{type:'null'}]);
});

test('child bridge repeats the exact P0 allow-list instead of trusting discovery labels',async()=>{
  const source=await fsp.readFile('harness/joycrew-tool-bridge.mjs','utf8');
  for(const name of ['panel_navigate','inbox_search','project_list','todo_list','journal_read','confirmation_list','business_list','project_records_read']){
    assert.match(source,new RegExp(`['"]${name}['"]`),name);
  }
  assert.match(source,/ALLOWED_RAW_NAMES\.has\(rawName\)/);
});

test('Harness dependencies are pinned to one reviewed developer-preview release',async()=>{
  const packageJson=JSON.parse(await fsp.readFile('harness/package.json','utf8'));
  for(const [name,version] of Object.entries(packageJson.dependencies)){
    if(name==='@deepseek-ai/cordis')assert.equal(version,'4.0.1');
    else assert.equal(version,'0.1.0-rc.6',name);
  }
});
