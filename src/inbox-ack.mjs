import crypto from 'node:crypto';

export function normalizeInboxText(value){
  return String(value??'').replace(/\r\n?/g,'\n').trim();
}

export function inboxContentHash(value){
  return crypto.createHash('sha256').update(normalizeInboxText(value)).digest('hex');
}

export function normalizeInboxAck(ack){
  if(!ack||typeof ack!=='object'||Array.isArray(ack))return ack;
  const next={
    blockId:String(ack.blockId??''),
    contentHash:typeof ack.contentHash==='string'&&/^[a-f0-9]{64}$/.test(ack.contentHash)
      ?ack.contentHash
      :inboxContentHash(ack.text??''),
    acknowledgedAt:ack.acknowledgedAt??null
  };
  return next;
}

export function normalizeInboxAcks(value){
  if(!Array.isArray(value))return[];
  const unique=new Map();
  for(const ack of value){
    const normalized=normalizeInboxAck(ack);
    if(normalized?.blockId)unique.set(normalized.blockId,normalized);
  }
  return [...unique.values()];
}

export function inboxAckMatches(ack,text){
  return Boolean(ack&&ack.contentHash===inboxContentHash(text));
}
