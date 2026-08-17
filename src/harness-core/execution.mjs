import { randomUUID } from 'node:crypto';

export function createExecutionService({store}={}){
  if(!store)throw new Error('createExecutionService requires store');

  async function begin({trigger='broker',sessionRef=null,actor='harness',tool}={}){
    const record={
      executionId:`ex_${randomUUID().replaceAll('-','')}`,
      trigger,
      sessionRef,
      actor,
      tool,
      startedAt:new Date().toISOString(),
      completedAt:null,
      status:'running',
      resultSummary:'',
      errorCode:null
    };
    await store.append(record);
    return record;
  }

  async function finish(receipt,patch={}){
    if(!receipt)return null;
    const record={
      ...receipt,
      completedAt:new Date().toISOString(),
      status:patch.status||'ok',
      resultSummary:String(patch.resultSummary||'').slice(0,160),
      errorCode:patch.errorCode??null
    };
    await store.append(record);
    return record;
  }

  return Object.freeze({
    begin,
    finish,
    list:opts=>store.list(opts),
    get:id=>store.get(id)
  });
}
