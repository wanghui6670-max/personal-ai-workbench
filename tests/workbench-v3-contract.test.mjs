import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('v3 merges Today and Inbox with Feishu-first AI review before execution',async()=>{
  const [index,script,registry,contentTools,scope]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3.js','utf8'),
    fsp.readFile('src/mcp/registry.mjs','utf8'),
    fsp.readFile('src/mcp/content-tools.mjs','utf8'),
    fsp.readFile('src/ai-review-scope.mjs','utf8')
  ]);
  assert.match(index,/workbench-v3\.css/);assert.match(index,/workbench-v3\.js/);
  assert.match(script,/今日与收件箱/);
  assert.match(script,/飞书主来源/);
  assert.match(script,/同步飞书并自动分析/);
  assert.match(script,/\/api\/inbox\/sync/);
  assert.match(script,/\/api\/ai\/plan/);
  assert.match(script,/\/api\/ai\/execute/);
  assert.match(script,/confirmed:true/);
  assert.match(script,/AI 自动分析/);
  assert.match(script,/确认并处理/);
  assert.match(script,/不得自动加入 Today/);
  assert.match(script,/不得自动创建项目/);
  assert.match(script,/原始信息没有明确删除意图/);
  assert.match(script,/项目现场与进度/);
  assert.match(script,/href='#media'/);
  assert.match(script,/a\[href="#inbox"\]/);
  assert.match(registry,/scopedInboxReviewState/);
  assert.match(registry,/scopedInboxReviewTools/);
  assert.match(registry,/enforceInboxReviewPlan/);
  assert.match(scope,/REVIEW_TOOL='inbox_process'/);
  assert.match(registry,/createContentTools/);assert.match(registry,/planContentMessage/);
  assert.match(contentTools,/getnote_content_sync/);assert.match(contentTools,/requiresConfirmation:true/);
});

test('Feishu auto review is bounded, scoped to one item and reuses unchanged session previews',async()=>{
  const script=await fsp.readFile('public/workbench-v3.js','utf8');
  assert.match(script,/AUTO_ANALYZE_CONCURRENCY=2/);
  assert.match(script,/AUTO_ANALYZE_QUEUE_LIMIT=100/);
  assert.match(script,/view:'inbox-review',id:item\.id/);
  assert.match(script,/sessionStorage\.getItem\(REVIEW_CACHE_KEY\)/);
  assert.match(script,/REVIEW_CACHE_MAX_AGE_MS=9\*60\*1000/);
  assert.match(script,/reviewKey\(item\)/);
  assert.match(script,/pumpAutoAnalyzeQueue/);
  assert.doesNotMatch(script,/AUTO_ANALYZE_LIMIT=12/);
  assert.doesNotMatch(script,/inboxPlans\.clear\(\)/,'sync must retain unchanged cached reviews');
});

test('v3 enhancement observer cannot self-trigger through descendant rewrites',async()=>{
  const script=await fsp.readFile('public/workbench-v3.js','utf8');
  assert.match(script,/new MutationObserver\(schedule\)\.observe\(appRoot,\{childList:true\}\)/);
  assert.doesNotMatch(script,/subtree:true/,'observing the whole #app subtree lets v3 DOM enhancements recursively trigger themselves');
  assert.match(script,/requestAnimationFrame\(\(\)=>\{scheduled=false;renderEnhancements\(\);\}\)/);
  assert.match(script,/today\.innerHTML!==wanted/);
  assert.match(script,/h\.textContent!==title/);
  assert.match(script,/button\.textContent!=='同步飞书收件箱'/);
});

test('legacy GetNote task UI no longer hijacks Feishu sync or settings',async()=>{
  const script=await fsp.readFile('public/getnote-integration.js','utf8');
  assert.doesNotMatch(script,/external_tasks_sync/);
  assert.doesNotMatch(script,/data-action="sync-feishu"/);
  assert.doesNotMatch(script,/save-settings/);
  assert.match(script,/得到大脑只做内容来源/);
});
