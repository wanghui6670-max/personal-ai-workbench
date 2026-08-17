import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const DIRECTORY_MODE=0o700;
const FILE_MODE=0o600;
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_CODE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const START_FIELDS=new Set(['version','id','trigger','actor','sessionId','toolName','capabilityId','providerId','argumentKeys','startedAt']);
const FINISH_FIELDS=new Set(['version','id','status','completedAt','errorCode']);

function receiptError(message,code='EXECUTION_RECEIPT_INVALID'){
  return Object.assign(new Error(message),{code});
}

function stableId(value,label){
  const text=String(value??'').trim();
  if(!SAFE_ID.test(text))throw receiptError(`${label} 格式无效。`);
  return text;
}

function timestamp(value,label){
  const text=String(value??'').trim();
  if(!text||!Number.isFinite(Date.parse(text)))throw receiptError(`${label} 必须是有效时间。`);
  return text;
}

function rejectExtraFields(value,allowed){
  if(!value||typeof value!=='object'||Array.isArray(value))throw receiptError('Execution receipt 必须是对象。');
  const extra=Object.keys(value).find(key=>!allowed.has(key));
  if(extra)throw receiptError(`Execution receipt 包含不允许持久化的字段：${extra}`,'EXECUTION_RECEIPT_UNSAFE_FIELD');
}

function normalizeArgumentKeys(value){
  if(!Array.isArray(value))throw receiptError('argumentKeys 必须是数组。');
  if(value.length>64)throw receiptError('argumentKeys 数量超出限制。');
  return value.map(key=>{
    const text=String(key??'').trim();
    if(!text||text.length>128||/[\r\n\0]/.test(text))throw receiptError('argumentKeys 包含无效字段名。');
    return text;
  });
}

function normalizeStart(value){
  rejectExtraFields(value,START_FIELDS);
  if(value.version!==1)throw receiptError('Execution start receipt version 必须为 1。');
  return Object.freeze({
    version:1,
    id:stableId(value.id,'execution id'),
    trigger:stableId(value.trigger,'trigger'),
    actor:stableId(value.actor,'actor'),
    sessionId:value.sessionId===null||value.sessionId===undefined?null:stableId(value.sessionId,'sessionId'),
    toolName:stableId(value.toolName,'toolName'),
    capabilityId:stableId(value.capabilityId,'capabilityId'),
    providerId:stableId(value.providerId,'providerId'),
    argumentKeys:Object.freeze(normalizeArgumentKeys(value.argumentKeys)),
    startedAt:timestamp(value.startedAt,'startedAt')
  });
}

function normalizeFinish(value){
  rejectExtraFields(value,FINISH_FIELDS);
  if(value.version!==1)throw receiptError('Execution finish receipt version 必须为 1。');
  if(!['succeeded','failed'].includes(value.status))throw receiptError('Execution finish status 无效。');
  const errorCode=value.errorCode===null||value.errorCode===undefined?null:String(value.errorCode).trim();
  if(errorCode!==null&&!SAFE_CODE.test(errorCode))throw receiptError('errorCode 格式无效。');
  if(value.status==='succeeded'&&errorCode!==null)throw receiptError('成功 Execution 不应保存 errorCode。');
  return Object.freeze({
    version:1,
    id:stableId(value.id,'execution id'),
    status:value.status,
    completedAt:timestamp(value.completedAt,'completedAt'),
    errorCode
  });
}

export class ExecutionReceiptStore{
  constructor({dataDir}={}){
    if(typeof dataDir!=='string'||!dataDir.trim())throw new TypeError('ExecutionReceiptStore requires dataDir');
    this.dataDir=path.resolve(dataDir);
    this.harnessDir=path.join(this.dataDir,'harness');
    this.executionsDir=path.join(this.harnessDir,'executions');
  }

  async #ensureDirectory(target,label){
    let stat;
    try{stat=await fsp.lstat(target);}catch(error){
      if(error.code!=='ENOENT')throw error;
      await fsp.mkdir(target,{mode:DIRECTORY_MODE});
      stat=await fsp.lstat(target);
    }
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`Harness execution receipt 目录不是安全目录：${label}。`);
    await fsp.chmod(target,DIRECTORY_MODE);
  }

  async ensure(){
    const root=await fsp.lstat(this.dataDir);
    if(root.isSymbolicLink()||!root.isDirectory())throw new Error('Harness execution receipt 数据根目录不是安全目录。');
    await this.#ensureDirectory(this.harnessDir,'harness');
    await this.#ensureDirectory(this.executionsDir,'executions');
  }

  #file(id,phase){return path.join(this.executionsDir,`execution-${stableId(id,'execution id')}-${phase}.json`);}

  async #readFile(target){
    let stat;
    try{stat=await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw new Error('Harness execution receipt 不是安全普通文件。');
    return JSON.parse(await fsp.readFile(target,'utf8'));
  }

  async #writeImmutable(target,receipt,id,phase){
    await this.ensure();
    const temp=path.join(this.executionsDir,`.execution-${id}-${phase}-${randomUUID()}.tmp`);
    try{
      await fsp.writeFile(temp,JSON.stringify(receipt,null,2),{encoding:'utf8',flag:'wx',mode:FILE_MODE});
      await fsp.chmod(temp,FILE_MODE);
      try{await fsp.link(temp,target);}catch(error){
        if(error.code!=='EEXIST')throw error;
        throw receiptError(`Execution ${phase} receipt 已存在。`,'EXECUTION_RECEIPT_EXISTS');
      }
    }finally{
      await fsp.unlink(temp).catch(()=>{});
    }
  }

  async writeStart(value){
    const receipt=normalizeStart(value);
    await this.#writeImmutable(this.#file(receipt.id,'start'),receipt,receipt.id,'start');
    return receipt;
  }

  async writeFinish(value){
    const receipt=normalizeFinish(value);
    await this.ensure();
    const startRaw=await this.#readFile(this.#file(receipt.id,'start'));
    if(!startRaw)throw receiptError('Execution start receipt 不存在。','EXECUTION_START_MISSING');
    const start=normalizeStart(startRaw);
    if(start.id!==receipt.id)throw receiptError('Execution start/finish ID 不一致。');
    await this.#writeImmutable(this.#file(receipt.id,'finish'),receipt,receipt.id,'finish');
    return receipt;
  }

  async read(id){
    await this.ensure();
    const executionId=stableId(id,'execution id');
    const startRaw=await this.#readFile(this.#file(executionId,'start'));
    if(!startRaw)return null;
    const start=normalizeStart(startRaw);
    const finishRaw=await this.#readFile(this.#file(executionId,'finish'));
    if(!finishRaw)return Object.freeze({...start,status:'incomplete',completedAt:null,errorCode:null});
    const finish=normalizeFinish(finishRaw);
    if(finish.id!==start.id)throw receiptError('Execution start/finish ID 不一致。');
    return Object.freeze({...start,status:finish.status,completedAt:finish.completedAt,errorCode:finish.errorCode});
  }
}
