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

test('classification pool keeps todos active and privacy-safely removes non-todo Feishu items from the local queue',async()=>{
  const [index,script,css,migration]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3-auto-classify.js','utf8'),
    fsp.readFile('public/workbench-v3-focus.css','utf8'),
    fsp.readFile('public/workbench-v3-review-migration.js','utf8')
  ]);
  assert.match(index,/workbench-v3-auto-classify\.js/);
  assert.ok(index.indexOf('workbench-v3-review-migration.js')<index.indexOf('workbench-v3.js'));
  for(const label of ['待办候选','项目进展','分析思考','日常记录','需要决定','分析中'])assert.match(script,new RegExp(label));
  assert.match(script,/AUTO_FILTER_NON_TODO=new Set\(\['project','analysis','daily'\]\)/);
  assert.match(script,/v3AutoFilter='active'/);
  assert.match(script,/category==='todo'\|\|category==='pending'/);
  assert.match(script,/fetch\('\/api\/inbox\/command'/);
  assert.match(script,/不进入待办：\$\{category\}/);
  assert.match(script,/飞书\(\?:同步\|日记\)/,'filtering must survive visible source label polish from 飞书同步 to 飞书日记');
  assert.match(script,/data\.filtered!==true/,'frontend must require a backend acknowledgement before treating an item as filtered');
  assert.match(script,/\[id\^="cmd-"\]/,'item identity must prefer the stable command host instead of an arbitrary action button');
  assert.doesNotMatch(script,/command:'删除'/);
  assert.match(script,/已过滤非待办/);
  assert.match(script,/observe\(main,\{childList:true\}\)/);
  assert.doesNotMatch(script,/observe\(main,\{childList:true,subtree:true\}\)/);
  assert.match(css,/\.v3-pool-filters/);
  assert.match(css,/\.v3-category-pill/);
  assert.match(migration,/const schema='3'/);
  assert.match(migration,/removeItem\('workbench-v3-inbox-reviews-v1'\)/);
});
