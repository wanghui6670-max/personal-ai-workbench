import fs from 'node:fs/promises';
import path from 'node:path';

export class InMemoryEventStore{
  #events=[];
  async append(event){
    const normalized=Object.freeze({...event,at:event.at??new Date().toISOString()});
    this.#events.push(normalized);
    return normalized;
  }
  async list({sessionId=null,type=null}={}){
    return this.#events.filter(event=>(!sessionId||event.sessionId===sessionId)&&(!type||event.type===type));
  }
}

export class JsonlEventStore{
  constructor(file){this.file=path.resolve(file);}
  async append(event){
    const normalized={...event,at:event.at??new Date().toISOString()};
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    await fs.appendFile(this.file,`${JSON.stringify(normalized)}\n`,'utf8');
    return normalized;
  }
  async list({sessionId=null,type=null}={}){
    let raw='';
    try{raw=await fs.readFile(this.file,'utf8');}catch(error){if(error.code==='ENOENT')return [];throw error;}
    return raw.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(event=>(!sessionId||event.sessionId===sessionId)&&(!type||event.type===type));
  }
}
