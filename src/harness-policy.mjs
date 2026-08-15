import crypto from 'node:crypto';

/**
 * Fixed capability surface for the unified Harness workspace.
 *
 * Workbench state-changing tools remain excluded. Joycrew mutation requests are
 * represented only by *_prepare tools, which create an expiring in-memory
 * preview. The external Joycrew state changes only through the authenticated
 * user confirmation endpoint.
 */
export const HARNESS_COMPOSITION_ID='workbench-unified-copilot-v1';

export const HARNESS_NAVIGATOR_TOOL_ALLOWLIST=Object.freeze([
  'panel_navigate',
  'inbox_search',
  'project_list',
  'todo_list',
  'journal_read',
  'confirmation_list',
  'business_list',
  'project_records_read',
  'joycrew_workspace_open',
  'joycrew_status_read',
  'joycrew_dashboard_read',
  'joycrew_project_list',
  'joycrew_project_read',
  'joycrew_customer_list',
  'joycrew_task_list',
  'joycrew_approval_list',
  'joycrew_deliverable_list',
  'joycrew_pending_action_list',
  'joycrew_run_prepare',
  'joycrew_deliverable_prepare',
  'joycrew_approval_prepare'
]);

export const HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256=crypto
  .createHash('sha256')
  .update(JSON.stringify(HARNESS_NAVIGATOR_TOOL_ALLOWLIST))
  .digest('hex');

const allowedNames=new Set(HARNESS_NAVIGATOR_TOOL_ALLOWLIST);

export function isHarnessNavigatorTool(name){
  return typeof name==='string'&&allowedNames.has(name);
}

export function assertHarnessNavigatorTool(name){
  if(isHarnessNavigatorTool(name))return name;
  throw Object.assign(new Error('该工具不在统一 Harness 能力白名单中。'),{
    code:'HARNESS_TOOL_NOT_ALLOWED',
    statusCode:403
  });
}
