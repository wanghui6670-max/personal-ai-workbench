import { addActivity } from './store.mjs';
import { createFeishuJournalClient, FeishuSourceError, sourceConfigured } from './feishu.mjs';
import { newId, nowIso, compactText } from './utils.mjs';
import { inboxContentHash, inboxAckMatches, normalizeInboxAcks } from './inbox-ack.mjs';

const defaultFeishuJournalClient=createFeishuJournalClient();

function feishuSyncSummary(config,extra={}){
  const source=config?.dataSource;
  return {
    configured:sourceConfigured(source),
    provider:source?.provider||null,
    documentUrl:source?.documentUrl||null,
    revisionId:source?.lastRevisionId??null,
    syncedAt:source?.lastSyncAt??null,
    status:source?.lastSyncStatus||'not_configured',
    importedCount:Number.isInteger(source?.lastImportedCount)?source.lastImportedCount:0,
    ...extra
  };
}

export async function syncFeishuInbox({store,client=defaultFeishuJournalClient}={}){
  const config=await store.readConfig();
  if(!sourceConfigured(config.dataSource)){
    return feishuSyncSummary(config,{imported:0,removed:0,updated:0,reason:'not_configured'});
  }

  let fetched;
  try{
    fetched=await client.fetch(config.dataSource);
  }catch(error){
    await store.updateConfig(current=>{
      if(current.dataSource){
        current.dataSource.lastSyncAt=nowIso();
        current.dataSource.lastSyncStatus='error';
        current.dataSource.lastSyncError=error instanceof FeishuSourceError
          ?error.message
          :'飞书文档读取失败';
      }
      return structuredClone(current);
    }).catch(()=>{});
    throw error;
  }

  const remoteByBlock=new Map(fetched.items.map(item=>[item.blockId,item]));
  let imported=0;
  let removed=0;
  let updated=0;
  await store.updateState(state=>{
    state.inboxAcks=normalizeInboxAcks(state.inboxAcks);
    const ackByBlock=new Map(state.inboxAcks.map(item=>[item.blockId,item]));
    const localByBlock=new Map(
      state.inbox.filter(item=>item.feishuBlockId).map(item=>[item.feishuBlockId,item])
    );

    for(const remote of fetched.items){
      const contentHash=inboxContentHash(remote.text);
      const local=localByBlock.get(remote.blockId);
      const priorAck=ackByBlock.get(remote.blockId);
      if(local){
        if(local.text!==remote.text){
          local.text=remote.text;
          updated+=1;
        }
        if(priorAck)Object.assign(priorAck,{contentHash,acknowledgedAt:nowIso()});
        else{
          const ack={blockId:remote.blockId,contentHash,acknowledgedAt:nowIso()};
          state.inboxAcks.push(ack);
          ackByBlock.set(remote.blockId,ack);
        }
        continue;
      }
      if(priorAck&&inboxAckMatches(priorAck,remote.text))continue;

      const item={
        id:newId('in'),
        text:remote.text,
        source:'feishu_doc',
        feishuBlockId:remote.blockId,
        createdAt:nowIso()
      };
      state.inbox.unshift(item);
      if(priorAck)Object.assign(priorAck,{contentHash,acknowledgedAt:nowIso()});
      else{
        const ack={blockId:remote.blockId,contentHash,acknowledgedAt:nowIso()};
        state.inboxAcks.push(ack);
        ackByBlock.set(remote.blockId,ack);
      }
      imported+=1;
      addActivity(state,{type:'inbox_synced',inboxId:item.id,text:'从飞书收件箱同步一条新事项。'});
    }

    for(const local of state.inbox.filter(item=>item.source==='feishu_doc'&&item.feishuBlockId)){
      if(remoteByBlock.has(local.feishuBlockId))continue;
      state.inbox=state.inbox.filter(item=>item.id!==local.id);
      state.inboxAcks=state.inboxAcks.filter(ack=>ack.blockId!==local.feishuBlockId);
      state.confirmations=state.confirmations.filter(confirmation=>confirmation.inboxId!==local.id);
      removed+=1;
      addActivity(state,{
        type:'inbox_removed_remote',
        inboxId:local.id,
        text:'飞书收件箱已删除一个未处理事项。'
      });
    }
  });

  await store.updateConfig(current=>{
    if(current.dataSource){
      current.dataSource.lastRevisionId=fetched.revisionId===null?null:String(fetched.revisionId);
      current.dataSource.lastSyncAt=nowIso();
      current.dataSource.lastSyncStatus='ok';
      current.dataSource.lastSyncError=null;
      current.dataSource.lastImportedCount=fetched.items.length;
    }
    return structuredClone(current);
  });

  return feishuSyncSummary(await store.readConfig(),{
    imported,
    removed,
    updated,
    remoteCount:fetched.items.length,
    sectionFound:fetched.sectionFound
  });
}

export async function addInbox({store,text,source='manual',client=defaultFeishuJournalClient}){
  if(!text?.trim())throw new Error('请输入内容');
  const normalized=text.trim();
  const config=await store.readConfig();
  let remote=null;
  let resolvedSource=source;
  if(source!=='feishu_doc'&&sourceConfigured(config.dataSource)){
    remote=await client.appendAndFetch(config.dataSource,normalized);
    resolvedSource='feishu_doc';
  }

  const item={
    id:newId('in'),
    text:normalized,
    source:resolvedSource,
    createdAt:nowIso(),
    ...(remote?.item?.blockId?{feishuBlockId:remote.item.blockId}:{})
  };
  await store.updateState(state=>{
    state.inboxAcks=normalizeInboxAcks(state.inboxAcks);
    const existing=remote?.item?.blockId&&state.inbox.find(
      candidate=>candidate.feishuBlockId===remote.item.blockId
    );
    if(existing){
      Object.assign(existing,item,{id:existing.id});
      return;
    }
    state.inbox.unshift(item);
    if(item.feishuBlockId){
      const contentHash=inboxContentHash(item.text);
      const ack=state.inboxAcks.find(candidate=>candidate.blockId===item.feishuBlockId);
      if(ack)Object.assign(ack,{contentHash,acknowledgedAt:nowIso()});
      else state.inboxAcks.push({
        blockId:item.feishuBlockId,
        contentHash,
        acknowledgedAt:nowIso()
      });
    }
    addActivity(state,{
      type:'inbox_captured',
      text:`收件箱新增：${compactText(item.text,80)}`,
      inboxId:item.id
    });
  });
  return item;
}
