import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

function clone(value){return structuredClone(value);}

export function createJsonFileSessionStore({file}={}){
  if(typeof file!=='string'||!file.trim())throw new Error('session store file is required');
  const target=path.resolve(file);
  let queue=Promise.resolve();

  async function readAll(){
    try{
      const parsed=JSON.parse(await fsp.readFile(target,'utf8'));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('invalid session store');
      if(!parsed.sessions||typeof parsed.sessions!=='object'||Array.isArray(parsed.sessions))parsed.sessions={};
      return parsed;
    }catch(error){
      if(error?.code==='ENOENT')return {version:1,sessions:{}};
      throw error;
    }
  }

  async function atomicWrite(data){
    await fsp.mkdir(path.dirname(target),{recursive:true});
    const temp=`${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try{
      await fsp.writeFile(temp,`${JSON.stringify(data,null,2)}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
      await fsp.rename(temp,target);
    }catch(error){
      await fsp.rm(temp,{force:true}).catch(()=>{});
      throw error;
    }
  }

  function serialize(work){
    const next=queue.then(work,work);
    queue=next.then(()=>undefined,()=>undefined);
    return next;
  }

  return Object.freeze({
    async get(id){
      await queue;
      const data=await readAll();
      return data.sessions[id]?clone(data.sessions[id]):null;
    },
    async list(){
      await queue;
      const data=await readAll();
      return Object.values(data.sessions).map(clone);
    },
    async create(session){
      return serialize(async()=>{
        const data=await readAll();
        if(data.sessions[session.id])throw new Error(`session already exists: ${session.id}`);
        data.sessions[session.id]=clone(session);
        await atomicWrite(data);
        return clone(session);
      });
    },
    async update(id,mutate){
      if(typeof mutate!=='function')throw new Error('session mutation is required');
      return serialize(async()=>{
        const data=await readAll();
        const current=data.sessions[id];
        if(!current)throw new Error(`session not found: ${id}`);
        const next=await mutate(clone(current));
        if(!next||typeof next!=='object')throw new Error('session mutation must return session');
        data.sessions[id]=clone(next);
        await atomicWrite(data);
        return clone(next);
      });
    }
  });
}
