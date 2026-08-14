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

test('Navigator P0 exposes a fixed reviewed read-only tool set',()=>{
  const registry=createWorkbenchRegistry({appRoot:process.cwd(),store:{}});
  const tools=registry.list({readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST});
  assert.deepEqual(tools.map(tool=>tool.name).sort(),[...HARNESS_NAVIGATOR_TOOL_ALLOWLIST].sort());
  assert.equal(tools.every(tool=>tool.readOnly===true),true);
  assert.equal(tools.every(tool=>tool.requiresConfirmation!==true),true);
  for(const name of MUTATING_TOOLS)assert.equal(isHarnessNavigatorTool(name),false,name);
  assert.equal(isHarnessNavigatorTool('workbench_get_state'),false,'broad full-state reads are not auto-exposed');
});

test('registry denies a mutating or unreviewed tool before reading state',async()=>{
  const registry=createWorkbenchRegistry({appRoot:process.cwd(),store:{}});
  await assert.rejects(
    registry.call('inbox_add',{text:'must not run'},{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST}),
    error=>error?.code==='MCP_TOOL_NOT_ALLOWED'&&error?.statusCode===403
  );
  await assert.rejects(
    registry.call('workbench_get_state',{}, {readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST}),
    error=>error?.code==='MCP_TOOL_NOT_ALLOWED'
  );
});
