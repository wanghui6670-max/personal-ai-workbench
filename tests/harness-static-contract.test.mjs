import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { normalizeInputSchema } from '../harness/joycrew-schema.mjs';
import {
  HARNESS_NAVIGATOR_TOOL_ALLOWLIST,
  HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256
} from '../src/harness-policy.mjs';

const BANNED_PLUGINS=['@deepseek-ai/dsh-tool-bash','@deepseek-ai/dsh-tool-fs','@deepseek-ai/dsh-terminal','@deepseek-ai/dsh-jobs','@deepseek-ai/dsh-subagent','@deepseek-ai/dsh-workflow','@deepseek-ai/dsh-session-persistence'];

test('Navigator composition contains no execution or persistence plugin',async()=>{
  const config=await fsp.readFile('harness/navigator.cordis.yml','utf8');
  const pluginNames=[...config.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(match=>match[1]);
  for(const banned of BANNED_PLUGINS)assert.equal(pluginNames.some(name=>name.startsWith(banned)),false,banned);
  assert.equal(pluginNames.includes('./joycrew-sdk-server.mjs'),true);
  const gate=await fsp.readFile('harness/joycrew-sdk-server.mjs','utf8');
  assert.match(gate,/await McpClient\.apply/);
  assert.match(gate,/SdkServer\.apply\(ctx,config\)/);
  assert.ok(gate.indexOf('await McpClient.apply')<gate.indexOf('SdkServer.apply(ctx,config)'));
  assert.match(gate,/failOnStartupError:true/);
});

test('browser Navigator keeps conversation state in module memory only',async()=>{
  const source=await fsp.readFile('public/harness-navigator.js','utf8');
  for(const forbidden of ['localStorage','sessionStorage','indexedDB','IndexedDB'])assert.equal(source.includes(forbidden),false,forbidden);
  assert.equal(source.includes('/api/harness/navigator'),true);
});

test('proxy normalizes Workbench nullable anyOf schemas to the Harness subset',()=>{
  const normalized=normalizeInputSchema({type:'object',properties:{id:{anyOf:[{type:'string'},{type:'null'}]}}});
  assert.equal('anyOf' in normalized.properties.id,false);
  assert.deepEqual(normalized.properties.id.oneOf,[{type:'string'},{type:'null'}]);
});

test('proxy removes unsupported presentation constraints and preserves structural validation',()=>{
  const normalized=normalizeInputSchema({type:'object',additionalProperties:false,properties:{query:{type:'string',minLength:1,maxLength:100,pattern:'^[a-z]+$'},limit:{type:'integer',minimum:1,maximum:50},nested:{type:'array',minItems:1,items:{type:'string',minLength:2}}},required:['query'],description:'search input',default:{query:'keep arbitrary annotation keys',limit:10}});
  assert.deepEqual(normalized,{type:'object',additionalProperties:false,properties:{query:{type:'string'},limit:{type:'integer'},nested:{type:'array',items:{type:'string'}}},required:['query'],description:'search input',default:{query:'keep arbitrary annotation keys',limit:10}});
});

test('stdio proxy imports the exact reviewed allow-list and blocks unknown calls',async()=>{
  const source=await fsp.readFile('harness/joycrew-mcp-server.mjs','utf8');
  assert.match(source,/import \{ HARNESS_NAVIGATOR_TOOL_ALLOWLIST \} from '\.\.\/src\/harness-policy\.mjs'/);
  assert.match(source,/new Set\(HARNESS_NAVIGATOR_TOOL_ALLOWLIST\)/);
  assert.match(source,/ALLOWED_RAW_NAMES\.has\(String\(message\.params\?\.name/);
  assert.equal(HARNESS_NAVIGATOR_TOOL_ALLOWLIST.length,27);
  assert.match(HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256,/^[a-f0-9]{64}$/);
});

test('Harness dependencies are pinned to one reviewed developer-preview release',async()=>{
  const packageJson=JSON.parse(await fsp.readFile('harness/package.json','utf8'));
  for(const [name,version] of Object.entries({...packageJson.dependencies,...packageJson.devDependencies}))assert.equal(version,'0.1.0-rc.6',name);
});
