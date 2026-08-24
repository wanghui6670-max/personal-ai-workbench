import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function safeId(value){return String(value).replace(/[^A-Za-z0-9._:-]/g,'_').slice(0,180);}

export class SessionStore{
  constructor({root}){if(!root)throw new TypeError('SessionStore root is required');this.root=path.resolve(root);}
  fileFor(id){return path.join(this.root,`${safeId(id)}.json`);}
  async create({id=crypto.randomUUID(),scope='general',goal='',metadata={}}={}){
    const session={id:String(id),scope:String(scope),goal:String(goal),status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),contextRefs:[],events:[],decisions:[],artifacts:[],approvals:[],checkpoints:[],memory:null,metadata:{...metadata}};
    await this.save(session,{failIfExists:true});
    return session;
  }
  async load(id){
    try{return JSON.parse(await fs.readFile(this.fileFor(id),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async save(session,{failIfExists=false}={}){
    await fs.mkdir(this.root,{recursive:true});
    const file=this.fileFor(session.id);
    if(failIfExists){
      try{await fs.access(file);throw new Error(`session already exists: ${session.id}`);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const next={...session,updatedAt:new Date().toISOString()};
    const temp=`${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp,JSON.stringify(next,null,2),'utf8');
    await fs.rename(temp,file);
    return next;
  }
  async mutate(id,mutator){
    const current=await this.load(id);if(!current)throw new Error(`session not found: ${id}`);
    const next=await mutator(structuredClone(current));
    return this.save(next??current);
  }
  async appendEvent(id,event){return this.mutate(id,session=>{session.events.push({...event,at:event.at??new Date().toISOString()});return session;});}
  async addDecision(id,decision){return this.mutate(id,session=>{session.decisions.push({...decision,at:decision.at??new Date().toISOString()});return session;});}
  async checkpoint(id,{summary,state={},memory=null}={}){return this.mutate(id,session=>{session.checkpoints.push({summary:String(summary??''),state,at:new Date().toISOString()});if(memory!==null)session.memory=memory;return session;});}
}
