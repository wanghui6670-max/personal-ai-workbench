export function createLegacyMcpProvider({id='legacy-mcp',mcpRegistry,capabilities=[]}={}){
  if(!mcpRegistry)throw new Error('createLegacyMcpProvider requires mcpRegistry');
  let enabled=true;
  const declared=new Set(capabilities.flatMap(item=>item.toolNames||[]));

  function listCapabilities(){
    return capabilities.map(item=>({
      id:item.id,
      providerId:id,
      toolNames:[...item.toolNames],
      status:enabled?'enabled':'disabled'
    }));
  }

  function listTools(capabilityId){
    if(!enabled)return [];
    const allowed=capabilityId
      ?new Set((capabilities.find(item=>item.id===capabilityId)?.toolNames)||[])
      :declared;
    return mcpRegistry.list().filter(tool=>allowed.has(tool.name));
  }

  async function call(name,args={},options={}){
    if(!declared.has(name)){
      throw Object.assign(new Error(`未知 MCP 工具：${name}`),{code:'MCP_TOOL_NOT_FOUND',statusCode:404});
    }
    if(!enabled){
      throw Object.assign(new Error(`工具 ${name} 不在本次调用的能力白名单中。`),{code:'MCP_TOOL_NOT_ALLOWED',statusCode:403});
    }
    return mcpRegistry.call(name,args,options);
  }

  return Object.freeze({
    id,
    listCapabilities,
    listTools,
    call,
    setEnabled(value){enabled=value===true;},
    get enabled(){return enabled;}
  });
}
