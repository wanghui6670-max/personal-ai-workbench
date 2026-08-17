export function createCapabilityRegistry(){
  const providers=new Map();

  function registerProvider(provider){
    if(!provider?.id)throw new Error('provider.id 必填');
    providers.set(provider.id,provider);
    return listCapabilities();
  }

  function unregisterProvider(id){
    providers.delete(id);
  }

  function getProvider(id){
    return providers.get(id)||null;
  }

  function setProviderEnabled(id,enabled){
    const provider=providers.get(id);
    if(!provider)throw new Error(`未知 provider：${id}`);
    if(typeof provider.setEnabled==='function')provider.setEnabled(enabled===true);
    else provider.enabled=enabled===true;
  }

  function listCapabilities({includeDisabled=false}={}){
    const items=[];
    for(const provider of providers.values()){
      const caps=provider.listCapabilities();
      for(const cap of caps){
        if(includeDisabled||cap.status==='enabled')items.push(cap);
      }
    }
    return items;
  }

  function listTools({capabilityId,includeDisabled=false}={}){
    const tools=[];
    for(const cap of listCapabilities({includeDisabled})){
      if(capabilityId&&cap.id!==capabilityId)continue;
      if(!includeDisabled&&cap.status!=='enabled')continue;
      const provider=providers.get(cap.providerId);
      if(!provider)continue;
      tools.push(...provider.listTools(cap.id));
    }
    return tools;
  }

  return Object.freeze({
    registerProvider,
    unregisterProvider,
    getProvider,
    setProviderEnabled,
    listCapabilities,
    listTools
  });
}
