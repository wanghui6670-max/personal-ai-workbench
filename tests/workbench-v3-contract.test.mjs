import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('v3 merges Today and Inbox with Feishu-first AI review before execution',async()=>{
  const [index,script,registry,contentTools]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/workbench-v3.js','utf8'),
    fsp.readFile('src/mcp/registry.mjs','utf8'),
    fsp.readFile('src/mcp/content-tools.mjs','utf8')
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
  assert.match(registry,/createContentTools/);assert.match(registry,/planContentMessage/);
  assert.match(contentTools,/getnote_content_sync/);assert.match(contentTools,/requiresConfirmation:true/);
});

test('legacy GetNote task UI no longer hijacks Feishu sync or settings',async()=>{
  const script=await fsp.readFile('public/getnote-integration.js','utf8');
  assert.doesNotMatch(script,/external_tasks_sync/);
  assert.doesNotMatch(script,/data-action="sync-feishu"/);
  assert.doesNotMatch(script,/save-settings/);
  assert.match(script,/得到大脑只做内容来源/);
});
