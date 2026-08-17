export const LEGACY_MCP_PROVIDER_ID='workbench-v3-mcp';

export function createLegacyMcpInvoker({mcpRegistry}={}){
  if(!mcpRegistry||typeof mcpRegistry.call!=='function'){
    throw new TypeError('createLegacyMcpInvoker requires the existing Workbench v3 MCP registry');
  }
  return Object.freeze({
    providerId:LEGACY_MCP_PROVIDER_ID,
    invoke:(name,args={},options={})=>mcpRegistry.call(name,args,options)
  });
}
