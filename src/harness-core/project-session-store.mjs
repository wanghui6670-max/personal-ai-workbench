import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const DIRECTORY_MODE=0o700;
const FILE_MODE=0o600;
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SESSION_FIELDS=new Set([
  'version','id','type','projectId','status','authorityRefs','cursor','executionRefs','createdAt','updatedAt'
]);
const AUTHORITY_FIELDS=new Set(['authority','kind','refId']);
const BASE_CURSOR_FIELDS=Object.freeze([
  'lastActivity','syncedAt','feishuRevisionId','feishuRecordBlockId','feishuRecordedAt','feishuOperationId'
]);
const HYDRATION_CURSOR_FIELDS=Object.freeze(['workspaceLastActivity','gitHead']);
const CURSOR_FIELDS=new Set([...BASE_CURSOR_FIELDS,...HYDRATION_CURSOR_FIELDS]);
const AUTHORITIES=new Set(['workbench','local_workspace','git','feishu_project_record']);
const TIME_CURSOR_FIELDS=new Set(['lastActivity','syncedAt','feishuRecordedAt','workspaceLastActivity']);

function sessionError(message,code='PROJECT_SESSION_INVALID'){
  return Object.assign(new Error(message),{code});
}

function rejectExtraFields(value,allowed,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw sessionError(`${label} 必须是对象。`);
  const extra=Object.keys(value).find(key=>!allowed.has(key));
  if(extra)throw sessionError(`${label} 包含不允许持久化的字段：${extra}`,'PROJECT_SESSION_UNSAFE_FIELD');
}

function stableId(value,label){
  const text=String(value??'').trim();
  if(!SAFE_ID.test(text))throw sessionError(`${label} 格式无效。`);
  return text;
}

function timestamp(value,label){
  const text=String(value??'').trim();
  if(!text||!Number.isFinite(Date.parse(text)))throw sessionError(`${label} 必须是有效时间。`);
  return text;
}

function optionalCursorValue(value,label,{time=false}={}){
  if(value===undefined||value===null||value==='')return null;
  if(time)return timestamp(value,label);
  const text=String(value).trim();
  if(!text||text.length>256||/[\r\n\0]/.test(text))throw sessionError(`${label} 格式无效。`);
  return text;
}

function normalizeAuthorityRefs(value,projectId){
  if(!Array.isArray(value))throw sessionError('authorityRefs 必须是数组。');
  if(value.length>8)throw sessionError('authorityRefs 数量超出限制。');
  const seen=new Set();
  return Object.freeze(value.map(item=>{
    rejectExtraFields(item,AUTHORITY_FIELDS,'Authority ref');
    const authority=String(item.authority??'').trim();
    if(!AUTHORITIES.has(authority))throw sessionError(`不支持的 Authority：${authority}`);
    if(item.kind!=='project')throw sessionError('Project Session Authority kind 必须为 project。');
    const refId=stableId(item.refId,'Authority refId');
    if(refId!==projectId)throw sessionError('Project Session Authority 必须引用当前 projectId。');
    const key=`${authority}:project:${refId}`;
    if(seen.has(key))throw sessionError(`重复 Authority ref：${key}`);
    seen.add(key);
    return Object.freeze({authority,kind:'project',refId});
  }));
}

function normalizeCursor(value){
  const input=value??{};
  rejectExtraFields(input,CURSOR_FIELDS,'Project Session cursor');
  const output={};
  for(const field of BASE_CURSOR_FIELDS){
    output[field]=optionalCursorValue(input[field],`cursor.${field}`,{time:TIME_CURSOR_FIELDS.has(field)});
  }
  for(const field of HYDRATION_CURSOR_FIELDS){
    if(Object.hasOwn(input,field)){
      output[field]=optionalCursorValue(input[field],`cursor.${field}`,{time:TIME_CURSOR_FIELDS.has(field)});
    }
  }
  return Object.freeze(output);
}

function normalizeExecutionRefs(value){
  if(!Array.isArray(value))throw sessionError('executionRefs 必须是数组。');
  if(value.length>128)throw sessionError('executionRefs 数量超出限制。');
  const output=[];
  const seen=new Set();
  for(const item of value){
    const id=stableId(item,'executionRef');
    if(seen.has(id))continue;
    seen.add(id);output.push(id);
  }
  return Object.freeze(output);
}

