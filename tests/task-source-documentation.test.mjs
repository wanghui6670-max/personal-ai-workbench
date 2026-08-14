import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('normative docs keep Dida CLI as source, Feishu as journal sink, and ICS as a mirror',async()=>{
  const [readme,product,architecture,api,deployment,pipeline]=await Promise.all([
    read('README.md'),
    read('docs/PRODUCT_SPEC.md'),
    read('docs/ARCHITECTURE.md'),
    read('docs/API.md'),
    read('docs/DEPLOYMENT.md'),
    read('docs/TASK_SOURCE_PIPELINE.md')
  ]);
  for(const document of [readme,product,architecture,api,deployment,pipeline]){
    assert.match(document,/ticktick/);
    assert.match(document,/dida365\.com/);
    assert.match(document,/personal-ai-workbench\.ics/);
  }
  assert.match(product,/飞书《每日工作日记》.*沉淀目标/);
  assert.match(architecture,/飞书每日工作日记\s+── 个人任务快照与每日总结 sink/);
  assert.match(api,/飞书不再是个人待办来源/);
  assert.match(pipeline,/不反向.*滴答|不反向修改滴答/);
});

test('external task API documents the exact MCP tools, confirmation boundary, and fixed CLI binary',async()=>{
  const [api,pipeline,registry,taskCli]=await Promise.all([
    read('docs/API.md'),
    read('docs/TASK_SOURCE_PIPELINE.md'),
    read('src/mcp/registry.mjs'),
    read('src/task-cli.mjs')
  ]);
  for(const name of [
    'external_task_integration_read',
    'external_task_integration_update',
    'external_tasks_sync',
    'daily_summary_publish'
  ]){
    assert.match(api,new RegExp(name));
    assert.match(registry,new RegExp(name));
  }
  assert.match(api,/EXTERNAL_TASK_PIPELINE_BUSY/);
  assert.match(api,/FEISHU_DAILY_JOURNAL_OPERATION_CONFLICT/);
  assert.match(pipeline,/旧的 `feishu_inbox_sync` 已从 AI\/MCP 白名单移除/);
  assert.match(taskCli,/const CLI_COMMAND='ticktick'/);
  assert.doesNotMatch(taskCli,/exec\([^)]*config|execFile\([^)]*config/);
});

test('backup and recovery documentation remains exact after the source migration',async()=>{
  const [readme,api,deployment,architecture]=await Promise.all([
    read('README.md'),read('docs/API.md'),read('docs/DEPLOYMENT.md'),read('docs/ARCHITECTURE.md')
  ]);
  for(const document of [readme,api,deployment,architecture]){
    assert.match(document,/captureReceipts/);
    assert.match(document,/projectRecordReceipts/);
  }
  assert.match(api,/GET \/api\/export/);
  assert.match(api,/不是完整恢复包/);
  assert.match(deployment,/旧备份没有 `captureReceipts` 或 `projectRecordReceipts` 字段时/);
});
