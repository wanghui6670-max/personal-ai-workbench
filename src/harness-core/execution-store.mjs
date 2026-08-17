import fsp from 'node:fs/promises';
import path from 'node:path';

function clone(value){
  return JSON.parse(JSON.stringify(value));
}

export function createExecutionStore({file}={}){
  if(!file)throw new Error('createExecutionStore requires file');
  const records=new Map();

  async function load(){
    try{
      const raw=JSON.parse(await fsp.readFile(file,'utf8'));
      const items=Array.isArray(raw)?raw:Array.isArray(raw?.executions)?raw.executions:[];
      records.clear();
      for(const item of items){
        if(item&&typeof item.executionId==='string'&&item.executionId)records.set(item.executionId,clone(item));
      }
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
    }
    return list();
  }

  async function flush(){
    await fsp.mkdir(path.dirname(file),{recursive:true});
    const items=await list();
    await fsp.writeFile(file,JSON.stringify({executions:items},null,2));
    return items;
  }

  async function append(record){
    if(!record?.executionId)throw new Error('executionId 必填');
    records.set(record.executionId,clone(record));
    await flush();
    return clone(record);
  }

  async function list({sessionRef,limit}={}){
    let items=[...records.values()].map(clone);
    if(sessionRef)items=items.filter(item=>item.sessionRef===sessionRef);
    items.sort((a,b)=>String(a.startedAt||'').localeCompare(String(b.startedAt||'')));
    if(Number.isInteger(limit)&&limit>=0)items=items.slice(-limit);
    return items;
  }

  function get(executionId){
    const record=records.get(executionId);
    return record?clone(record):null;
  }

  return Object.freeze({load,append,list,get});
}
