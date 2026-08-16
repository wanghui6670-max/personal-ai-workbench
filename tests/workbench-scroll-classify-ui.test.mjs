import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('desktop center work surface is independently scrollable',async()=>{
  const css=await fsp.readFile('public/workbench-v3-focus.css','utf8');
  assert.match(css,/html,body,#app\{height:100%;overflow:hidden\}/);
  assert.match(css,/\.layout\{height:100vh;min-height:0;overflow:hidden\}/);
  assert.match(css,/\.human-side\{height:100vh;min-height:0;overflow:hidden\}/);
  assert.match(css,/\.content\{height:100vh;min-height:0;overflow-y:auto;/);
  assert.match(css,/\.sidebar\{height:100vh;min-height:0;overflow-y:auto;/);
});

test('Feishu todo pool is presentation-only and exposes legacy cleanup separately',async()=>{
  const [index,script,css,migration]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3-auto-classify.js','utf8'),
    fsp.readFile('public/workbench-v3-focus.css','utf8'),
    fsp.readFile('public/workbench-v3-review-migration.js','utf8')
  ]);
  assert.match(index,/workbench-v3-auto-classify\.js/);
  assert.ok(index.indexOf('workbench-v3-review-migration.js')<index.indexOf('workbench-v3.js'));
  for(const label of ['飞书待办','需要决定','旧版日记项','旧版待清理'])assert.match(script,new RegExp(label));
  for(const removed of ['项目进展','分析思考','日常记录','提取中','待办候选','已过滤非待办'])assert.doesNotMatch(script,new RegExp(removed));
  assert.match(script,/v3AutoFilter='active'/);
  assert.match(script,/category==='todo'\|\|category==='decision'/);
  assert.match(script,/source==='feishu_todo'/);
  assert.match(script,/source==='feishu_todo_candidate'/);
  assert.doesNotMatch(script,/fetch\('/,'pool layer must not mutate backend state');
  assert.doesNotMatch(script,/不进入待办/);
  assert.match(script,/observe\(main,\{childList:true\}\)/);
  assert.doesNotMatch(script,/observe\(main,\{childList:true,subtree:true\}\)/);
  assert.match(css,/\.v3-pool-filters/);
  assert.match(css,/\.v3-category-pill/);
  assert.match(migration,/const schema='3'/);
  assert.match(migration,/removeItem\('workbench-v3-inbox-reviews-v1'\)/);
});
