import { assertPluginManifest, assertCapabilityManifest } from '../contracts/manifests.mjs';

const SUPPORTED_RISKS=new Set(['read','local-write','external-write','destructive']);

function preflightTool(tool,platform){
  if(!tool||typeof tool.name!=='string'||!tool.name.trim())throw new Error('tool name is required');
  if(platform.tools.get(tool.name))throw new Error(`tool already registered: ${tool.name}`);
  if(!SUPPORTED_RISKS.has(tool.risk))throw new Error(`unsupported risk: ${tool.risk}`);
  if(typeof tool.execute!=='function')throw new Error(`tool ${tool.name} requires execute()`);
}

export function createPluginLoader({platform}={}){
  if(!platform)throw new Error('platform is required');
  return Object.freeze({
    async install(plugin){
      if(!plugin||typeof plugin!=='object')throw new Error('plugin is required');
      const manifest=assertPluginManifest(plugin.manifest);
      if(platform.plugins.has(manifest.id))throw new Error(`plugin already registered: ${manifest.id}`);
      const capabilities=(plugin.capabilities||[]).map(assertCapabilityManifest);
      for(const capability of capabilities){
        if(platform.capabilities.has(capability.id))throw new Error(`capability already registered: ${capability.id}`);
        for(const tool of capability.tools||[])preflightTool(tool,platform);
      }
      const seenTools=new Set();
      for(const capability of capabilities){
        for(const tool of capability.tools||[]){
          if(seenTools.has(tool.name))throw new Error(`tool already registered: ${tool.name}`);
          seenTools.add(tool.name);
        }
      }
      for(const capability of capabilities){
        platform.capabilities.register(capability);
        for(const tool of capability.tools||[])platform.tools.register(tool);
      }
      platform.plugins.register({
        id:manifest.id,
        version:manifest.version,
        adapter:manifest.adapter,
        capabilities:Object.freeze(capabilities.map(item=>item.id))
      });
      return platform.plugins.get(manifest.id);
    }
  });
}
