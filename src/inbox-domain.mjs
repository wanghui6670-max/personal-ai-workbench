import { addActivity } from './store.mjs';
import { createFeishuJournalClient, FeishuSourceError, sourceConfigured } from './feishu.mjs';
import { newId, nowIso, compactText } from './utils.mjs';
import { inboxContentHash, normalizeInboxAcks } from './inbox-ack.mjs';
import { normalizeCaptureId, parseCaptureMarker } from './capture-contract.mjs';

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
    initializedAt:source?.initialImportAt??null,
    ...extra
  };
}

function normalizeRemoteItem(item){
  if(item?.captureId)return{...item,text:String(item.text??'').trim(),captureId:normalizeCaptureId(item.captureId)};
  const parsed=parseCaptureMarker(item?.text);
  return{...item,text:parsed.text,captureId:parsed.captureId};
}

function normalizeDedupeText(value){
  return String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
}

function inboxDedupeHash(value){
  return inboxContentHash(normalizeDedupeText(value));
}

function dedupeRemoteItems(items){
  const winnerByHash=new Map();
  for(const item of items)winnerByHash.set(inboxDedupeHash(item.text),item);
  const unique=[];
  const duplicates=[];
  for(const item of items){
    const winner=winnerByHash.get(inboxDedupeHash(item.text));
    if(winner===item)unique.push(item);
    else duplicates.push({item,winner});
  }
  return{unique,duplicates};
}

function applyRemoteMetadata(local,remote,mode){
  local.feishuMode=mode||'todo_only';
  if(Array.isArray(remote.headingPath)&&remote.headingPath.length)local.feishuHeadingPath=[...remote.headingPath];
  else delete local.feishuHeadingPath;
  if(remote.tag)local.feishuTag=remote.tag;
  else delete local.feishuTag;
  local.feishuExplicitInbox=remote.explicitInbox===true;
  local.feishuExplicitTodo=true;
  if(remote.todoKind)local.feishuTodoKind=remote.todoKind;
  else delete local.feishuTodoKind;
}

function legacyDiaryBlockId(item){
  if(item?.source==='feishu_todo_candidate')return item.feishuSourceBlockId||null;
  if(item?.source==='feishu_doc'&&item.feishuMode==='mixed_diary')return item.feishuBlockId||null;
  return null;
}

