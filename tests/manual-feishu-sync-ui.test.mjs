import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('Feishu todo source sync requires an explicit user action without gating AI review of already-synced todos',async()=>{
  const [index,gate,v3]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3-manual-control.js','utf8'),
    fsp.readFile('public/workbench-v3.js','utf8')
  ]);
  assert.match(index,/workbench-v3-manual-control\.js/);
  assert.ok(index.indexOf('workbench-v3-manual-control.js')<index.indexOf('workbench-v3.js'));
  assert.match(gate,/let syncPermit=false/);
  assert.match(gate,/飞书待办同步只能由你点击“同步飞书待办”触发/);
  assert.match(gate,/path==='\/api\/inbox\/sync'/);
  assert.match(gate,/workbench:feishu-sync-complete/);
  assert.match(gate,/只读取飞书云文档中的明确待办/);
  assert.doesNotMatch(gate,/classificationRun|IDLE_SOURCE|INIT_ANALYZE_ONCE/);
  assert.doesNotMatch(gate,/path==='\/api\/ai\/plan'/);
  assert.match(v3,/json\('\/api\/inbox\/sync'/);
  assert.match(v3,/同步飞书待办/);
});

test('historical inbox records expose a local-only delete action',async()=>{
  const gate=await fsp.readFile('public/workbench-v3-manual-control.js','utf8');
  assert.match(gate,/button\.textContent='删除本地'/);
  assert.match(gate,/飞书原文不会删除/);
  assert.match(gate,/nativeFetch\('\/api\/inbox\/command'/);
  assert.match(gate,/command:'删除'/);
  assert.doesNotMatch(gate,/docs|lark-cli|block_delete|documentUrl/);
});
