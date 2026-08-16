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

test('classification pools expose automatic buckets without subtree observer loops',async()=>{
  const [index,script,css,migration]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3-auto-classify.js','utf8'),
    fsp.readFile('public/workbench-v3-focus.css','utf8'),
    fsp.readFile('public/workbench-v3-review-migration.js','utf8')
  ]);
  assert.match(index,/workbench-v3-auto-classify\.js/);
  assert.ok(index.indexOf('workbench-v3-review-migration.js')<index.indexOf('workbench-v3.js'));
  for(const label of ['待办候选','项目进展','分析思考','日常记录','需要决定','分析中'])assert.match(script,new RegExp(label));
  assert.match(script,/observe\(main,\{childList:true\}\)/);
  assert.doesNotMatch(script,/observe\(main,\{childList:true,subtree:true\}\)/);
  assert.match(css,/\.v3-pool-filters/);
  assert.match(css,/\.v3-category-pill/);
  assert.match(migration,/removeItem\('workbench-v3-inbox-reviews-v1'\)/);
});
