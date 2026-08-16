import { addActivity } from './store.mjs';
import { isGetnoteInboxItem, recordGetnoteSourceDecision } from './external-task-decisions.mjs';

function badRequest(message){
  return Object.assign(new Error(message),{statusCode:400,code:'INVALID_REQUEST'});
}

export async function batchDeleteInboxLocal({store,itemIds}={}){
  if(!store)throw badRequest('缺少工作台存储。');
  if(!Array.isArray(itemIds)||!itemIds.length)throw badRequest('至少选择一条待处理记录。');
  if(itemIds.length>500)throw badRequest('单次批量删除最多 500 条。');
  if(itemIds.some(id=>typeof id!=='string'||!id.trim()))throw badRequest('批量删除 ID 必须是非空字符串。');

  const requested=[...new Set(itemIds.map(id=>id.trim()))];
  const requestedSet=new Set(requested);
  let deletedIds=[];
  let missingIds=[];

  await store.updateState(state=>{
    const byId=new Map((state.inbox||[]).map(item=>[item.id,item]));
    deletedIds=requested.filter(id=>byId.has(id));
    missingIds=requested.filter(id=>!byId.has(id));
    const deletedSet=new Set(deletedIds);

    for(const id of deletedIds){
      const item=byId.get(id);
      if(isGetnoteInboxItem(item))recordGetnoteSourceDecision(state,item,'dismissed');
    }

    state.inbox=(state.inbox||[]).filter(item=>!deletedSet.has(item.id));
    state.confirmations=(state.confirmations||[]).filter(item=>!deletedSet.has(item.inboxId));

    if(deletedIds.length){
      addActivity(state,{
        type:'inbox_batch_deleted',
        text:`批量删除 Workbench 本地待处理 ${deletedIds.length} 条；来源原文未改。`
      });
    }
  });

  return {
    requested:requestedSet.size,
    deleted:deletedIds.length,
    missing:missingIds.length,
    deletedIds,
    missingIds
  };
}
