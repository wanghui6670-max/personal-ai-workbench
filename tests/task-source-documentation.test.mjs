import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('v3 normative source contract makes mixed Feishu diary primary, first-seen and atomic-todo-only before confirmed Todo creation',async()=>{
  const contract=await read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md');
  assert.match(contract,/Normative \/ 当前有效/);
  assert.match(contract,/个人工作事实：飞书工作日记/);
  assert.match(contract,/用户主动同步/);
  assert.match(contract,/first-seen \/ append-only/);
  assert.match(contract,/单条日记 block 提取 0–5 个原子待办/);
  assert.match(contract,/只有原子待办候选进入 Workbench 待处理流/);
  assert.match(contract,/用户补齐必要字段并确认/);
  assert.match(contract,/Workbench Todo/);
  assert.match(contract,/mixed diary/);
  assert.match(contract,/原始飞书 block 是证据单元，不等于任务单元/);
  assert.match(contract,/不把整个飞书段落直接当作 Todo/);
  assert.match(contract,/一段允许提取 0–5 个原子待办/);
  assert.match(contract,/feishu_todo_candidate/);
  assert.match(contract,/Unicode NFKC/);
  assert.match(contract,/不得用模糊语义相似度自动删除两个不同事项/);
  assert.match(contract,/0 个待办[\s\S]*不创建 Todo/);
  assert.match(contract,/不创建 Note/);
  assert.match(contract,/不写项目记录/);
  assert.match(contract,/活动日志[\s\S]*不得复制私人日记正文/);
  assert.match(contract,/\/api\/inbox\/sync/);
  assert.match(contract,/不猜截止日期/);
  assert.match(contract,/不得自动新建项目/);
  assert.match(contract,/不得自动加入 Today/);
  assert.match(contract,/不删除或改写飞书日记原文/);
  assert.match(contract,/Workbench 本地 `state\.json`.*真相源/);
  assert.match(contract,/今日与收件箱/);
});

test('v3 normative source contract keeps GetNote only as confirmed self-media content ingestion',async()=>{
  const [contract,contentSync,contentTools]=await Promise.all([
    read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md'),
    read('src/getnote-content-sync.mjs'),
    read('src/mcp/content-tools.mjs')
  ]);
  assert.match(contract,/得到大脑只保留为自媒体内容来源/);
  assert.match(contract,/不得再把得到大脑 `meeting_todos` 作为个人待办的产品级主来源/);
  assert.match(contract,/getnote_content_status/);
  assert.match(contract,/getnote_content_sync/);
  assert.match(contract,/用户确认后同步可验证真实原文到本地内容库/);
  assert.match(contract,/external_tasks_sync[\s\S]*旧待办工具不得重新注册为当前个人任务主入口/);
  assert.match(contract,/<WORKSPACE_ROOT>\/<业务序号>_自媒体\/得到大脑内容\//);
  assert.match(contentSync,/CONTENT_FOLDER='得到大脑内容'/);
  assert.match(contentSync,/safeAtomicWrite/);
  assert.match(contentSync,/createGetnoteNoteClient/);
  assert.match(contentTools,/name:'getnote_content_sync'/);
  assert.match(contentTools,/requiresConfirmation:true/);
});

test('interactive registry exposes Feishu extraction, initialization, batch and content tools while legacy GetNote task tools stay compatibility-only',async()=>{
  const [contract,registry,legacyTools,taskCli,runtime,diaryTool,batchTool]=await Promise.all([
    read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md'),
    read('src/mcp/registry.mjs'),
    read('src/mcp/external-task-tools.mjs'),
    read('src/task-cli.mjs'),
    read('src/getnote-runtime.mjs'),
    read('src/mcp/diary-extraction-tools.mjs'),
    read('src/mcp/inbox-batch-tools.mjs')
  ]);
  assert.match(registry,/const workbenchTools=createWorkbenchTools\(\)/);
  assert.match(registry,/createFeishuInitializeTools/);
  assert.match(registry,/createInboxBatchTools/);
  assert.match(registry,/createDiaryExtractionTools/);
  assert.match(registry,/createContentTools/);
  assert.doesNotMatch(registry,/createExternalTaskTools/);
  assert.doesNotMatch(registry,/planExternalTaskMessage/);
  assert.match(contract,/兼容 MCP 工具名可继续保留 `feishu_inbox_sync`/);
  assert.match(contract,/`diary_extract_todos`/);
  assert.match(contract,/`getnote_content_sync`/);
  assert.match(contract,/`external_tasks_sync` \/ `external_task_integration_update` 等旧待办工具不得重新注册/);
  assert.match(diaryTool,/name:'diary_extract_todos'/);
  assert.match(diaryTool,/requiresConfirmation:false/);
  assert.match(batchTool,/name:'inbox_batch_delete'/);
  assert.match(batchTool,/requiresConfirmation:true/);

  for(const name of ['external_task_integration_read','external_task_integration_update','external_tasks_sync','daily_summary_publish']){
    assert.match(legacyTools,new RegExp(name));
  }

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
