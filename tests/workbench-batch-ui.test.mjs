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

test('batch confirmation accepts either an existing safe plan or an extracted candidate with explicit due date',async()=>{
  const script=await fsp.readFile('public/workbench-v3-batch.js','utf8');
  assert.match(script,/function confirmButton/);
  assert.match(script,/confirm-plan/);
  assert.match(script,/confirm-extracted-todo/);
  assert.match(script,/缺截止日期\/仍在解析，会跳过/);
  assert.match(script,/已经具备安全执行条件的待办/);
});

test('batch reanalysis stays bounded and batch deletion is one confirmed local-only transaction',async()=>{
  const [script,registry,tool]=await Promise.all([
    fsp.readFile('public/workbench-v3-batch.js','utf8'),
    fsp.readFile('src/mcp/registry.mjs','utf8'),
    fsp.readFile('src/mcp/inbox-batch-tools.mjs','utf8')
  ]);
  assert.match(script,/Math\.min\(2,queue\.length\)/);
  assert.match(script,/fetch\('\/api\/mcp'/);
  assert.match(script,/name:'inbox_batch_delete'/);
  assert.match(script,/itemIds:ids/);
  assert.match(script,/confirmed:true/);
  assert.doesNotMatch(script,/for\(const id of ids\)\{[\s\S]*?fetch\('\/api\/inbox\/command'/);
  assert.match(script,/飞书原文不会删除/);
  assert.doesNotMatch(script,/\/api\/inbox\/sync/);
  assert.doesNotMatch(script,/lark-cli|block_delete|documentUrl/);
  assert.match(registry,/createInboxBatchTools/);
  assert.match(tool,/requiresConfirmation:true/);
  assert.match(tool,/maxItems:500/);
});
