function legacyRisk(tool){
  return tool.readOnly===true?'read':'external_write';
}

function publicMetadata(tool){
  return Object.freeze({
    legacy:true,
    inputSchema:tool.inputSchema??{},
    readOnly:tool.readOnly===true,
    requiresConfirmation:tool.requiresConfirmation===true
  });
}

export function createWorkbenchV3RegistryPack({mcpRegistry}={}){
  if(!mcpRegistry||!Array.isArray(mcpRegistry.tools)||typeof mcpRegistry.call!=='function'){
    throw new TypeError('createWorkbenchV3RegistryPack requires the existing Workbench v3 MCP registry');
  }
  const tools=mcpRegistry.tools.map(legacy=>({
    name:legacy.name,
    description:legacy.description??'',
    risk:legacyRisk(legacy),
    approval:legacy.requiresConfirmation===true?'confirm':null,
    reversible:false,
    idempotent:legacy.readOnly===true,
    metadata:publicMetadata(legacy),
    execute:async(input,context={})=>{
      const confirmed=legacy.requiresConfirmation!==true||context.approved===true||context.explicit===true;
      const outcome=await mcpRegistry.call(legacy.name,input,{confirmed});
      return outcome?.result??outcome;
    }
  }));
  return {
    id:'workbench-v3-bridge',
    name:'Workbench v3 Compatibility Bridge',
    version:'1.0.0',
    capabilities:[{
      id:'workbench.v3.bridge',
      kind:'compatibility_adapter',
      description:'Expose the existing Workbench v3 MCP registry through Harness-first Tool contracts.'
    }],
    tools,
    agents:[],schedules:[],skills:[],views:[],
    metadata:{migrationOnly:true,source:'src/mcp/registry.mjs'}
  };
}
