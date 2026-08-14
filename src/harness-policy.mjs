/**
 * Fixed P0 capability surface for the read-only Harness Navigator.
 *
 * This allow-list is intentionally narrower than "every tool currently marked
 * readOnly". New tools do not become model-visible merely because a future
 * developer labels them read-only; they must be reviewed and added here.
 */
export const HARNESS_NAVIGATOR_TOOL_ALLOWLIST=Object.freeze([
  'panel_navigate',
  'inbox_search',
  'project_list',
  'todo_list',
  'journal_read',
  'confirmation_list',
  'business_list',
  'project_records_read'
]);

const allowedNames=new Set(HARNESS_NAVIGATOR_TOOL_ALLOWLIST);

export function isHarnessNavigatorTool(name){
  return typeof name==='string'&&allowedNames.has(name);
}

export function assertHarnessNavigatorTool(name){
  if(isHarnessNavigatorTool(name))return name;
  throw Object.assign(new Error('该工具不在 Navigator P0 只读白名单中。'),{
    code:'HARNESS_TOOL_NOT_ALLOWED',
    statusCode:403
  });
}
