function normalizeCapabilities(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.trim()))throw new Error('capabilities must be non-empty strings');
  return [...new Set(value)];
}

export function createAgentRegistry(){
  const agents=new Map();
  return Object.freeze({
    register(agent){
      if(!agent||typeof agent.id!=='string'||!agent.id.trim())throw new Error('agent id is required');
      if(agents.has(agent.id))throw new Error(`agent already registered: ${agent.id}`);
      const value=Object.freeze({
        ...agent,
        instructions:String(agent.instructions||''),
        capabilities:Object.freeze(normalizeCapabilities(agent.capabilities))
      });
      agents.set(value.id,value);
      return value;
    },
    get(id){return agents.get(id)||null;},
    list(){return [...agents.values()];},
    remove(id){return agents.delete(id);}
  });
}
