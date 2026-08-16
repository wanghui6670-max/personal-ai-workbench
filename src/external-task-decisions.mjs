import {newId,nowIso} from './utils.mjs';

const MAX_DECISIONS=2000;
const DISPOSITIONS=new Set(['dismissed','memo','project_note','project_created']);

function text(value){return typeof value==='string'?value.trim():'';}
function validDecision(item){
  return item&&typeof item==='object'&&!Array.isArray(item)
    &&item.source==='getnote_cli'
    &&text(item.externalId)
    &&DISPOSITIONS.has(item.disposition)
    &&text(item.id);
}

export function normalizeExternalTaskDecisions(value){
  if(!Array.isArray(value))return[];
  const seen=new Set();
  const normalized=[];
  for(const item of value){
    if(!validDecision(item)||seen.has(item.externalId))continue;
    seen.add(item.externalId);
    normalized.push({...item});
    if(normalized.length>=MAX_DECISIONS)break;
  }
  return normalized;
}

export function isGetnoteInboxItem(item){
  return item?.source==='getnote_cli'&&Boolean(text(item.externalTaskId));
}

export function getGetnoteSourceDecision(state,externalId){
  const id=text(externalId);
  if(!id)return null;
  return normalizeExternalTaskDecisions(state?.externalTaskDecisions).find(item=>item.externalId===id)||null;
}

export function hasGetnoteSourceDecision(state,externalId){
  return Boolean(getGetnoteSourceDecision(state,externalId));
}

export function recordGetnoteSourceDecision(state,item,disposition){
  if(!isGetnoteInboxItem(item)||!DISPOSITIONS.has(disposition))return null;
  const current=normalizeExternalTaskDecisions(state.externalTaskDecisions);
  const existing=current.find(entry=>entry.externalId===item.externalTaskId);
  const decision={
    id:existing?.id||newId('xd'),
    source:'getnote_cli',
    externalId:item.externalTaskId,
    sourceNoteId:text(item.sourceNoteId)||null,
    disposition,
    decidedAt:nowIso()
  };
  state.externalTaskDecisions=[decision,...current.filter(entry=>entry.externalId!==decision.externalId)].slice(0,MAX_DECISIONS);
  return decision;
}

export function clearGetnoteSourceDecision(state,externalId){
  const id=text(externalId);
  if(!id)return false;
  const current=normalizeExternalTaskDecisions(state.externalTaskDecisions);
  const next=current.filter(item=>item.externalId!==id);
  state.externalTaskDecisions=next;
  return next.length!==current.length;
}

export function getnoteTodoLinkFields(item){
  if(!isGetnoteInboxItem(item))return{};
  return{
    source:'getnote_cli',
    externalId:item.externalTaskId,
    externalIdentityKind:item.externalIdentityKind||'text_fingerprint',
    externalStatus:'active_local_due_date_override',
    externalUpdatedAt:item.externalUpdatedAt||nowIso(),
    sourceDueDate:item.sourceDueDate??null,
    sourcePreviousDueDate:item.sourcePreviousDueDate??null,
    sourceNoteId:item.sourceNoteId||null,
    sourceNoteTitle:item.sourceNoteTitle||'',
    sourceNoteType:item.sourceNoteType||'',
    sourceNoteCreatedAt:item.sourceNoteCreatedAt||null,
    sourceNoteUpdatedAt:item.sourceNoteUpdatedAt||null,
    sourceNoteUrl:item.sourceNoteUrl||'',
    todoSource:item.todoSource||'',
    dueDateOwner:'user'
  };
}
