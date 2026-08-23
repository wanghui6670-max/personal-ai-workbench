import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from '../atomic-write.mjs';

const PRIVATE_DIRECTORY_MODE=0o700;
const PRIVATE_FILE_MODE=0o600;

function sessionItemsFrom(payload){
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.sessions))return payload.sessions;
  return null;
}

export function createSessionStore({file,now=()=>new Date()}={}){
  if(!file)throw new Error('createSessionStore requires file');
  const records=new Map();
  let queue=Promise.resolve();

  function enqueue(operation){
    const run=queue.then(operation,operation);
    queue=run.then(()=>undefined,()=>undefined);
    return run;
  }

  async function ensureDirectory(){
    const directory=path.dirname(file);
    await fsp.mkdir(directory,{recursive:true,mode:PRIVATE_DIRECTORY_MODE});
    await fsp.chmod(directory,PRIVATE_DIRECTORY_MODE);
  }

  async function atomicWrite(items){
    await ensureDirectory();
    await atomicWriteJson(file, {sessions:items}, { mode: PRIVATE_FILE_MODE, ensureDir: false });
  }

  function itemsFrom(source){
    return [...source.values()].map(item=>structuredClone(item));
  }

  function replaceRecords(items){
    records.clear();
    for(const item of items)records.set(item.id,structuredClone(item));
  }

  async function persistRecords(source){
    const items=itemsFrom(source);
    await atomicWrite(items);
    replaceRecords(items);
  }

  async function recoverCorruptFile(){
    await ensureDirectory();
    const stamp=now().toISOString().replace(/[:.]/g,'-');
    const backup=`${file}.corrupt-${stamp}-${randomUUID()}.json`;
    await fsp.copyFile(file,backup);
    await fsp.chmod(backup,PRIVATE_FILE_MODE);
    await atomicWrite([]);
    records.clear();
    return [];
  }

  async function load(){
    return enqueue(async()=>{
      let text;
      try{
        text=await fsp.readFile(file,'utf8');
      }catch(error){
        if(error?.code==='ENOENT'){
          records.clear();
          return [];
        }
        throw error;
      }
      let raw;
      try{
        raw=JSON.parse(text);
      }catch(error){
        if(error instanceof SyntaxError)return recoverCorruptFile();
        throw error;
      }
      const source=sessionItemsFrom(raw);
      if(source===null)return recoverCorruptFile();
      const items=source
        .filter(item=>item&&typeof item.id==='string'&&item.id)
        .map(item=>structuredClone(item));
      replaceRecords(items);
      return items.map(item=>structuredClone(item));
    });
  }

  async function save(){
    return enqueue(async()=>{
      const items=itemsFrom(records);
      await atomicWrite(items);
      return items;
    });
  }

  async function create(record){
    if(!record?.id)throw new Error('session id 必填');
    return enqueue(async()=>{
      const nextRecords=new Map(records);
      nextRecords.set(record.id,structuredClone(record));
      await persistRecords(nextRecords);
      return structuredClone(record);
    });
  }

  function get(id){
    const record=records.get(id);
    return record?structuredClone(record):null;
  }

  function list(){
    return itemsFrom(records);
  }

    async function update(id,patch={}){
    return enqueue(async()=>{
      const current=records.get(id);
      if(!current)throw Object.assign(new Error(`未知 session：${id}`),{code:'HARNESS_SESSION_NOT_FOUND'});
      const record={...current,...patch,id:current.id};
      const nextRecords=new Map(records);
      nextRecords.set(id,structuredClone(record));
      await persistRecords(nextRecords);
      return structuredClone(record);
    });
  }

  return Object.freeze({load,save,create,get,list,update});
}
