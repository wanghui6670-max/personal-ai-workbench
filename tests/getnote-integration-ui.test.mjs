import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('browser exposes Workbench-first GetNote sync with optional Feishu sink and explicit timezone',async()=>{
  const [index,script,styles]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/getnote-integration.js','utf8'),
    fsp.readFile('public/getnote-integration.css','utf8')
  ]);
  assert.match(index,/getnote-integration\.css/);
  assert.match(index,/getnote-integration\.js/);
  assert.doesNotMatch(index,/dida-integration/);
  assert.match(script,/external_tasks_sync/);
  assert.match(script,/daily_summary_publish/);
  assert.match(script,/external_task_integration_update/);
  assert.match(script,/meeting_todos/);
  assert.match(script,/未完成旧笔记/);
  assert.match(script,/Workbench 状态先原子提交/);
  assert.match(script,/飞书每日工作日记 URL（可选）/);
  assert.match(script,/getnote-time-zone/);
  assert.match(script,/Asia\/Shanghai/);
  assert.match(script,/最近笔记扫描数量必须是 20-500/);
  assert.match(script,/raw\?\.provider==='dida_cli'/);
  assert.match(script,/lastSyncStatus:'needs_reconfiguration'/);
  assert.match(script,/ok_with_sink_errors/);
  assert.match(script,/result\.metadata\?\.status==='error'/);
  assert.match(script,/核心已提交，状态元数据异常/);
  assert.match(script,/状态元数据失败/);
  assert.match(script,/['"]&quot;['"]/,'double quotes remain strictly escaped for injected settings HTML');
  assert.doesNotMatch(script,/启用同步时必须填写飞书每日工作日记 URL/);
  assert.doesNotMatch(script,/TICKTICK_HOST|ticktick\.com|dida365\.com/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB/);
  assert.match(styles,/\.getnote-settings/);
});
