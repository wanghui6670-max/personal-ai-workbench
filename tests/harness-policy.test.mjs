import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchRegistry } from '../src/mcp/registry.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST,isHarnessNavigatorTool } from '../src/harness-policy.mjs';

const MUTATING_TOOLS=[
  'inbox_add','inbox_process','project_create','project_classify','project_update',
  'project_sync','projects_sync_all','todo_update','todo_today','feishu_inbox_sync',
  'confirmation_clear','business_create','business_rename','business_delete','config_update','backup_create',
  'project_summary_append'
];
const JOYCREW_PREVIEW_TOOLS=['joycrew_run_prepare','joycrew_deliverable_prepare','joycrew_approval_prepare'];

function registry(){
  const joycrewClient={};
  const joycrewActions={list:()=>[],prepare:()=>({id:'preview'})};
  return createWorkbenchRegistry({appRoot:process.cwd(),store:{},joycrewClient,joycrewActions});
}

test('unified Copilot exposes one fixed reviewed read-and-preview tool set',()=>{
  const tools=registry().list({readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST});
  // readOnlyOnly 过滤后的工具应全部是 readOnly
  assert.equal(tools.every(tool=>tool.readOnly===true),true);
  assert.equal(tools.every(tool=>tool.requiresConfirmation!==true),true);
  // 白名单中的 readOnly 工具应全部被暴露
  const readOnlyNames=new Set(tools.map(t=>t.name));
  for(const name of HARNESS_NAVIGATOR_TOOL_ALLOWLIST){
    // inbox_add 是白名单中唯一的 requiresConfirmation 工具，不通过 readOnlyOnly 过滤
    if(name==='inbox_add')continue;
    assert.ok(readOnlyNames.has(name),`${name} 应在 readOnly 工具列表中`);
  }
  for(const name of MUTATING_TOOLS){
    // inbox_add 在白名单中，但需确认才能执行（requiresConfirmation:true），不被自动暴露
    if(name==='inbox_add')continue;
    assert.equal(isHarnessNavigatorTool(name),false,name);
  }
  for(const name of JOYCREW_PREVIEW_TOOLS)assert.equal(isHarnessNavigatorTool(name),true,name);
  assert.equal(isHarnessNavigatorTool('workbench_get_state'),false,'broad full-state reads are not auto-exposed');
  assert.equal(isHarnessNavigatorTool('joycrew_run_create'),false,'external mutations are never directly model-visible');
});

test('registry denies a mutating or unreviewed tool before reading state',async()=>{
  const current=registry();
  await assert.rejects(
    current.call('inbox_add',{text:'must not run'},{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST}),
    error=>error?.code==='MCP_TOOL_NOT_ALLOWED'&&error?.statusCode===403
  );
  await assert.rejects(
    current.call('workbench_get_state',{}, {readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST}),
    error=>error?.code==='MCP_TOOL_NOT_ALLOWED'
  );
  await assert.rejects(
    current.call('joycrew_run_create',{}, {readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST}),
    error=>error?.code==='MCP_TOOL_NOT_FOUND'
  );
});
