import fsp from 'node:fs/promises';
import path from 'node:path';

function clone(value){
  return JSON.parse(JSON.stringify(value));
}

export function createSessionStore({file}={}){
  if(!file)throw new Error('createSessionStore requires file');
  const records=new Map();

  async function load(){
    try{
      const raw=JSON.parse(await fsp.readFile(file,'utf8'));
      const items=Array.isArray(raw)?raw:Array.isArray(raw?.sessions)?raw.sessions:[];
      records.clear();
      for(const item of items){
        if(item&&typeof item.id==='string'&&item.id)records.set(item.id,clone(item));
      }
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
    }
    return list();
  }

  async function save(){
    await fsp.mkdir(path.dirname(file),{recursive:true});
    const items=list();
    await fsp.writeFile(file,JSON.stringify({sessions:items},null,2));
    return items;
  }

  async function create(record){
    if(!record?.id)throw new Error('session id 必填');
    records.set(record.id,clone(record));
    await save();
    return clone(record);
  }

  function get(id){
    const record=records.get(id);
    return record?clone(record):null;
  }

  function list(){
    return [...records.values()].map(clone);
  }

  async function update(id,patch={}){
    const current=records.get(id);
    if(!current)throw Object.assign(new Error(`未知 session：${id}`),{code:'HARNESS_SESSION_NOT_FOUND'});
    const next={...current,...patch,id:current.id};
    records.set(id,clone(next));
    await save();
    return clone(next);
  }

  return Object.freeze({load,save,create,get,list,update});
}
