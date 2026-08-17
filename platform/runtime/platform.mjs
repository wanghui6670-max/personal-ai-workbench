import { createCapabilityRegistry } from '../registry/capability-registry.mjs';
import { createApprovalEngine } from './approval-engine.mjs';
import { createToolBroker } from './tool-broker.mjs';
import { createSessionManager } from './session-manager.mjs';
import { createScheduler } from './scheduler.mjs';
import { createAgentRegistry } from './agent-registry.mjs';

function createNamedRegistry(kind){
  const values=new Map();
  return Object.freeze({
    register(value){
      if(!value||typeof value.id!=='string'||!value.id.trim())throw new Error(`${kind} id is required`);
      if(values.has(value.id))throw new Error(`${kind} already registered: ${value.id}`);
      const stored=Object.freeze({...value});
      values.set(stored.id,stored);
      return stored;
    },
    has(id){return values.has(id);},
    get(id){return values.get(id)||null;},
    list(){return [...values.values()];},
    remove(id){return values.delete(id);}
  });
}

export function createHarnessPlatform({dispatch=async job=>job}={}){
  const approval=createApprovalEngine();
  const capabilities=createCapabilityRegistry();
  const tools=createToolBroker({approvalEngine:approval});
  const sessions=createSessionManager();
  const scheduler=createScheduler({dispatch});
  const agents=createAgentRegistry();
  const plugins=createNamedRegistry('plugin');
  const apps=createNamedRegistry('app');

  function runtimeForAgent(agentId){
    const agent=agents.get(agentId);
    if(!agent)throw new Error(`agent not found: ${agentId}`);
    const allowed=new Set();
    for(const capabilityId of agent.capabilities){
      const capability=capabilities.get(capabilityId);
      if(!capability)throw new Error(`agent capability not installed: ${capabilityId}`);
      for(const tool of capability.tools||[])allowed.add(tool.name);
    }
    return Object.freeze({
      agent,
      tools:tools.list().filter(tool=>allowed.has(tool.name)),
      async call(name,args={},approvalContext={}){
        if(!allowed.has(name))throw new Error(`tool not available to agent ${agentId}: ${name}`);
        return tools.call(name,args,approvalContext);
      }
    });
  }

  function mountApp(app){
    if(!app||typeof app.id!=='string'||!app.id.trim())throw new Error('app id is required');
    for(const id of app.capabilities||[])if(!capabilities.has(id))throw new Error(`missing capability for app ${app.id}: ${id}`);
    for(const id of app.plugins||[])if(!plugins.has(id))throw new Error(`missing plugin for app ${app.id}: ${id}`);
    return apps.register({
      ...app,
      capabilities:Object.freeze([...(app.capabilities||[])]),
      plugins:Object.freeze([...(app.plugins||[])]),
      agents:Object.freeze([...(app.agents||[])]),
      views:Object.freeze([...(app.views||[])])
    });
  }

  return Object.freeze({
    approval,
    capabilities,
    tools,
    sessions,
    scheduler,
    agents,
    plugins,
    apps,
    runtimeForAgent,
    mountApp
  });
}
