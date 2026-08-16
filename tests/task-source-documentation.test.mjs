import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('v3 normative source contract makes Feishu primary, Workbench state truth, and AI confirm-before-execute',async()=>{
  const contract=await read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md');
  assert.match(contract,/Normative \/ 当前有效/);
  assert.match(contract,/飞书云文档 → Workbench Inbox → AI 自动分析 → 用户确认 → Workbench 执行/);
  assert.match(contract,/\/api\/inbox\/sync/);
  assert.match(contract,/\/api\/ai\/plan/);
  assert.match(contract,/\/api\/ai\/execute \{ confirmed: true \}/);
  assert.match(contract,/Workbench 本地 `state\.json`.*真相源/);
  assert.match(contract,/不得自动加入 Today/);
  assert.match(contract,/不得自动新建项目/);
  assert.match(contract,/不得仅凭猜测删除来源事项/);
  assert.match(contract,/今日与收件箱/);
  assert.match(contract,/最近工作现场.*项目进度/);
  assert.match(contract,/覆盖并取代[\s\S]*GetNote Task Sync v2/);
});

test('v3 normative source contract keeps GetNote only as confirmed self-media content ingestion',async()=>{
  const [contract,contentSync,contentTools]=await Promise.all([
    read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md'),
    read('src/getnote-content-sync.mjs'),
    read('src/mcp/content-tools.mjs')
  ]);
  assert.match(contract,/得到大脑不再进入个人待办主链路/);
  assert.match(contract,/getnote_content_status/);
  assert.match(contract,/getnote_content_sync/);
  assert.match(contract,/得到大脑内容/);
  assert.match(contract,/不会创建 Todo|不会创建待办/);
  assert.match(contract,/不会进入 Inbox/);
  assert.match(contract,/不会加入 Today/);
  assert.match(contract,/不会写回 GetNote/);
  assert.match(contract,/fail closed/);
  assert.match(contentSync,/CONTENT_FOLDER='得到大脑内容'/);
  assert.match(contentSync,/safeAtomicWrite/);
  assert.match(contentSync,/createGetnoteNoteClient/);
  assert.match(contentTools,/name:'getnote_content_sync'/);
  assert.match(contentTools,/requiresConfirmation:true/);
});

test('interactive registry exposes Feishu and content tools while legacy GetNote task tools stay compatibility-only',async()=>{
  const [contract,registry,legacyTools,taskCli,runtime]=await Promise.all([
    read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md'),
    read('src/mcp/registry.mjs'),
    read('src/mcp/external-task-tools.mjs'),
    read('src/task-cli.mjs'),
    read('src/getnote-runtime.mjs')
  ]);
  assert.match(registry,/const workbenchTools=createWorkbenchTools\(\)/);
  assert.match(registry,/createContentTools/);
  assert.doesNotMatch(registry,/createExternalTaskTools/);
  assert.doesNotMatch(registry,/planExternalTaskMessage/);
  assert.match(contract,/`feishu_inbox_sync` \| 是 \| 是/);
  assert.match(contract,/`getnote_content_sync` \| 是 \| 是/);
  assert.match(contract,/`external_tasks_sync` \| 否/);
  assert.match(contract,/“同步得到大脑待办” → clarification/);

  for(const name of ['external_task_integration_read','external_task_integration_update','external_tasks_sync','daily_summary_publish']){
    assert.match(legacyTools,new RegExp(name));
  }
  assert.match(contract,/旧模块可暂时留在代码库用于迁移、历史数据兼容和回归/);

  assert.match(taskCli,/createGetnoteReader/);
  assert.match(taskCli,/reader\.listNotes/);
  assert.match(taskCli,/runtime\.fetchTodos/);
  assert.match(taskCli,/meeting_todos/);
  assert.doesNotMatch(taskCli,/node:child_process|execFile\(/);

  assert.match(runtime,/const CLI='getnote'/);
  assert.match(runtime,/\['notes','--limit'/);
  assert.match(runtime,/\['note','todos',normalizeGetnoteNoteId\(noteId\),'-o','json'\]/);
  assert.match(runtime,/\['note',normalizeGetnoteNoteId\(noteId\),'-o','json'\]/);
  assert.doesNotMatch(runtime,/save|delete|update[^A-Za-z]/i);
});

test('backup and recovery documentation remains exact after the source correction',async()=>{
  const [readme,api,deployment,architecture]=await Promise.all([
    read('README.md'),read('docs/API.md'),read('docs/DEPLOYMENT.md'),read('docs/ARCHITECTURE.md')
  ]);
  for(const document of [readme,api,deployment,architecture]){
    assert.match(document,/captureReceipts/);
    assert.match(document,/projectRecordReceipts/);
  }
  assert.match(api,/GET \/api\/export/);
  assert.match(api,/不是完整恢复包/);
  assert.match(deployment,/旧备份若没有 `captureReceipts` 或 `projectRecordReceipts` 字段时/);
});