function normalizeSession(value){
  rejectExtraFields(value,SESSION_FIELDS,'Project Session');
  if(value.version!==1)throw sessionError('Project Session version 必须为 1。');
  if(value.type!=='project')throw sessionError('Project Session type 必须为 project。');
  if(value.status!=='open')throw sessionError('Project Session status 必须为 open。');
  const projectId=stableId(value.projectId,'projectId');
  const id=stableId(value.id,'session id');
  if(id!==`project:${projectId}`)throw sessionError('Project Session id 必须稳定映射 projectId。');
  return Object.freeze({
    version:1,
    id,
    type:'project',
    projectId,
    status:'open',
    authorityRefs:normalizeAuthorityRefs(value.authorityRefs,projectId),
    cursor:normalizeCursor(value.cursor),
    executionRefs:normalizeExecutionRefs(value.executionRefs),
    createdAt:timestamp(value.createdAt,'createdAt'),
    updatedAt:timestamp(value.updatedAt,'updatedAt')
  });
}

export class ProjectSessionStore{
  #queue=Promise.resolve();

  constructor({dataDir}={}){
    if(typeof dataDir!=='string'||!dataDir.trim())throw new TypeError('ProjectSessionStore requires dataDir');
    this.dataDir=path.resolve(dataDir);
    this.harnessDir=path.join(this.dataDir,'harness');
    this.sessionsDir=path.join(this.harnessDir,'sessions');
  }

  async #safeDirectory(target,label,{create=false}={}){
    let stat;
    try{stat=await fsp.lstat(target);}catch(error){
      if(error.code!=='ENOENT'||!create)throw error;
      await fsp.mkdir(target,{mode:DIRECTORY_MODE});
      stat=await fsp.lstat(target);
    }
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`Project Session 目录不是安全目录：${label}。`);
    await fsp.chmod(target,DIRECTORY_MODE);
  }

  async ensure(){
    await this.#safeDirectory(this.dataDir,'data');
    await this.#safeDirectory(this.harnessDir,'harness',{create:true});
    await this.#safeDirectory(this.sessionsDir,'sessions',{create:true});
  }

  #filename(id){return path.join(this.sessionsDir,`session-${encodeURIComponent(stableId(id,'session id'))}.json`);}

  async #readRaw(id){
    await this.ensure();
    const target=this.#filename(id);
    let stat;
    try{stat=await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw new Error('Project Session 文件不是安全普通文件。');
    return JSON.parse(await fsp.readFile(target,'utf8'));
  }

  async #atomicWrite(record){
    await this.ensure();
    const target=this.#filename(record.id);
    let existing;
    try{existing=await fsp.lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing&&(existing.isSymbolicLink()||!existing.isFile()||existing.nlink>1))throw new Error('Project Session 文件不是安全普通文件。');
    const temp=path.join(this.sessionsDir,`.session-${randomUUID()}.tmp`);
    try{
      await fsp.writeFile(temp,JSON.stringify(record,null,2),{encoding:'utf8',flag:'wx',mode:FILE_MODE});
      await fsp.chmod(temp,FILE_MODE);
      await fsp.rename(temp,target);
      await fsp.chmod(target,FILE_MODE);
    }finally{
      await fsp.unlink(temp).catch(()=>{});
    }
  }

  #serialize(operation){
    const run=this.#queue.then(operation,operation);
    this.#queue=run.then(()=>undefined,()=>undefined);
    return run;
  }

  async read(id){
    const raw=await this.#readRaw(id);
    return raw?normalizeSession(raw):null;
  }

  async write(value){
    const record=normalizeSession(value);
    return this.#serialize(async()=>{
      await this.#atomicWrite(record);
      return record;
    });
  }

  async update(id,updater){
    if(typeof updater!=='function')throw new TypeError('ProjectSessionStore.update requires updater');
    const sessionId=stableId(id,'session id');
    return this.#serialize(async()=>{
      const raw=await this.#readRaw(sessionId);
      if(!raw)throw sessionError('Project Session 不存在。','PROJECT_SESSION_NOT_FOUND');
      const current=normalizeSession(raw);
      const next=normalizeSession(await updater(structuredClone(current)));
      if(next.id!==sessionId)throw sessionError('Project Session update 不得改变 session id。');
      await this.#atomicWrite(next);
      return next;
    });
  }

  async upsert(id,updater){
    if(typeof updater!=='function')throw new TypeError('ProjectSessionStore.upsert requires updater');
    const sessionId=stableId(id,'session id');
    return this.#serialize(async()=>{
      const raw=await this.#readRaw(sessionId);
      const current=raw?normalizeSession(raw):null;
      const next=normalizeSession(await updater(current?structuredClone(current):null));
      if(next.id!==sessionId)throw sessionError('Project Session upsert 不得改变 session id。');
      await this.#atomicWrite(next);
      return next;
    });
  }
}
