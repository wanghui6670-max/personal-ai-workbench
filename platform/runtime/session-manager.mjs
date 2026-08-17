function clone(value){return structuredClone(value);}

function createMemorySessionStore(){
  const sessions=new Map();
  return Object.freeze({
    async get(id){return sessions.has(id)?clone(sessions.get(id)):null;},
    async list(){return [...sessions.values()].map(clone);},
    async create(session){
      if(sessions.has(session.id))throw new Error(`session already exists: ${session.id}`);
      sessions.set(session.id,clone(session));
      return clone(session);
    },
    async update(id,mutate){
      const current=sessions.get(id);
      if(!current)throw new Error(`session not found: ${id}`);
      const next=await mutate(clone(current));
      sessions.set(id,clone(next));
      return clone(next);
    }
  });
}

function assertStore(store){
  for(const name of ['get','list','create','update'])if(typeof store?.[name]!=='function')throw new Error(`session store requires ${name}()`);
  return store;
}

export function createSessionManager({store=createMemorySessionStore()}={}){
  const persistence=assertStore(store);
  return Object.freeze({
    async create({id,scope,goal,contextRefs=[]}){
      if(typeof id!=='string'||!id.trim())throw new Error('session id is required');
      const now=new Date().toISOString();
      const session={id,scope:String(scope||'general'),goal:String(goal||''),contextRefs:[...contextRefs],events:[],checkpoints:[],createdAt:now,updatedAt:now};
      return persistence.create(session);
    },
    async appendEvent(id,event){
      if(!event||typeof event.type!=='string')throw new Error('event type is required');
      return persistence.update(id,session=>{
        session.events=Array.isArray(session.events)?session.events:[];
        session.events.push({...clone(event),at:new Date().toISOString()});
        session.updatedAt=new Date().toISOString();
        return session;
      });
    },
    async checkpoint(id,checkpoint){
      return persistence.update(id,session=>{
        session.checkpoints=Array.isArray(session.checkpoints)?session.checkpoints:[];
        session.checkpoints.push({...clone(checkpoint),at:new Date().toISOString()});
        session.updatedAt=new Date().toISOString();
        return session;
      });
    },
    async resume(id){
      const session=await persistence.get(id);
      if(!session)throw new Error(`session not found: ${id}`);
      return clone(session);
    },
    async list(){return persistence.list();}
  });
}
