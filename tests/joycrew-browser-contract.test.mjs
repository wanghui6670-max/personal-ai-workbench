import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const read=file=>fsp.readFile(new URL(`../${file}`,import.meta.url),'utf8');

test('unified business execution assets are mounted without browser-side Joycrew credentials',async()=>{
  const [index,script,server]=await Promise.all([read('public/index.html'),read('public/joycrew-integration.js'),read('src/server.mjs')]);
  assert.match(index,/joycrew-integration\.css/);
  assert.match(index,/joycrew-integration\.js/);
  assert.match(script,/#operations/);
  assert.match(script,/\/api\/joycrew\/overview/);
  assert.match(script,/\/api\/joycrew\/actions\/prepare/);
  assert.match(script,/confirmed:true/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|x-joycrew-proxy-token|authorization\s*:/i);
  assert.match(server,/pathname==='\/api\/joycrew\/actions\/prepare'/);
  assert.match(server,/joycrewActions\.execute/);
});

test('unified Copilot exposes fixed reads and preview-only Joycrew actions',async()=>{
  const [policy,tools,prompt]=await Promise.all([
    read('src/harness-policy.mjs'),read('src/mcp/joycrew-tools.mjs'),read('harness/navigator.cordis.yml')
  ]);
  assert.match(policy,/joycrew_run_prepare/);
  assert.match(policy,/joycrew_deliverable_prepare/);
  assert.match(policy,/joycrew_approval_prepare/);
  assert.doesNotMatch(policy,/joycrew_run_execute|joycrew_approval_execute/);
  assert.match(tools,/未确认前 Joycrew 不会改变/);
  assert.match(prompt,/\*_prepare 工具只生成短时操作预览/);
});
