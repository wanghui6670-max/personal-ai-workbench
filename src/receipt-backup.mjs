import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeCaptureId } from './capture-contract.mjs';
import { normalizeFeishuProjectDocumentUrl } from './project-record-contract.mjs';

const DIRECTORY_MODE=0o700;
const FILE_MODE=0o600;
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256=/^[a-f0-9]{64}$/;
const CAPTURE_FILE=/^capture-([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/;
const PROJECT_FILE=/^project-record-([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/;
const PROJECT_PHASES=new Set(['remote_pending','remote_outcome_unknown','remote_saved_local_pending','local_committed']);
const MACHINE_PROGRESS_FIELDS=new Set([
  'percent','status','hasBlocker','lastActivity','syncedAt','confidence',
  'feishuRevisionId','feishuRecordBlockId','feishuRecordedAt','feishuOperationId'
]);

function invalid(message){
  return Object.assign(new Error(`无效备份凭据：${message}`),{code:'INVALID_BACKUP_RECEIPTS'});
}

function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}

function safeId(value,field){
  const id=String(value??'').trim();
  if(!SAFE_ID.test(id))throw invalid(`${field} 必须是 1-128 位安全 ID`);
  return id;
}

function requiredString(value,field,{max=4096}={}){
  if(typeof value!=='string'||!value.trim()||value.length>max)throw invalid(`${field} 必须是非空字符串`);
  return value;
}

function optionalString(value,field,{max=4096}={}){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>max)throw invalid(`${field} 必须是字符串或 null`);
  return value;
}

function rejectUnknownFields(value,allowed,scope){
  for(const key of Object.keys(value))if(!allowed.has(key))throw invalid(`${scope}.${key} 不是允许字段`);
}

function normalizeMachineProgress(value){
  if(value===undefined||value===null)return null;
  if(!isRecord(value))throw invalid('projectRecordReceipts.machineProgress 必须是对象或 null');
  rejectUnknownFields(value,MACHINE_PROGRESS_FIELDS,'projectRecordReceipts.machineProgress');
  const next=structuredClone(value);
  if(Object.hasOwn(next,'percent')&&(!Number.isInteger(next.percent)||next.percent<0||next.percent>100))throw invalid('machineProgress.percent 必须是 0-100 的整数');
  if(Object.hasOwn(next,'confidence')&&(typeof next.confidence!=='number'||!Number.isFinite(next.confidence)||next.confidence<0||next.confidence>1))throw invalid('machineProgress.confidence 必须是 0-1 的有限数值');
  if(Object.hasOwn(next,'hasBlocker')&&typeof next.hasBlocker!=='boolean')throw invalid('machineProgress.hasBlocker 必须是布尔值');
  for(const field of ['status','lastActivity','syncedAt','feishuRevisionId','feishuRecordBlockId','feishuRecordedAt','feishuOperationId']){
    if(next[field]!==undefined&&next[field]!==null&&typeof next[field]!=='string')throw invalid(`machineProgress.${field} 必须是字符串或 null`);
  }
  return next;
}

export function normalizeCaptureReceipt(receipt){
  if(!isRecord(receipt))throw invalid('captureReceipts 元素必须是对象');
  const allowed=new Set(['version','captureId','contentHash','inboxId','feishuBlockId','createdAt']);
  rejectUnknownFields(receipt,allowed,'captureReceipts');
  if(receipt.version!==1)throw invalid('captureReceipts.version 目前只支持 1');
  const captureId=normalizeCaptureId(receipt.captureId);
  if(typeof receipt.contentHash!=='string'||!SHA256.test(receipt.contentHash))throw invalid('captureReceipts.contentHash 必须是 SHA-256');
  return {
    version:1,
    captureId,
    contentHash:receipt.contentHash,
    inboxId:optionalString(receipt.inboxId,'captureReceipts.inboxId',{max:256}),
    feishuBlockId:optionalString(receipt.feishuBlockId,'captureReceipts.feishuBlockId',{max:256}),
    createdAt:requiredString(receipt.createdAt,'captureReceipts.createdAt',{max:128})
  };
}

export function normalizeProjectRecordReceipt(receipt){
  if(!isRecord(receipt))throw invalid('projectRecordReceipts 元素必须是对象');
  const allowed=new Set([
    'version','operationId','kind','projectId','documentUrl','revisionId','blockId','recordedAt',
    'projectSnapshotHash','machineProgress','phase','updatedAt'
  ]);
  rejectUnknownFields(receipt,allowed,'projectRecordReceipts');
  if(receipt.version!==1)throw invalid('projectRecordReceipts.version 目前只支持 1');
  const operationId=safeId(receipt.operationId,'projectRecordReceipts.operationId');
  const kind=String(receipt.kind??'');
  if(!['analysis','summary'].includes(kind))throw invalid('projectRecordReceipts.kind 只支持 analysis 或 summary');
  const projectId=safeId(receipt.projectId,'projectRecordReceipts.projectId');
  let documentUrl;
  try{documentUrl=normalizeFeishuProjectDocumentUrl(receipt.documentUrl);}
  catch(error){throw invalid(`projectRecordReceipts.documentUrl：${error.message}`);}
  const projectSnapshotHash=String(receipt.projectSnapshotHash??'');
  if(projectSnapshotHash&&!SHA256.test(projectSnapshotHash))throw invalid('projectRecordReceipts.projectSnapshotHash 必须为空或 SHA-256');
  const phase=String(receipt.phase??'');
  if(!PROJECT_PHASES.has(phase))throw invalid('projectRecordReceipts.phase 不受支持');
  return {
    version:1,
    operationId,
    kind,
    projectId,
    documentUrl,
    revisionId:optionalString(receipt.revisionId,'projectRecordReceipts.revisionId',{max:256}),
    blockId:optionalString(receipt.blockId,'projectRecordReceipts.blockId',{max:256}),
    recordedAt:requiredString(receipt.recordedAt,'projectRecordReceipts.recordedAt',{max:128}),
    projectSnapshotHash,
    machineProgress:normalizeMachineProgress(receipt.machineProgress),
    phase,
    ...(receipt.updatedAt===undefined?{}:{updatedAt:requiredString(receipt.updatedAt,'projectRecordReceipts.updatedAt',{max:128})})
  };
}

function normalizeSet(value,normalizer,nameFor,label){
  if(!Array.isArray(value))throw invalid(`${label} 必须是数组`);
  const result=[];
  const names=new Set();
  for(const entry of value){
    const normalized=normalizer(entry);
    const name=nameFor(normalized);
    if(names.has(name))throw invalid(`${label} 不能包含重复 ID`);
    names.add(name);
    result.push(normalized);
  }
  return result;
}

export function normalizeCaptureReceiptSet(value){
  return normalizeSet(value,normalizeCaptureReceipt,item=>item.captureId,'captureReceipts');
}

export function normalizeProjectRecordReceiptSet(value){
  return normalizeSet(value,normalizeProjectRecordReceipt,item=>item.operationId,'projectRecordReceipts');
}

export function captureReceiptPath(dataDir,captureId){
  return path.join(dataDir,'captures',`capture-${normalizeCaptureId(captureId)}.json`);
}

export function projectRecordReceiptPath(dataDir,operationId){
  return path.join(dataDir,'recovery',`project-record-${safeId(operationId,'operationId')}.json`);
}

async function safeDirectory(directory,label){
  let stat;
  try{stat=await fsp.lstat(directory);}catch(error){
    if(error.code!=='ENOENT')throw error;
    await fsp.mkdir(directory,{mode:DIRECTORY_MODE});
    stat=await fsp.lstat(directory);
  }
  if(stat.isSymbolicLink()||!stat.isDirectory())throw invalid(`${label} 不是安全目录`);
  await fsp.chmod(directory,DIRECTORY_MODE);
  return directory;
}

export async function ensureReceiptDirectories(dataDir){
  await safeDirectory(path.join(dataDir,'captures'),'captures');
  await safeDirectory(path.join(dataDir,'recovery'),'recovery');
}

async function readReceiptFile(target,label,normalizer){
  const stat=await fsp.lstat(target);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw invalid(`${label} 不是安全普通文件`);
  return normalizer(JSON.parse(await fsp.readFile(target,'utf8')));
}

async function listDirectory(directory,filePattern,label,normalizer){
  await safeDirectory(directory,label);
  const receipts=[];
  const names=(await fsp.readdir(directory)).filter(name=>filePattern.test(name)).sort();
  for(const name of names)receipts.push(await readReceiptFile(path.join(directory,name),`${label}/${name}`,normalizer));
  return receipts;
}

export async function listCaptureReceipts(dataDir){
  return listDirectory(path.join(dataDir,'captures'),CAPTURE_FILE,'captures',normalizeCaptureReceipt);
}

export async function listProjectRecordReceipts(dataDir){
  return listDirectory(path.join(dataDir,'recovery'),PROJECT_FILE,'recovery',normalizeProjectRecordReceipt);
}

async function replaceDirectory({dataDir,directoryName,receipts,nameFor}){
  const directory=path.join(dataDir,directoryName);
  await safeDirectory(directory,directoryName);
  const token=randomUUID();
  const staging=path.join(dataDir,`.${directoryName}-restore-${token}`);
  const previous=path.join(dataDir,`.${directoryName}-previous-${token}`);
  await fsp.mkdir(staging,{mode:DIRECTORY_MODE});
  try{
    for(const receipt of receipts){
      const target=path.join(staging,nameFor(receipt));
      await fsp.writeFile(target,JSON.stringify(receipt,null,2),{encoding:'utf8',flag:'wx',mode:FILE_MODE});
      await fsp.chmod(target,FILE_MODE);
    }
    await fsp.rename(directory,previous);
    try{
      await fsp.rename(staging,directory);
      await fsp.chmod(directory,DIRECTORY_MODE);
    }catch(error){
      await fsp.rename(previous,directory).catch(()=>{});
      throw error;
    }
    await fsp.rm(previous,{recursive:true,force:true});
  }finally{
    await fsp.rm(staging,{recursive:true,force:true}).catch(()=>{});
    const current=await fsp.lstat(directory).catch(()=>null);
    const old=await fsp.lstat(previous).catch(()=>null);
    if(!current&&old)await fsp.rename(previous,directory).catch(()=>{});
  }
}

export async function replaceCaptureReceipts(dataDir,value){
  const receipts=normalizeCaptureReceiptSet(value);
  await replaceDirectory({
    dataDir,directoryName:'captures',receipts,
    nameFor:receipt=>`capture-${receipt.captureId}.json`
  });
  return receipts;
}

export async function replaceProjectRecordReceipts(dataDir,value){
  const receipts=normalizeProjectRecordReceiptSet(value);
  await replaceDirectory({
    dataDir,directoryName:'recovery',receipts,
    nameFor:receipt=>`project-record-${receipt.operationId}.json`
  });
  return receipts;
}
