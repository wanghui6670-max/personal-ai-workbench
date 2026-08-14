import crypto from 'node:crypto';
import { addActivity } from './store.mjs';
import { newId, nowIso, todayIso, compactText } from './utils.mjs';
import { normalizeFeishuProjectDocumentUrl } from './project-record-contract.mjs';
import { createTaskCliClient, normalizeCliFlavor, ExternalTaskSourceError } from './task-cli.mjs';
import { createFeishuDailyJournalClient, DAILY_JOURNAL_HEADING } from './feishu-daily-journal.mjs';
import { writeLocalCalendar } from './local-calendar.mjs';

const SETTINGS_KEY='externalTaskPipeline';
const DEFAULT_INTEGRATION=Object.freeze({
  enabled:false,
  provider:'dida_cli',
  cliFlavor:'ticktick',
  journalDocumentUrl:'',
  journalHeading:DAILY_JOURNAL_HEADING,
  calendarEnabled:true,
  calendarName:'个人 AI 工作台',
  lastSyncAt:null,
  lastSyncStatus:'not_synced',
  lastSyncError:null,
  lastImportedCount:0,
  lastCompletedCount:0,
  lastUndatedCount:0,
  lastJournalAt:null,
  lastJournalBlockId:null,
  lastCalendarAt:null,
  lastCalendarPath:null,
  lastCalendarEventCount:0,
  lastSummaryAt:null,
  lastSummaryBlockId:null
});
const CONFIG_FIELDS=new Set(['enabled','cliFlavor','journalDocumentUrl','journalHeading','calendarEnabled','calendarName']);

