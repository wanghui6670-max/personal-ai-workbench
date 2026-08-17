function legacyRisk(tool){
  return tool?.readOnly===true?'read':'external_write';
}

export function createLegacyMcpProvider({mcpRegistry}={}){
  if(!mcpRegistry||!Array.isArray(mcpRegistry.tools)||typeof mcpRegistry.call!=='function'){
    throw new TypeError('createLegacyMcpProvider requires the existing Workbench v3 MCP registry');
  }

  const capabilityId='workbench.v3.mcp';
  const tools=mcpRegistry.tools.map(tool=>({
    name:tool.name,
    description:tool.description??'',
    capabilityId,
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
      description:'Temporary compatibility capability exposing existing Workbench v3 MCP tools without changing their names or behavior.',
      toolNames:tools.map(tool=>tool.name),
      metadata:{migrationOnly:true,source:'src/mcp/registry.mjs'}
    }],
    tools,
    call:(name,args={},options={})=>mcpRegistry.call(name,args,options),
    metadata:{migrationOnly:true}
  };
}
