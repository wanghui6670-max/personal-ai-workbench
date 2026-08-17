function brokerError(message,code,statusCode){
  return Object.assign(new Error(message),{code,statusCode});
}

export class ToolBroker{
  #registry;
  #executionRecorder;
  #policy;
  #invokers=new Map();

  constructor({registry,executionRecorder=null,policy=null}={}){
    if(!registry||typeof registry.getTool!=='function'||typeof registry.getProvider!=='function'){
      throw new TypeError('ToolBroker requires a CapabilityRegistry');
    }
    if(executionRecorder!==null&&typeof executionRecorder?.run!=='function'){
      throw new TypeError('ToolBroker executionRecorder must expose run()');
    }
    if(policy!==null&&(policy?.mode!=='shadow'||typeof policy?.evaluate!=='function')){
      throw new TypeError('ToolBroker policy must be a shadow ToolPolicy');
    }
    this.#registry=registry;
    this.#executionRecorder=executionRecorder;
    this.#policy=policy;
  }

  registerInvoker({providerId,invoke}={}){
    const id=String(providerId??'').trim();
    if(!id||typeof invoke!=='function')throw new TypeError('invoker requires providerId and invoke');
    if(!this.#registry.getProvider(id))throw brokerError(`unknown capability provider: ${id}`,'HARNESS_PROVIDER_UNAVAILABLE',503);
    if(this.#invokers.has(id))throw new Error(`invoker already registered: ${id}`);
    this.#invokers.set(id,invoke);
    return id;
  }

  async call(name,args={},options={},context={}){
    const toolName=String(name??'').trim();
    const tool=this.#registry.getTool(toolName);
    if(!tool)throw brokerError(`未知 MCP 工具：${toolName}`,'MCP_TOOL_NOT_FOUND',404);
    const invoke=this.#invokers.get(tool.providerId);
    if(!invoke){
      throw brokerError(`Harness capability provider unavailable: ${tool.providerId}`,'HARNESS_PROVIDER_UNAVAILABLE',503);
    }
    if(this.#policy)this.#policy.evaluate({tool,options:options??{},context:context??{}});
    const operation=()=>invoke(tool.name,args??{},options??{});
    if(!this.#executionRecorder)return operation();
    const recorded=await this.#executionRecorder.run({tool,args:args??{},context:context??{}},operation);
    return recorded.outcome;
  }
}
