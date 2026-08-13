import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeCaptureId, captureContentHash } from './capture-contract.mjs';

const DIRECTORY_MODE=0o700;
const FILE_MODE=0o600;

function conflict(message){
  return Object.assign(new Error(message),{statusCode:409,code:'CAPTURE_ID_CONFLICT'});
}

export class CaptureReceiptStore{
  constructor(dataDir){
    this.directory=path.join(dataDir,'captures');
  }

  async ensure(){
    let stat;
    try{stat=await fsp.lstat(this.directory);}catch(error){
      if(error.code!=='ENOENT')throw error;
      await fsp.mkdir(this.directory,{mode:DIRECTORY_MODE});
      stat=await fsp.lstat(this.directory);
    }
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('capture receipt 目录不是安全目录。');
    await fsp.chmod(this.directory,DIRECTORY_MODE);
  }

  file(captureId){return path.join(this.directory,`capture-${normalizeCaptureId(captureId)}.json`);}

  async read(captureId){
    await this.ensure();
    const target=this.file(captureId);
    let stat;
    try{stat=await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw new Error('capture receipt 不是安全普通文件。');
    const receipt=JSON.parse(await fsp.readFile(target,'utf8'));
    if(receipt.captureId!==normalizeCaptureId(captureId))throw new Error('capture receipt ID 不一致。');
    return receipt;
  }

  async write({captureId,text,inboxId=null,feishuBlockId=null,createdAt=new Date().toISOString()}){
    await this.ensure();
    const id=normalizeCaptureId(captureId);
    const contentHash=captureContentHash(text);
    const existing=await this.read(id);
    if(existing){
      if(existing.contentHash!==contentHash)throw conflict('同一 captureId 已用于不同内容，已拒绝覆盖。');
      return{...existing,replayed:true};
    }
    const receipt={
      version:1,
      captureId:id,
      contentHash,
      inboxId:inboxId?String(inboxId):null,
      feishuBlockId:feishuBlockId?String(feishuBlockId):null,
      createdAt:String(createdAt)
    };
    const target=this.file(id);
    const temp=path.join(this.directory,`.capture-${id}-${randomUUID()}.tmp`);
    try{
      await fsp.writeFile(temp,JSON.stringify(receipt,null,2),{encoding:'utf8',flag:'wx',mode:FILE_MODE});
      await fsp.chmod(temp,FILE_MODE);
      try{await fsp.link(temp,target);}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        const raced=await this.read(id);
        if(raced.contentHash!==contentHash)throw conflict('同一 captureId 已用于不同内容，已拒绝覆盖。');
        return{...raced,replayed:true};
      }
      return{...receipt,replayed:false};
    }finally{
      await fsp.unlink(temp).catch(()=>{});
    }
  }
}
