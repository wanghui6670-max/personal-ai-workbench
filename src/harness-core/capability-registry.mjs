const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOOL_RISKS=new Set(['read','local_write','external_write','destructive']);

function requiredId(value,label){
  const id=String(value??'').trim();
  if(!ID_RE.test(id))throw new TypeError(`${label} must be a non-empty stable id`);
  return id;
}

function normalizedProvider(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new TypeError('provider must be an object');
  const id=requiredId(raw.id,'provider.id');
  const capabilities=Array.isArray(raw.capabilities)?raw.capabilities:[];
  const tools=Array.isArray(raw.tools)?raw.tools:[];
  const localCapabilities=new Set();
  const localTools=new Set();

  const normalizedCapabilities=capabilities.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new TypeError('capability must be an object');
    const capabilityId=requiredId(item.id,'capability.id');
    if(localCapabilities.has(capabilityId))throw new Error(`capability already registered in provider: ${capabilityId}`);
    localCapabilities.add(capabilityId);
    return Object.freeze({
      id:capabilityId,
      name:String(item.name??capabilityId),
      description:String(item.description??''),
      toolNames:Object.freeze((item.toolNames??[]).map(name=>requiredId(name,'capability.toolNames[]'))),
      metadata:Object.freeze({...item.metadata})
    });
  });

  const normalizedTools=tools.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new TypeError('tool must be an object');
    const name=requiredId(item.name,'tool.name');
    if(localTools.has(name))throw new Error(`tool already registered in provider: ${name}`);
    localTools.add(name);
    const capabilityId=requiredId(item.capabilityId,'tool.capabilityId');
    if(!localCapabilities.has(capabilityId))throw new Error(`tool ${name} references unknown provider capability: ${capabilityId}`);
    const risk=String(item.risk??'read');
    if(!TOOL_RISKS.has(risk))throw new TypeError(`unsupported tool risk: ${risk}`);
    return Object.freeze({
      name,
      description:String(item.description??''),
      capabilityId,
      risk,
      readOnly:item.readOnly===true,
      requiresConfirmation:item.requiresConfirmation===true,
      inputSchema:item.inputSchema??{},
      metadata:Object.freeze({...item.metadata})
    });
  });

  const availableToolNames=new Set(normalizedTools.map(item=>item.name));
  for(const capability of normalizedCapabilities){
    for(const name of capability.toolNames){
      if(!availableToolNames.has(name))throw new Error(`capability ${capability.id} references unknown provider tool: ${name}`);
    }
  }

  return Object.freeze({
    id,
    capabilities:Object.freeze(normalizedCapabilities),
    tools:Object.freeze(normalizedTools),
    metadata:Object.freeze({...raw.metadata})
  });
}

export class CapabilityRegistry{
  #providers=new Map();
  #capabilities=new Map();
  #tools=new Map();

  registerProvider(rawProvider){
    const provider=normalizedProvider(rawProvider);
    if(this.#providers.has(provider.id))throw new Error(`provider already registered: ${provider.id}`);
    for(const capability of provider.capabilities){
      if(this.#capabilities.has(capability.id))throw new Error(`capability already registered: ${capability.id}`);
    }
    for(const tool of provider.tools){
      if(this.#tools.has(tool.name))throw new Error(`tool already registered: ${tool.name}`);
    }

    const record={provider,enabled:true};
    this.#providers.set(provider.id,record);
    for(const capability of provider.capabilities)this.#capabilities.set(capability.id,{...capability,providerId:provider.id});
    for(const tool of provider.tools)this.#tools.set(tool.name,{...tool,providerId:provider.id});
    return provider;
  }

  setProviderEnabled(providerId,enabled){
    const record=this.#providers.get(providerId);
    if(!record)throw new Error(`unknown provider: ${providerId}`);
    record.enabled=enabled===true;
    return record.enabled;
  }

  getProvider(providerId){
    const record=this.#providers.get(providerId);
    return record?record.provider:null;
  }

  getCapability(capabilityId){
    const capability=this.#capabilities.get(capabilityId);
    if(!capability)return null;
    return this.#providers.get(capability.providerId)?.enabled===true?capability:null;
  }

  getTool(toolName){
    const tool=this.#tools.get(toolName);
    if(!tool)return null;
    return this.#providers.get(tool.providerId)?.enabled===true?tool:null;
  }

  listCapabilities(){
    return [...this.#capabilities.values()].filter(item=>this.#providers.get(item.providerId)?.enabled===true);
  }

  listTools(){
    return [...this.#tools.values()].filter(item=>this.#providers.get(item.providerId)?.enabled===true);
  }
}

export const HARNESS_TOOL_RISKS=Object.freeze([...TOOL_RISKS]);
