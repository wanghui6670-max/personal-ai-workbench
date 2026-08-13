import { randomUUID } from 'node:crypto';
import { addInbox } from './inbox-domain.mjs';
import { createFeishuCaptureClient } from './feishu-capture.mjs';
import { CaptureReceiptStore } from './capture-receipts.mjs';
import { normalizeCaptureId, captureContentHash } from './capture-contract.mjs';

const defaultCaptureClient=createFeishuCaptureClient();
const captureLocks=new Map();

function captureConflict(message){
  return Object.assign(new Error(message),{statusCode:409,code:'CAPTURE_ID_CONFLICT'});
}

async function withCaptureLease(captureId,work){
  const previous=captureLocks.get(captureId)||Promise.resolve();
  let release;
  const current=new Promise(resolve=>{release=resolve;});
  captureLocks.set(captureId,current);
  await previous;
  try{return await work();}
  finally{
    release();
    if(captureLocks.get(captureId)===current)captureLocks.delete(captureId);
  }
}

function generatedCaptureId(){return `cap_${randomUUID().replaceAll('-','')}`;}

export async function captureInbox({store,captureId=null,text,client=defaultCaptureClient}){
  const normalizedText=String(text??'').trim();
  if(!normalizedText)throw Object.assign(new Error('采集内容不能为空。'),{statusCode:400,code:'INVALID_CAPTURE'});
  const id=normalizeCaptureId(captureId||generatedCaptureId());
  const contentHash=captureContentHash(normalizedText);
  const receipts=new CaptureReceiptStore(store.dataDir);

  return withCaptureLease(id,async()=>{
    const receipt=await receipts.read(id);
    if(receipt){
      if(receipt.contentHash!==contentHash)throw captureConflict('同一 captureId 已用于不同内容，已拒绝覆盖。');
      const state=await store.readState();
      const item=state.inbox.find(candidate=>
        candidate.captureId===id||
        (receipt.inboxId&&candidate.id===receipt.inboxId)||
        (receipt.feishuBlockId&&candidate.feishuBlockId===receipt.feishuBlockId)
      )||null;
      return{
        captureId:id,
        replayed:true,
        processed:!item,
        item,
        receipt
      };
    }

    const state=await store.readState();
    const existing=state.inbox.find(candidate=>candidate.captureId===id)||null;
    if(existing){
      if(captureContentHash(existing.text)!==contentHash)throw captureConflict('同一 captureId 已用于不同内容，已拒绝覆盖。');
      const stored=await receipts.write({
        captureId:id,
        text:normalizedText,
        inboxId:existing.id,
        feishuBlockId:existing.feishuBlockId||null,
        createdAt:existing.createdAt
      });
      return{captureId:id,replayed:true,processed:false,item:existing,receipt:stored};
    }

    const item=await addInbox({
      store,
      text:normalizedText,
      source:'iphone-shortcut',
      captureId:id,
      client
    });
    const stored=await receipts.write({
      captureId:id,
      text:normalizedText,
      inboxId:item.id,
      feishuBlockId:item.feishuBlockId||null,
      createdAt:item.createdAt
    });
    return{
      captureId:id,
      replayed:Boolean(stored.replayed),
      processed:false,
      item,
      receipt:stored
    };
  });
}
