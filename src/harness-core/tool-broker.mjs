function brokerError(message,code,statusCode){
  return Object.assign(new Error(message),{code,statusCode});
}

export class ToolBroker{
  #registry;
  #invokers=new Map();

  constructor({registry}={}){
    if(!registry||typeof registry.getTool!=='function'||typeof registry.getProvider!=='function'){
      throw new TypeError('ToolBroker requires a CapabilityRegistry');
    }
    this.#registry=registry;
  }

  registerInvoker({providerId,invoke}={}){
    const id=String(providerId??'').trim();
    if(!id||typeof invoke!=='function')throw new TypeError('invoker requires providerId and invoke');
    if(!this.#registry.getProvider(id))throw brokerError(`unknown capability provider: ${id}`,'HARNESS_PROVIDER_UNAVAILABLE',503);
    if(this.#invokers.has(id))throw new Error(`invoker already registered: ${id}`);
    this.#invokers.set(id,invoke);
    return id;
  }

  async call(name,args={},options={}){
    const toolName=String(name??'').trim();
    const tool=this.#registry.getTool(toolName);
    if(!tool)throw brokerError(`未知 MCP 工具：${toolName}`,'MCP_TOOL_NOT_FOUND',404);
    const invoke=this.#invokers.get(tool.providerId);
    if(!invoke){
      throw brokerError(`Harness capability provider unavailable: ${tool.providerId}`,'HARNESS_PROVIDER_UNAVAILABLE',503);
    }
    return invoke(tool.name,args??{},options??{});
  }
}
