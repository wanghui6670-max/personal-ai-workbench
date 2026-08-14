import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('browser loads the Dida source, Feishu journal and local calendar integration layer',async()=>{
  const [index,script,styles]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/dida-integration.js','utf8'),
    fsp.readFile('public/dida-integration.css','utf8')
  ]);
  assert.match(index,/dida-integration\.css/);
  assert.match(index,/dida-integration\.js/);
  assert.match(script,/external_tasks_sync/);
  assert.match(script,/daily_summary_publish/);
  assert.match(script,/external_task_integration_update/);
  assert.match(script,/国际版（ticktick\.com）/);
  assert.match(script,/国内版（dida365\.com）/);
  assert.match(script,/固定的 <code>ticktick<\/code> CLI/);
  assert.match(script,/TICKTICK_HOST/);
  assert.match(script,/日历只镜像源任务已有的日期与时间/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB/);
  assert.match(styles,/\.dida-settings/);
});
