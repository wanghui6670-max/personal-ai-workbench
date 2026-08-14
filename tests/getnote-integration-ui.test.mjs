import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('browser loads the GetNote source, Feishu journal and local calendar integration layer',async()=>{
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
  assert.match(script,/getnote notes/);
  assert.match(script,/getnote note todos/);
  assert.match(script,/只有待办文字中能确定日期的事项才进入本机日历/);
  assert.match(script,/最近笔记扫描数量必须是 20-500/);
  assert.match(script,/raw\?\.provider==='dida_cli'/);
  assert.match(script,/lastSyncStatus:'needs_reconfiguration'/);
  assert.match(script,/enabled:false,provider:'getnote_cli'/);
  assert.doesNotMatch(script,/TICKTICK_HOST|ticktick\.com|dida365\.com/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB/);
  assert.match(styles,/\.getnote-settings/);
});
