const SUPPORTED_RISKS=new Set(['read','local-write','external-write','destructive']);

function assertTool(tool){
  if(!tool||typeof tool!=='object')throw new Error('tool must be an object');
  if(typeof tool.name!=='string'||!tool.name.trim())throw new Error('tool name is required');
  if(!SUPPORTED_RISKS.has(tool.risk))throw new Error(`unsupported risk: ${tool.risk}`);
  if(typeof tool.execute!=='function')throw new Error(`tool ${tool.name} requires execute()`);
}

export function createToolBroker({approvalEngine}={}){
  if(!approvalEngine)throw new Error('approvalEngine is required');
  const tools=new Map();
  return Object.freeze({
    register(tool){
      assertTool(tool);
      if(tools.has(tool.name))throw new Error(`tool already registered: ${tool.name}`);
      const value=Object.freeze({...tool});
      tools.set(value.name,value);
      return value;
    },
    get(name){return tools.get(name)||null;},
    list(){return [...tools.values()].map(({execute,...tool})=>tool);},
    async call(name,args={},approval={}){
      const tool=tools.get(name);
      if(!tool)throw new Error(`tool not found: ${name}`);
      const auth=approvalEngine.authorize(tool,approval);
      if(!auth.allowed)throw new Error(`approval required for ${name}: ${auth.policy.mode}`);
      return tool.execute(args,{approval:auth.policy});
    }
  });
}
