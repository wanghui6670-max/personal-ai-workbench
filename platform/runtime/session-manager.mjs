function clone(value){return structuredClone(value);}

export function createSessionManager(){
  const sessions=new Map();
  return Object.freeze({
    async create({id,scope,goal,contextRefs=[]}){
      if(typeof id!=='string'||!id.trim())throw new Error('session id is required');
      if(sessions.has(id))throw new Error(`session already exists: ${id}`);
      const session={id,scope:String(scope||'general'),goal:String(goal||''),contextRefs:[...contextRefs],events:[],checkpoints:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      sessions.set(id,session);
      return clone(session);
    },
    async appendEvent(id,event){
      const session=sessions.get(id);
      if(!session)throw new Error(`session not found: ${id}`);
      if(!event||typeof event.type!=='string')throw new Error('event type is required');
      session.events.push({...clone(event),at:new Date().toISOString()});
      session.updatedAt=new Date().toISOString();
      return clone(session);
    },
    async checkpoint(id,checkpoint){
      const session=sessions.get(id);
      if(!session)throw new Error(`session not found: ${id}`);
      session.checkpoints.push({...clone(checkpoint),at:new Date().toISOString()});
      session.updatedAt=new Date().toISOString();
      return clone(session);
    },
    async resume(id){
      const session=sessions.get(id);
      if(!session)throw new Error(`session not found: ${id}`);
      return clone(session);
    },
    async list(){return [...sessions.values()].map(clone);}
  });
}
