const HIDDEN_KEY=/reasoning|thought|chain[_-]?of[_-]?thought/i;

function sanitize(value,depth=0){
  if(depth>8)return '[truncated]';
  if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string')return value;
  if(Array.isArray(value))return value.slice(0,100).map(item=>sanitize(item,depth+1));
  if(value&&typeof value==='object'){
    const out={};
    for(const [key,item] of Object.entries(value)){
      if(HIDDEN_KEY.test(key))continue;
      out[key]=sanitize(item,depth+1);
    }
    return out;
  }
  return String(value);
}

export function createTraceStore(){
  const runs=new Map();
  return Object.freeze({
    async append(runId,event){
      if(typeof runId!=='string'||!runId.trim())throw new Error('runId is required');
      if(!event||typeof event.type!=='string'||!event.type.trim())throw new Error('trace event type is required');
      const stored=Object.freeze({...sanitize(event),at:event.at||new Date().toISOString()});
      const list=runs.get(runId)||[];
      list.push(stored);
      runs.set(runId,list);
      return structuredClone(stored);
    },
    async read(runId){return (runs.get(runId)||[]).map(item=>structuredClone(item));},
    async clear(runId){return runs.delete(runId);}
  });
}
