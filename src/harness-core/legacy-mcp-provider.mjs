const LOCAL_EPHEMERAL_TOOLS=new Set([
  'panel_navigate',
  'joycrew_workspace_open',
  'joycrew_run_prepare',
  'joycrew_deliverable_prepare',
  'joycrew_approval_prepare'
]);

function legacyRisk(tool){
  return tool?.readOnly===true?'read':'external_write';
}

function legacyEffect(tool){
  if(typeof tool?.effect==='string'&&tool.effect.trim())return tool.effect.trim();
  if(LOCAL_EPHEMERAL_TOOLS.has(tool?.name))return'local_ephemeral';
  if(tool?.readOnly===true)return'read';
  return'write_unknown';
}

export function createLegacyMcpProvider({mcpRegistry}={}){
  if(!mcpRegistry||!Array.isArray(mcpRegistry.tools)){
    throw new TypeError('createLegacyMcpProvider requires the existing Workbench v3 MCP registry');
  }

  const capabilityId='workbench.v3.mcp';
  const tools=mcpRegistry.tools.map(tool=>({
    name:tool.name,
    description:tool.description??'',
    capabilityId,
    effect:legacyEffect(tool),
    risk:legacyRisk(tool),
    readOnly:tool.readOnly===true,
    requiresConfirmation:tool.requiresConfirmation===true,
    inputSchema:tool.inputSchema??{},
    metadata:{legacy:true}
  }));

  return {
    id:'workbench-v3-mcp',
    capabilities:[{
      id:capabilityId,
      name:'Workbench v3 MCP compatibility surface',
      description:'Temporary compatibility capability exposing existing Workbench v3 MCP tool metadata without changing tool names or behavior.',
      toolNames:tools.map(tool=>tool.name),
      metadata:{migrationOnly:true,source:'src/mcp/registry.mjs'}
    }],
    tools,
    metadata:{migrationOnly:true}
  };
}
