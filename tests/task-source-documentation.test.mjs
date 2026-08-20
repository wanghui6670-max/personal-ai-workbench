import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('v3 normative source contract makes explicit Feishu todos the only personal todo sync source',async()=>{
  const contract=await read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md');
  assert.match(contract,/Normative \/ 当前有效/);
  assert.match(contract,/待办来源：飞书云文档中的明确待办/);
  assert.match(contract,/待办同步不得读取整篇飞书日记再让 AI 猜哪些内容是任务/);
  assert.match(contract,/飞书原生未完成待办 \/ 复选框类 block/);
  assert.match(contract,/checkbox \/ task \/ todo/);
  assert.match(contract,/checked \/ done \/ completed/);
  assert.match(contract,/明确收件箱中的 `\[INBOX\]` 条目/);
  assert.match(contract,/普通 `p` 段落/);
  assert.match(contract,/普通列表项/);
  assert.match(contract,/工作日记/);
  assert.match(contract,/复盘/);
  assert.match(contract,/分析、观点、结论、策略/);
  assert.match(contract,/项目进展/);
  assert.match(contract,/不得进入待办同步/);
  assert.match(contract,/mode = todo_only/);
  assert.match(contract,/`mixed_diary`[\s\S]*历史兼容/);
  assert.match(contract,/Unicode NFKC/);
  assert.match(contract,/不得用模糊语义相似度自动删除两个不同待办/);
  assert.match(contract,/自动撤下本地 `feishu_todo_candidate`/);
  assert.match(contract,/source=feishu_doc \+ feishuMode=mixed_diary/);
  assert.match(contract,/不删除、不修改飞书原文/);
  assert.match(contract,/AI 不负责“从日记找任务”/);
  assert.match(contract,/不自动新建项目/);
  assert.match(contract,/不自动加入 Today/);
  assert.match(contract,/Workbench 本地 `state\.json`.*真相源/);
  assert.match(contract,/\/api\/inbox\/sync/);
});

test('v3 normative source contract keeps GetNote only as confirmed self-media content ingestion',async()=>{
  const [contract,contentSync,contentTools]=await Promise.all([
    read('docs/WORKBENCH_V3_SOURCE_CONTRACT.md'),
    read('src/getnote-content-sync.mjs'),
    read('src/mcp/content-tools.mjs')
  ]);
  assert.match(contract,/得到大脑不进入个人待办主链路，只保留自媒体内容来源/);
  assert.match(contract,/getnote_content_status/);
  assert.match(contract,/getnote_content_sync/);
  assert.match(contract,/用户确认后同步可验证真实原文到本地内容库/);
  assert.match(contract,/external_tasks_sync[\s\S]*不得重新注册为个人待办主来源/);
  assert.match(contentSync,/CONTENT_FOLDER='得到大脑内容'/);
  assert.match(contentSync,/safeAtomicWrite/);
  assert.match(contentSync,/createGetnoteNoteClient/);
  assert.match(contentTools,/name:'getnote_content_sync'/);
  assert.match(contentTools,/requiresConfirmation:true/);
});

test('deployment guidance keeps legacy GetNote task sync outside the R1 personal-task source',async()=>{
  const deployment=await read('docs/DEPLOYMENT.md');
  assert.match(deployment,/R1 正式运行画像：`local_single_user`/);
  assert.match(deployment,/飞书云文档中的明确待办.*个人工作事项主入口/s);
  assert.match(deployment,/GetNote.*自媒体内容来源/s);
  assert.match(deployment,/Legacy GetNote Task Sync v2.*不属于 R1/s);
  assert.doesNotMatch(deployment,/飞书是可选沉淀 sink，不再是个人待办来源/);
});

test('interactive registry exposes Feishu initialization, batch and content tools but not diary extraction or legacy GetNote task tools',async()=>{
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
  assert.match(registry,/createContentTools/);
  assert.doesNotMatch(registry,/createDiaryExtractionTools/);
  assert.doesNotMatch(registry,/planDiaryReviewAI|localDiaryReviewPlan/);
  assert.doesNotMatch(registry,/createExternalTaskTools/);
  assert.doesNotMatch(registry,/planExternalTaskMessage/);
  assert.match(contract,/兼容 MCP 工具名继续使用 `feishu_inbox_sync`/);
  assert.match(contract,/`diary_extract_todos`[\s\S]*不得注册到当前交互式 MCP \/ AI 工具面/);
  assert.match(contract,/`getnote_content_sync`/);
  assert.match(contract,/`external_tasks_sync` \/ `external_task_integration_update` 不得重新注册/);
  assert.match(diaryTool,/name:'diary_extract_todos'/,'legacy implementation may remain in source for regression only');
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
