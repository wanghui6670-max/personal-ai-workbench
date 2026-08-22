import { assertCapabilityManifest } from '../contracts/manifests.mjs';

function cloneCapability(value){
  return Object.freeze({
    ...value,
    tools:Object.freeze([...(value.tools||[])])
  });
}

export function createCapabilityRegistry(){
  const capabilities=new Map();
  return Object.freeze({
    register(manifest){
      const checked=assertCapabilityManifest(manifest);
      if(capabilities.has(checked.id))throw new Error(`capability already registered: ${checked.id}`);
      const value=cloneCapability(checked);
      capabilities.set(value.id,value);
      return value;
    },
    has(id){return capabilities.has(id);},
    get(id){return capabilities.get(id)||null;},
    list(){return [...capabilities.values()];},
    remove(id){return capabilities.delete(id);},
    clear(){capabilities.clear();}
  });
}