export async function syncFeishuInbox({store,client=defaultFeishuJournalClient,initialize=false}={}){
  const config=await store.readConfig();
  if(!sourceConfigured(config.dataSource)){
    return feishuSyncSummary(config,{imported:0,removed:0,updated:0,deduped:0,seenSkipped:0,cleanedLegacy:0,initialized:Boolean(initialize),reason:'not_configured'});
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

  const allRemoteItems=(fetched.items||[])
    .map(normalizeRemoteItem)
    .filter(item=>item.blockId&&item.text&&item.explicitTodo!==false);
  const {unique:uniqueRemoteItems,duplicates:duplicateRemoteItems}=dedupeRemoteItems(allRemoteItems);
  const remoteTodoBlockIds=new Set(uniqueRemoteItems.map(item=>item.blockId));
  let imported=0;
  let deduped=duplicateRemoteItems.length;
  let seenSkipped=0;
  let cleanedLegacy=0;

  await store.updateState(state=>{
    state.inboxAcks=initialize?[]:normalizeInboxAcks(state.inboxAcks);

    const legacyItemIds=new Set();
    const legacyBlockIds=new Set();
    const kept=[];
    for(const item of state.inbox||[]){
      const legacyBlock=legacyDiaryBlockId(item);
      if(legacyBlock){
        legacyItemIds.add(item.id);
        legacyBlockIds.add(legacyBlock);
        cleanedLegacy+=1;
        continue;
      }
      if(item.source==='feishu_doc'&&item.feishuMode!=='mixed_diary'){
        item.source='feishu_todo';
        item.feishuMode='todo_only';
        item.feishuExplicitTodo=true;
      }
      kept.push(item);
    }
    state.inbox=kept;
    if(legacyItemIds.size){
      state.confirmations=(state.confirmations||[]).filter(entry=>!legacyItemIds.has(entry.inboxId));
    }

    // 旧版曾把整篇日记的 block 都写进 ACK。迁移时，仅对“当前确实是显式待办”的
    // 旧来源释放 ACK，让它能按新 todo-only 合同重新进入；普通日记的 ACK 继续保留。
    if(!initialize&&legacyBlockIds.size){
      state.inboxAcks=state.inboxAcks.filter(ack=>!(legacyBlockIds.has(ack.blockId)&&remoteTodoBlockIds.has(ack.blockId)));
    }
    if(cleanedLegacy){
      addActivity(state,{
        type:'feishu_todo_only_migrated',
        text:`待办同步切换为飞书明确待办：撤下旧版日记解析暂存 ${cleanedLegacy} 条；飞书原文未改。`
      });
    }

    const ackByBlock=new Map(state.inboxAcks.map(item=>[item.blockId,item]));
    const localByBlock=new Map(
      state.inbox.filter(item=>item.feishuBlockId).map(item=>[item.feishuBlockId,item])
    );
    const knownDedupeHashes=new Set();
    for(const item of state.inbox)if(item?.text)knownDedupeHashes.add(inboxDedupeHash(item.text));
    for(const todo of state.todos||[]){
      if(todo?.context)knownDedupeHashes.add(inboxDedupeHash(todo.context));
      if(todo?.title)knownDedupeHashes.add(inboxDedupeHash(todo.title));
    }
    for(const note of state.notes||[])if(note?.text)knownDedupeHashes.add(inboxDedupeHash(note.text));

    const ensureAck=remote=>{
      const prior=ackByBlock.get(remote.blockId);
      if(prior)return prior.contentHash;
      const contentHash=inboxContentHash(remote.text);
      const ack={blockId:remote.blockId,contentHash,acknowledgedAt:nowIso()};
      state.inboxAcks.push(ack);
      ackByBlock.set(remote.blockId,ack);
      return contentHash;
    };

    for(const {item:remote} of duplicateRemoteItems){
      if(ackByBlock.has(remote.blockId)){
        seenSkipped+=1;
        continue;
      }
      ensureAck(remote);
    }

    for(const remote of uniqueRemoteItems){
      const priorAck=ackByBlock.get(remote.blockId);
      if(priorAck){
        seenSkipped+=1;
        continue;
      }

      const dedupeHash=inboxDedupeHash(remote.text);
      const local=localByBlock.get(remote.blockId);
      if(local){
        local.source='feishu_todo';
        applyRemoteMetadata(local,remote,'todo_only');
        ensureAck(remote);
        knownDedupeHashes.add(dedupeHash);
        seenSkipped+=1;
        continue;
      }

      if(knownDedupeHashes.has(dedupeHash)){
        ensureAck(remote);
        knownDedupeHashes.add(dedupeHash);
        deduped+=1;
        continue;
      }

      const item={
        id:newId('in'),
        text:remote.text,
        source:'feishu_todo',
        feishuBlockId:remote.blockId,
        feishuMode:'todo_only',
        ...(Array.isArray(remote.headingPath)&&remote.headingPath.length?{feishuHeadingPath:[...remote.headingPath]}:{}),
        ...(remote.tag?{feishuTag:remote.tag}:{}),
        feishuExplicitInbox:remote.explicitInbox===true,
        feishuExplicitTodo:true,
        ...(remote.todoKind?{feishuTodoKind:remote.todoKind}:{}),
        ...(remote.captureId?{captureId:remote.captureId}:{}),
        createdAt:nowIso()
      };
      state.inbox.unshift(item);
      ensureAck(remote);
      knownDedupeHashes.add(dedupeHash);
      imported+=1;
      addActivity(state,{
        type:initialize?'inbox_initialized':'inbox_synced',
        inboxId:item.id,
        text:initialize?'初始化导入一条飞书明确待办。':'从飞书云文档同步一条明确待办。'
      });
    }

    // Todo-only source contract: only explicit todo blocks enter Workbench.
    // Already-seen block IDs remain append-only history; normal remote edits/deletes do not
    // silently mutate Workbench state. Reinitialize remains the explicit baseline reset path.
  });

  const completedAt=nowIso();
  await store.updateConfig(current=>{
    if(current.dataSource){
      current.dataSource.lastRevisionId=fetched.revisionId===null?null:String(fetched.revisionId);
      current.dataSource.lastSyncAt=completedAt;
      current.dataSource.lastSyncStatus='ok';
      current.dataSource.lastSyncError=null;
      current.dataSource.lastImportedCount=allRemoteItems.length;
      if(initialize)current.dataSource.initialImportAt=completedAt;
    }
    return structuredClone(current);
  });

  return feishuSyncSummary(await store.readConfig(),{
    imported,
    removed:cleanedLegacy,
    updated:0,
    deduped,
    seenSkipped,
    remoteCount:allRemoteItems.length,
    uniqueRemoteCount:uniqueRemoteItems.length,
    sectionFound:fetched.sectionFound,
    mode:'todo_only',
    baselined:0,
    firstMixedSync:false,
    cleanedLegacy,
    initialized:Boolean(initialize)
  });
}

export async function addInbox({
  store,
  text,
  source='manual',
  captureId=null,
  client=defaultFeishuJournalClient
}){
  if(!text?.trim())throw new Error('请输入内容');
  const normalized=text.trim();
  const normalizedCaptureId=captureId?normalizeCaptureId(captureId):null;
  const config=await store.readConfig();
  let remote=null;
  let resolvedSource=source;
  if(source!=='feishu_doc'&&source!=='feishu_todo'&&sourceConfigured(config.dataSource)){
    remote=await client.appendAndFetch(config.dataSource,normalized,{
      ...(normalizedCaptureId?{captureId:normalizedCaptureId}:{})
    });
    resolvedSource='feishu_todo';
  }

  const resolvedCaptureId=remote?.item?.captureId||normalizedCaptureId;
  const item={
    id:newId('in'),
    text:normalized,
    source:resolvedSource,
    createdAt:nowIso(),
    ...(remote?.item?.blockId?{feishuBlockId:remote.item.blockId}:{}),
    ...(remote?.mode?{feishuMode:remote.mode}:{}),
    ...(Array.isArray(remote?.item?.headingPath)&&remote.item.headingPath.length?{feishuHeadingPath:[...remote.item.headingPath]}:{}),
    ...(remote?.item?.tag?{feishuTag:remote.item.tag}:{}),
    ...(remote?.item?{feishuExplicitInbox:remote.item.explicitInbox===true,feishuExplicitTodo:true}:{}),
    ...(remote?.item?.todoKind?{feishuTodoKind:remote.item.todoKind}:{}),
    ...(resolvedCaptureId?{captureId:resolvedCaptureId}:{})
  };
  await store.updateState(state=>{
    state.inboxAcks=normalizeInboxAcks(state.inboxAcks);
    const existing=state.inbox.find(candidate=>
      (remote?.item?.blockId&&candidate.feishuBlockId===remote.item.blockId)||
      (resolvedCaptureId&&candidate.captureId===resolvedCaptureId)
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
