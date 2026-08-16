import { addActivity } from './store.mjs';
import { createFeishuJournalClient, FeishuSourceError, sourceConfigured } from './feishu.mjs';
import { newId, nowIso, compactText } from './utils.mjs';
import { inboxContentHash, normalizeInboxAcks } from './inbox-ack.mjs';
import { normalizeCaptureId, parseCaptureMarker } from './capture-contract.mjs';

const defaultFeishuJournalClient=createFeishuJournalClient();
const MIXED_DIARY_BOOTSTRAP_HEAD=30;
const MIXED_DIARY_BOOTSTRAP_TAIL=30;

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

function mixedDiaryBootstrapSelection(items){
  if(items.length<=MIXED_DIARY_BOOTSTRAP_HEAD+MIXED_DIARY_BOOTSTRAP_TAIL)return new Set(items.map(item=>item.blockId));
  const ids=new Set();
  for(const item of items.slice(0,MIXED_DIARY_BOOTSTRAP_HEAD))ids.add(item.blockId);
  for(const item of items.slice(-MIXED_DIARY_BOOTSTRAP_TAIL))ids.add(item.blockId);
  return ids;
}

function applyRemoteMetadata(local,remote,mode){
  local.feishuMode=mode||'inbox_section';
  if(Array.isArray(remote.headingPath)&&remote.headingPath.length)local.feishuHeadingPath=[...remote.headingPath];
  else delete local.feishuHeadingPath;
  if(remote.tag)local.feishuTag=remote.tag;
  else delete local.feishuTag;
  local.feishuExplicitInbox=remote.explicitInbox===true;
}

export async function syncFeishuInbox({store,client=defaultFeishuJournalClient}={}){
  const config=await store.readConfig();
  if(!sourceConfigured(config.dataSource)){
    return feishuSyncSummary(config,{imported:0,removed:0,updated:0,deduped:0,seenSkipped:0,reason:'not_configured'});
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

  const allRemoteItems=(fetched.items||[]).map(normalizeRemoteItem).filter(item=>item.blockId&&item.text);
  const {unique:uniqueRemoteItems,duplicates:duplicateRemoteItems}=dedupeRemoteItems(allRemoteItems);
  const firstMixedSync=fetched.mode==='mixed_diary'&&config.dataSource?.lastRevisionId==null;
  const bootstrapIds=firstMixedSync?mixedDiaryBootstrapSelection(uniqueRemoteItems):null;
  const remoteItems=bootstrapIds?uniqueRemoteItems.filter(item=>bootstrapIds.has(item.blockId)):uniqueRemoteItems;
  const baselineItems=bootstrapIds?uniqueRemoteItems.filter(item=>!bootstrapIds.has(item.blockId)):[];
  let imported=0;
  let baselined=0;
  let deduped=duplicateRemoteItems.length;
  let seenSkipped=0;

  await store.updateState(state=>{
    state.inboxAcks=normalizeInboxAcks(state.inboxAcks);
    const ackByBlock=new Map(state.inboxAcks.map(item=>[item.blockId,item]));
    const localByBlock=new Map(
      state.inbox.filter(item=>item.feishuBlockId).map(item=>[item.feishuBlockId,item])
    );
    const knownExactHashes=new Set(state.inboxAcks.map(item=>item.contentHash).filter(Boolean));
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

    for(const remote of baselineItems){
      if(ackByBlock.has(remote.blockId)){
        seenSkipped+=1;
        continue;
      }
      const contentHash=ensureAck(remote);
      knownExactHashes.add(contentHash);
      knownDedupeHashes.add(inboxDedupeHash(remote.text));
      baselined+=1;
    }

    for(const {item:remote} of duplicateRemoteItems){
      if(ackByBlock.has(remote.blockId)){
        seenSkipped+=1;
        continue;
      }
      ensureAck(remote);
    }

    for(const remote of remoteItems){
      const priorAck=ackByBlock.get(remote.blockId);
      if(priorAck){
        seenSkipped+=1;
        continue;
      }

      const contentHash=inboxContentHash(remote.text);
      const dedupeHash=inboxDedupeHash(remote.text);
      const local=localByBlock.get(remote.blockId);
      if(local){
        applyRemoteMetadata(local,remote,fetched.mode);
        ensureAck(remote);
        knownExactHashes.add(contentHash);
        knownDedupeHashes.add(dedupeHash);
        seenSkipped+=1;
        continue;
      }

      if(knownExactHashes.has(contentHash)||knownDedupeHashes.has(dedupeHash)){
        ensureAck(remote);
        knownExactHashes.add(contentHash);
        knownDedupeHashes.add(dedupeHash);
        deduped+=1;
        continue;
      }

      const item={
        id:newId('in'),
        text:remote.text,
        source:'feishu_doc',
        feishuBlockId:remote.blockId,
        feishuMode:fetched.mode||'inbox_section',
        ...(Array.isArray(remote.headingPath)&&remote.headingPath.length?{feishuHeadingPath:[...remote.headingPath]}:{}),
        ...(remote.tag?{feishuTag:remote.tag}:{}),
        feishuExplicitInbox:remote.explicitInbox===true,
        ...(remote.captureId?{captureId:remote.captureId}:{}),
        createdAt:nowIso()
      };
      state.inbox.unshift(item);
      ensureAck(remote);
      knownExactHashes.add(contentHash);
      knownDedupeHashes.add(dedupeHash);
      imported+=1;
      addActivity(state,{
        type:'inbox_synced',
        inboxId:item.id,
        text:fetched.mode==='mixed_diary'?'从飞书日记同步一条新增内容。':'从飞书收件箱同步一条新事项。'
      });
    }

    // Append-only source contract: previously seen block IDs are permanent history.
    // Remote edits/deletions never mutate or re-open Workbench state. Users can
    // explicitly remove local pending items without touching the Feishu source.
  });

  await store.updateConfig(current=>{
    if(current.dataSource){
      current.dataSource.lastRevisionId=fetched.revisionId===null?null:String(fetched.revisionId);
      current.dataSource.lastSyncAt=nowIso();
      current.dataSource.lastSyncStatus='ok';
      current.dataSource.lastSyncError=null;
      current.dataSource.lastImportedCount=allRemoteItems.length;
    }
    return structuredClone(current);
  });

  return feishuSyncSummary(await store.readConfig(),{
    imported,
    removed:0,
    updated:0,
    deduped,
    seenSkipped,
    remoteCount:allRemoteItems.length,
    uniqueRemoteCount:uniqueRemoteItems.length,
    sectionFound:fetched.sectionFound,
    mode:fetched.mode||'inbox_section',
    baselined,
    firstMixedSync
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
  if(source!=='feishu_doc'&&sourceConfigured(config.dataSource)){
    remote=await client.appendAndFetch(config.dataSource,normalized,{
      ...(normalizedCaptureId?{captureId:normalizedCaptureId}:{})
    });
    resolvedSource='feishu_doc';
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
    ...(remote?.item?{feishuExplicitInbox:remote.item.explicitInbox===true}:{}),
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
