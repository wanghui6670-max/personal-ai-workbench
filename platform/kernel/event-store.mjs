function clone(value){return structuredClone(value);}
function signature(event){return JSON.stringify({type:event.type,stream:event.stream,data:event.data??null,meta:event.meta??null});}

export function createEventStore(){
  const byId=new Map();
  const streams=new Map();
  return Object.freeze({
    async append(event){
      if(!event||typeof event.id!=='string'||!event.id.trim())throw new Error('event id is required');
      if(typeof event.type!=='string'||!event.type.trim())throw new Error('event type is required');
      if(typeof event.stream!=='string'||!event.stream.trim())throw new Error('event stream is required');
      const existing=byId.get(event.id);
      if(existing){
        if(existing.signature!==signature(event))throw new Error(`event id conflict: ${event.id}`);
        return {...clone(existing.event),replayed:true};
      }
      const stored=Object.freeze({...clone(event),at:event.at||new Date().toISOString()});
      byId.set(stored.id,{signature:signature(event),event:stored});
      const list=streams.get(stored.stream)||[];
      list.push(stored);
      streams.set(stored.stream,list);
      return clone(stored);
    },
    async readStream(stream){return (streams.get(stream)||[]).map(clone);},
    async get(id){return byId.has(id)?clone(byId.get(id).event):null;},
    async list(){return [...byId.values()].map(item=>clone(item.event));}
  });
}
