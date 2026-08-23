import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from '../atomic-write.mjs';

const PRIVATE_DIRECTORY_MODE=0o700;
const PRIVATE_FILE_MODE=0o600;
const DEFAULT_MAX_RECORDS=2_000;

function sortedRecords(source){
  return [...source.values()]
    .map(item=>structuredClone(item))
    .sort((a,b)=>String(a.startedAt||'').localeCompare(String(b.startedAt||'')));
}

function executionItemsFrom(payload){
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.executions))return payload.executions;
  return null;
}

export function createExecutionStore({file,maxRecords=DEFAULT_MAX_RECORDS,now=()=>new Date()}={}){
  if(!file)throw new Error('createExecutionStore requires file');
  const retention=Number.isInteger(maxRecords)&&maxRecords>0?maxRecords:DEFAULT_MAX_RECORDS;
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
    await atomicWriteJson(file, {executions:items}, { mode: PRIVATE_FILE_MODE, ensureDir: false });
  }

  function retainedItems(source){
    const items=sortedRecords(source);
    const running=items.filter(item=>item.status==='running');
    const terminal=items.filter(item=>item.status!=='running');
    const retainedTerminal=terminal.length>retention?terminal.slice(-retention):terminal;
    return [...running,...retainedTerminal]
      .sort((a,b)=>String(a.startedAt||'').localeCompare(String(b.startedAt||'')));
  }

  function replaceRecords(items){
    records.clear();
    for(const item of items)records.set(item.executionId,structuredClone(item));
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
      const source=executionItemsFrom(raw);
      if(source===null)return recoverCorruptFile();
      const loadedRecords=new Map();
      let changed=false;
      for(const item of source){
        if(!item||typeof item.executionId!=='string'||!item.executionId)continue;
        const record=structuredClone(item);
        if(record.status==='running'){
          record.status='interrupted';
          record.completedAt=now().toISOString();
          record.errorCode='HARNESS_EXECUTION_INTERRUPTED';
          record.resultSummary='interrupted during previous process';
          changed=true;
        }
        loadedRecords.set(record.executionId,record);
      }
      const items=retainedItems(loadedRecords);
      if(items.length!==loadedRecords.size)changed=true;
      replaceRecords(items);
      if(changed)await atomicWrite(items);
      return items.map(item=>structuredClone(item));
    });
  }

  async function append(record){
    if(!record?.executionId)throw new Error('executionId 必填');
    return enqueue(async()=>{
      const nextRecords=new Map(records);
      nextRecords.set(record.executionId,structuredClone(record));
      const items=retainedItems(nextRecords);
      await atomicWrite(items);
      replaceRecords(items);
      return structuredClone(record);
    });
  }

  async function list({sessionRef,limit}={}){
    let items=sortedRecords(records);
    if(sessionRef)items=items.filter(item=>item.sessionRef===sessionRef);
    if(limit===0)return [];
    if(Number.isInteger(limit)&&limit>0)items=items.slice(-limit);
    return items;
  }

  function get(executionId){
    const record=records.get(executionId);
    return record?structuredClone(record):null;
  }

  return Object.freeze({load,append,list,get});
}
