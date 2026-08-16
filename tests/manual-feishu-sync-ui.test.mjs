import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('Feishu sync and classification require an explicit user click',async()=>{
  const [index,gate,v3]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3-manual-control.js','utf8'),
    fsp.readFile('public/workbench-v3.js','utf8')
  ]);
  assert.match(index,/workbench-v3-manual-control\.js/);
  assert.ok(index.indexOf('workbench-v3-manual-control.js')<index.indexOf('workbench-v3.js'));
  assert.match(gate,/let syncPermit=false/);
  assert.match(gate,/飞书同步只能由你点击“同步飞书”触发/);
  assert.match(gate,/source:IDLE_SOURCE/);
  assert.match(gate,/calledFromWorkbenchV3/);
  assert.match(gate,/window\.__WORKBENCH_FEISHU_CLASSIFY_RUN__=false/);
  assert.match(gate,/workbench:feishu-sync-complete/);
  assert.match(v3,/json\('\/api\/inbox\/sync'/);
});

test('historical inbox records expose a local-only delete action',async()=>{
  const gate=await fsp.readFile('public/workbench-v3-manual-control.js','utf8');
  assert.match(gate,/button\.textContent='删除本地'/);
  assert.match(gate,/飞书原文不会删除/);
  assert.match(gate,/nativeFetch\('\/api\/inbox\/command'/);
  assert.match(gate,/command:'删除'/);
  assert.doesNotMatch(gate,/docs|lark-cli|block_delete|documentUrl/);
});