export class ExternalTaskIntegrationError extends Error{
  constructor(message,{cause,code='EXTERNAL_TASK_INTEGRATION_FAILED',statusCode=500}={}){
    super(message,{cause});
    this.name='ExternalTaskIntegrationError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function asBoolean(value,fallback){return typeof value==='boolean'?value:fallback;}
function boundedText(value,fallback,max){
  const text=String(value??'').trim();
  return (text||fallback).slice(0,max);
}

export function normalizeExternalTaskIntegration(value={}){
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  let cliFlavor;
  try{cliFlavor=normalizeCliFlavor(source.cliFlavor||DEFAULT_INTEGRATION.cliFlavor);}
  catch(error){throw new ExternalTaskIntegrationError(error.message,{cause:error,code:error.code,statusCode:error.statusCode});}
  const next={
    ...DEFAULT_INTEGRATION,
    ...source,
    enabled:asBoolean(source.enabled,DEFAULT_INTEGRATION.enabled),
    provider:'dida_cli',
    cliFlavor,
    journalDocumentUrl:String(source.journalDocumentUrl||'').trim(),
    journalHeading:boundedText(source.journalHeading,DAILY_JOURNAL_HEADING,80),
    calendarEnabled:asBoolean(source.calendarEnabled,DEFAULT_INTEGRATION.calendarEnabled),
    calendarName:boundedText(source.calendarName,DEFAULT_INTEGRATION.calendarName,80)
  };
  if(next.enabled){
    if(!next.journalDocumentUrl)throw new ExternalTaskIntegrationError('启用滴答待办同步时，必须配置飞书每日工作日记 URL。',{code:'EXTERNAL_TASK_INTEGRATION_NOT_CONFIGURED',statusCode:400});
    try{next.journalDocumentUrl=normalizeFeishuProjectDocumentUrl(next.journalDocumentUrl);}
    catch(error){throw new ExternalTaskIntegrationError(`飞书每日工作日记 URL 无效：${error.message}`,{cause:error,code:'INVALID_FEISHU_JOURNAL',statusCode:400});}
  }
  return next;
}

export function integrationFromConfig(config={}){
  return normalizeExternalTaskIntegration(config?.settings?.[SETTINGS_KEY]||{});
}

export async function readExternalTaskIntegration({store}){
  return integrationFromConfig(await store.readConfig());
}

export async function updateExternalTaskIntegration({store,patch}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new ExternalTaskIntegrationError('集成设置必须是 JSON 对象。',{code:'INVALID_EXTERNAL_TASK_INTEGRATION',statusCode:400});
  const unknown=Object.keys(patch).find(key=>!CONFIG_FIELDS.has(key));
  if(unknown)throw new ExternalTaskIntegrationError(`集成设置包含不支持的字段：${unknown}。`,{code:'INVALID_EXTERNAL_TASK_INTEGRATION',statusCode:400});
  let saved;
  await store.updateConfig(config=>{
    const current=config?.settings?.[SETTINGS_KEY]||{};
    const next=normalizeExternalTaskIntegration({...current,...patch});
    config.settings={...(config.settings||{}),[SETTINGS_KEY]:next};
    if(config.dataSource?.provider==='feishu_doc')config.dataSource=null;
    saved=structuredClone(next);
    return saved;
  });
  return saved;
}

function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function operationId(kind,date,value){return `${kind}-${date}-${hash(value).slice(0,24)}`;}
function externalTodo(state,externalId){return state.todos.find(todo=>todo.source==='dida_cli'&&todo.externalId===externalId)||null;}
function externalInbox(state,externalId){return state.inbox.find(item=>item.source==='dida_cli'&&item.externalTaskId===externalId)||null;}

function todoContext(task){
  const parts=[];
  if(task.content)parts.push(task.content);
  if(task.description&&task.description!==task.content)parts.push(task.description);
  if(task.externalProjectId)parts.push(`滴答项目 ID：${task.externalProjectId}`);
  return compactText(parts.join('\n')||'来自滴答清单 CLI。',2000);
}

function applyTaskSnapshot(state,{active,completed}){
  const now=nowIso();
  let created=0,updated=0,completedCount=0,undated=0;
  const activeIds=new Set(active.map(task=>task.externalId));
  for(const task of active){
    const existingTodo=externalTodo(state,task.externalId);
    const existingInbox=externalInbox(state,task.externalId);
    if(!task.dueDate){
      undated+=1;
      if(existingTodo){
        state.todayPlan=state.todayPlan.filter(id=>id!==existingTodo.id);
        state.todos=state.todos.filter(todo=>todo.id!==existingTodo.id);
      }
      const text=compactText(`${task.title}${task.content?`｜${task.content}`:''}`,1000);
      if(existingInbox){
        existingInbox.text=text;
        existingInbox.externalStatus='active_without_due_date';
        existingInbox.externalUpdatedAt=task.updatedAt||now;
      }else{
        state.inbox.unshift({
          id:newId('in'),text,source:'dida_cli',externalTaskId:task.externalId,
          externalProjectId:task.externalProjectId,externalStatus:'active_without_due_date',
          externalUpdatedAt:task.updatedAt||now,createdAt:now
        });
        created+=1;
      }
      continue;
    }
    if(existingInbox)state.inbox=state.inbox.filter(item=>item.id!==existingInbox.id);
    const patch={
      title:compactText(task.title,200),
      context:todoContext(task),
      dueDate:task.dueDate,
      done:false,
      source:'dida_cli',
      externalId:task.externalId,
      externalProjectId:task.externalProjectId,
      externalStatus:'active',
      externalUpdatedAt:task.updatedAt||now,
      startAt:task.startAt,
      dueAt:task.dueAt,
      allDay:task.allDay,
      timeZone:task.timeZone,
      priority:task.priority,
      priorityLabel:task.priorityLabel,
      tags:task.tags
    };
    if(existingTodo){
      const before=JSON.stringify(existingTodo);
      Object.assign(existingTodo,patch,{projectId:existingTodo.projectId??null,createdAt:existingTodo.createdAt||now});
      if(JSON.stringify(existingTodo)!==before)updated+=1;
    }else{
      state.todos.unshift({id:newId('td'),...patch,projectId:null,createdAt:now});
      created+=1;
    }
  }

  for(const task of completed){
    if(activeIds.has(task.externalId))continue;
    const todo=externalTodo(state,task.externalId);
    const inbox=externalInbox(state,task.externalId);
    if(inbox)state.inbox=state.inbox.filter(item=>item.id!==inbox.id);
    if(!todo)continue;
    if(!todo.done)completedCount+=1;
    todo.done=true;
    todo.externalStatus='completed';
    todo.completedAt=task.completedAt||now;
    todo.externalUpdatedAt=task.updatedAt||now;
    state.todayPlan=state.todayPlan.filter(id=>id!==todo.id);
  }
  return{created,updated,completed:completedCount,undated};
}

function taskSnapshotText(source,date){
  const active=[...source.active].sort((a,b)=>String(a.dueDate||'9999').localeCompare(String(b.dueDate||'9999'))||a.title.localeCompare(b.title));
  const completed=[...source.completed].sort((a,b)=>String(b.completedAt||b.updatedAt||'').localeCompare(String(a.completedAt||a.updatedAt||''))).slice(0,20);
  const due=active.filter(task=>task.dueDate);
  const undated=active.filter(task=>!task.dueDate);
  const overdue=due.filter(task=>task.dueDate<date);
  const lines=[
    `日期：${date}`,
    `来源：滴答清单 CLI（${source.cliFlavor}）`,
    `当前未完成：${active.length}；已设截止：${due.length}；无截止待确认：${undated.length}；逾期：${overdue.length}`
  ];
  if(due.length){
    lines.push('待办：');
    due.slice(0,100).forEach((task,index)=>lines.push(`${index+1}. ${task.title}｜截止 ${task.dueDate}${task.dueAt&&task.dueAt.slice(0,10)!==task.dueAt?`｜${task.dueAt}`:''}`));
  }
  if(undated.length){
    lines.push('无截止日期（留在工作台收件箱，等待你决定）：');
    undated.slice(0,30).forEach((task,index)=>lines.push(`${index+1}. ${task.title}`));
  }
  if(completed.length){
    lines.push('最近完成：');
    completed.forEach((task,index)=>lines.push(`${index+1}. ${task.title}`));
  }
  if(source.completedWarning)lines.push('提示：已完成任务列表未能完整读取；本次未据此推断缺失任务已完成。');
  return lines.join('\n');
}

function summaryText(state,date,notes=''){
  const externalTodos=state.todos.filter(todo=>todo.source==='dida_cli');
  const completed=externalTodos.filter(todo=>todo.done&&String(todo.completedAt||'').slice(0,10)===date);
  const active=externalTodos.filter(todo=>!todo.done);
  const dueToday=active.filter(todo=>todo.dueDate===date);
  const overdue=active.filter(todo=>todo.dueDate<date);
  const activities=state.activities.filter(activity=>String(activity.at||'').slice(0,10)===date).slice(0,30);
  const lines=[
    `日期：${date}`,
    `今日完成：${completed.length}；今日到期未完成：${dueToday.length}；逾期待办：${overdue.length}；当前滴答待办：${active.length}`
  ];
  if(completed.length){lines.push('完成事项：');completed.slice(0,30).forEach((todo,index)=>lines.push(`${index+1}. ${todo.title}`));}
  if(dueToday.length){lines.push('今日仍未完成：');dueToday.slice(0,30).forEach((todo,index)=>lines.push(`${index+1}. ${todo.title}`));}
  if(activities.length){lines.push('工作台关键动作：');activities.slice(0,20).forEach((activity,index)=>lines.push(`${index+1}. ${activity.text}`));}
  if(String(notes||'').trim())lines.push(`补充：${String(notes).trim().slice(0,4000)}`);
  if(!completed.length&&!dueToday.length&&!activities.length&&!String(notes||'').trim())lines.push('今天暂无可沉淀的完成事项或工作台关键动作。');
  return lines.join('\n');
}

async function recordSyncError(store,error){
  await store.updateConfig(config=>{
    const current={...(config.settings?.[SETTINGS_KEY]||{})};
    config.settings={...(config.settings||{}),[SETTINGS_KEY]:{
      ...current,lastSyncAt:nowIso(),lastSyncStatus:'error',lastSyncError:compactText(error?.message||'同步失败',300)
    }};
    return true;
  }).catch(()=>{});
}

export async function syncExternalTasks({
  store,
  taskClient=createTaskCliClient(),
  journalClient=createFeishuDailyJournalClient(),
  calendarWriter=writeLocalCalendar
}={}){
  const config=await store.readConfig();
  const integration=integrationFromConfig(config);
  if(!integration.enabled)throw new ExternalTaskIntegrationError('滴答 CLI 待办来源尚未启用。',{code:'EXTERNAL_TASK_INTEGRATION_NOT_CONFIGURED',statusCode:409});
  const date=todayIso();
  try{
    const source=await taskClient.fetch(integration);
    const snapshot=taskSnapshotText(source,date);
    const journalOp=operationId('tasks',date,{
      active:source.active.map(task=>[task.externalId,task.title,task.dueAt,task.updatedAt]),
      completed:source.completed.map(task=>[task.externalId,task.completedAt,task.updatedAt])
    });
    const journal=await journalClient.appendTasks(integration.journalDocumentUrl,snapshot,{
      operationId:journalOp,heading:integration.journalHeading
    });
    const calendar=integration.calendarEnabled
      ?await calendarWriter({store,tasks:source.active,calendarName:integration.calendarName})
      :{enabled:false,path:null,eventCount:0,writtenAt:null};
    let changes;
    await store.updateState(state=>{
      changes=applyTaskSnapshot(state,source);
      addActivity(state,{
        type:'external_tasks_synced',
        text:`滴答待办已同步：新增 ${changes.created}，更新 ${changes.updated}，完成 ${changes.completed}，无截止日期 ${changes.undated}；飞书日记已读回${calendar.enabled?'，本机日历已更新':''}。`
      });
      return changes;
    });
    await store.updateConfig(current=>{
      const previous=current.settings?.[SETTINGS_KEY]||{};
      current.settings={...(current.settings||{}),[SETTINGS_KEY]:{
        ...previous,
        lastSyncAt:nowIso(),lastSyncStatus:'ok',lastSyncError:null,
        lastImportedCount:source.active.length,lastCompletedCount:source.completed.length,
        lastUndatedCount:source.active.filter(task=>!task.dueDate).length,
        lastJournalAt:nowIso(),lastJournalBlockId:journal.item?.blockId||null,
        lastCalendarAt:calendar.writtenAt,lastCalendarPath:calendar.path,
        lastCalendarEventCount:calendar.eventCount
      }};
      return true;
    });
    return{
      provider:'dida_cli',cliFlavor:source.cliFlavor,fetchedAt:source.fetchedAt,
      activeCount:source.active.length,completedCount:source.completed.length,
      completedAvailable:source.completedAvailable,completedWarning:source.completedWarning,
      changes,journal:{operationId:journalOp,blockId:journal.item?.blockId||null,replayed:Boolean(journal.replayed)},
      calendar
    };
  }catch(error){
    await recordSyncError(store,error);
    if(error instanceof ExternalTaskSourceError||error instanceof ExternalTaskIntegrationError)throw error;
    throw new ExternalTaskIntegrationError(error.message||'滴答待办同步失败。',{cause:error,code:error.code||'EXTERNAL_TASK_INTEGRATION_FAILED',statusCode:error.statusCode||500});
  }
}

export async function publishDailySummary({
  store,
  notes='',
  date=todayIso(),
  journalClient=createFeishuDailyJournalClient()
}={}){
  const config=await store.readConfig();
  const integration=integrationFromConfig(config);
  if(!integration.enabled)throw new ExternalTaskIntegrationError('滴答 CLI 待办来源尚未启用。',{code:'EXTERNAL_TASK_INTEGRATION_NOT_CONFIGURED',statusCode:409});
  const state=await store.readState();
  const text=summaryText(state,date,notes);
  const op=operationId('summary',date,text);
  const journal=await journalClient.appendSummary(integration.journalDocumentUrl,text,{
    operationId:op,heading:integration.journalHeading
  });
  await store.updateState(current=>{
    addActivity(current,{type:'daily_summary_published',text:`${date} 的每日总结已沉淀到飞书工作日记。`});
  });
  await store.updateConfig(current=>{
    const previous=current.settings?.[SETTINGS_KEY]||{};
    current.settings={...(current.settings||{}),[SETTINGS_KEY]:{
      ...previous,lastSummaryAt:nowIso(),lastSummaryBlockId:journal.item?.blockId||null
    }};
    return true;
  });
  return{date,operationId:op,blockId:journal.item?.blockId||null,replayed:Boolean(journal.replayed)};
}
