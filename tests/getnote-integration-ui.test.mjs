import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('browser keeps GetNote only as confirmed self-media content ingestion',async()=>{
  const [index,script]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/getnote-integration.js','utf8')
  ]);
  assert.match(index,/getnote-integration\.js/);
  assert.match(index,/workbench-v3\.js/);
  assert.match(script,/getnote_content_status/);
  assert.match(script,/getnote_content_sync/);
  assert.match(script,/自媒体/);
  assert.match(script,/得到大脑 → 自媒体本地内容库/);
  assert.match(script,/不创建待办/);
  assert.match(script,/不加入 Today/);
  assert.match(script,/不写回得到大脑/);
  assert.match(script,/确认同步最近 50 篇/);
  assert.match(script,/rpc\('getnote_content_sync',\{limit:50\},true\)/);
  assert.doesNotMatch(script,/external_tasks_sync/);
  assert.doesNotMatch(script,/external_task_integration_update/);
  assert.doesNotMatch(script,/daily_summary_publish/);
  assert.doesNotMatch(script,/data-action="sync-feishu"/);
  assert.doesNotMatch(script,/data-action="save-settings"/);
});
