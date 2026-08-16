import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('Workbench pending queue exposes multi-select batch controls',async()=>{
  const [index,script,css]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3-batch.js','utf8'),
    fsp.readFile('public/workbench-v3-batch.css','utf8')
  ]);
  assert.match(index,/workbench-v3-batch\.css/);
  assert.match(index,/workbench-v3-batch\.js/);
  assert.ok(index.indexOf('workbench-v3-auto-classify.js')<index.indexOf('workbench-v3-batch.js'));
  assert.match(script,/const selectedIds=new Set\(\)/);
  assert.match(script,/data-batch-select/);
  assert.match(script,/data-batch-all/);
  assert.match(script,/批量重新分析/);
  assert.match(script,/批量确认可执行/);
  assert.match(script,/批量删除本地/);
  assert.match(css,/\.v3-batch-bar/);
  assert.match(css,/\.v3-batch-check/);
});

test('batch confirmation skips anything without an existing executable preview',async()=>{
  const script=await fsp.readFile('public/workbench-v3-batch.js','utf8');
  assert.match(script,/querySelector\('\[data-v3-action="confirm-plan"\]'\)/);
  assert.match(script,/缺信息\/未分析，会跳过/);
  assert.match(script,/仍缺信息的会继续保留/);
});

test('batch reanalysis stays bounded and batch deletion is local-only',async()=>{
  const script=await fsp.readFile('public/workbench-v3-batch.js','utf8');
  assert.match(script,/Math\.min\(2,queue\.length\)/);
  assert.match(script,/fetch\('\/api\/inbox\/command'/);
  assert.match(script,/command:'删除'/);
  assert.match(script,/飞书原文不会删除/);
  assert.doesNotMatch(script,/\/api\/inbox\/sync/);
  assert.doesNotMatch(script,/lark-cli|block_delete|documentUrl/);
});
