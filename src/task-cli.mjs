import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const DEFAULT_TIMEOUT_MS=45_000;
const MAX_BUFFER=8*1024*1024;
const CLI_COMMAND='ticktick';
const CLI_PROFILES=Object.freeze({
  ticktick:{host:'ticktick.com'},
  dida365:{host:'dida365.com'}
});

export class ExternalTaskSourceError extends Error{
  constructor(message,{cause,code='EXTERNAL_TASK_SOURCE_UNAVAILABLE',statusCode=502}={}){
    super(message,{cause});
    this.name='ExternalTaskSourceError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function extractJson(stdout){
  const raw=String(stdout??'').replace(/^\uFEFF/,'').trim();
  if(!raw)throw new ExternalTaskSourceError('滴答 CLI 没有返回 JSON。',{code:'EXTERNAL_TASK_SOURCE_EMPTY'});
  try{return JSON.parse(raw);}catch{}
  const starts=[raw.indexOf('{'),raw.indexOf('[')].filter(index=>index>=0).sort((a,b)=>a-b);
  for(const start of starts){
    const close=raw[start]==='['?raw.lastIndexOf(']'):raw.lastIndexOf('}');
    if(close<=start)continue;
    try{return JSON.parse(raw.slice(start,close+1));}catch{}
  }
  throw new ExternalTaskSourceError('滴答 CLI 返回内容无法解析为 JSON。',{code:'EXTERNAL_TASK_SOURCE_INVALID_JSON'});
}

function taskArray(payload){
  if(Array.isArray(payload))return payload;
  for(const value of [payload?.tasks,payload?.items,payload?.data,payload?.result,payload?.data?.tasks,payload?.result?.tasks]){
    if(Array.isArray(value))return value;
  }
  throw new ExternalTaskSourceError('滴答 CLI JSON 缺少任务数组。',{code:'EXTERNAL_TASK_SOURCE_SCHEMA'});
}

function firstText(...values){
  for(const value of values){
    if(value===undefined||value===null)continue;
    const text=String(value).trim();
    if(text)return text;
  }
  return null;
}

function validDateOnly(value){
  if(typeof value!=='string')return null;
  const match=value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!match)return null;
  const date=`${match[1]}-${match[2]}-${match[3]}`;
  const parsed=Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===date?date:null;
}

function doneStatus(raw,forceDone=false){
  if(forceDone)return true;
  const label=String(raw?.status_label??raw?.statusLabel??raw?.state??'').toLowerCase();
  if(/completed|done|finished|已完成|完成/.test(label))return true;
  const status=raw?.status;
  return status===2||status==='2'||status===true;
}

export function normalizeCliTask(raw,{forceDone=false}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const externalId=firstText(raw.id,raw.task_id,raw.taskId);
  const title=firstText(raw.title,raw.name,raw.content);
  if(!externalId||!title)return null;
  const startAt=firstText(raw.start_local,raw.startLocal,raw.start_date,raw.startDate);
  const dueAt=firstText(raw.due_local,raw.dueLocal,raw.due_date,raw.dueDate);
  const dueDate=validDateOnly(dueAt);
  const content=firstText(raw.content,raw.description,raw.note)||'';
  const completedAt=firstText(raw.completed_time,raw.completedTime,raw.completed_at,raw.completedAt);
  const updatedAt=firstText(raw.modified_time,raw.modifiedTime,raw.updated_at,raw.updatedAt);
  return {
    externalId,
    externalProjectId:firstText(raw.project_id,raw.projectId),
    title,
    content,
    description:firstText(raw.description)||'',
    done:doneStatus(raw,forceDone),
    status:raw.status??null,
    statusLabel:firstText(raw.status_label,raw.statusLabel,raw.state)||'',
    priority:Number.isFinite(Number(raw.priority))?Number(raw.priority):0,
    priorityLabel:firstText(raw.priority_label,raw.priorityLabel)||'',
    startAt,
    dueAt,
    dueDate,
    allDay:raw.is_all_day===true||raw.isAllDay===true,
    timeZone:firstText(raw.time_zone,raw.timeZone),
    completedAt,
    updatedAt,
    tags:Array.isArray(raw.tags)?raw.tags.map(value=>String(value)):[]
  };
}

export function parseCliTasks(payload,{forceDone=false}={}){
  const unique=new Map();
  for(const raw of taskArray(payload)){
    const task=normalizeCliTask(raw,{forceDone});
    if(!task)continue;
    unique.set(task.externalId,task);
  }
  return [...unique.values()];
}

function cliError(error,profile,action){
  if(error instanceof ExternalTaskSourceError)return error;
  if(error?.code==='ENOENT'){
    return new ExternalTaskSourceError('未找到 ticktick CLI。请先在运行工作台的本机安装并登录滴答清单 CLI。',{cause:error,code:'EXTERNAL_TASK_CLI_MISSING'});
  }
  const region=profile.host==='dida365.com'?'国内版':'国际版';
  return new ExternalTaskSourceError(`滴答 CLI ${action}失败（${region}）。请检查登录状态、TICKTICK_HOST 和网络。`,{cause:error});
}

async function runJson(args,profile,action,{exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  try{
    const result=await exec(CLI_COMMAND,args,{
      timeout:timeoutMs,
      maxBuffer:MAX_BUFFER,
      windowsHide:true,
      env:{...process.env,TICKTICK_HOST:profile.host}
    });
    return extractJson(result.stdout);
  }catch(error){throw cliError(error,profile,action);}
}

export function normalizeCliFlavor(value){
  const flavor=String(value||'ticktick').trim().toLowerCase();
  if(!Object.hasOwn(CLI_PROFILES,flavor)){
    throw new ExternalTaskSourceError('滴答账户区域只支持 ticktick 或 dida365。',{code:'INVALID_EXTERNAL_TASK_SOURCE',statusCode:400});
  }
  return flavor;
}

export function createTaskCliClient({exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  return {
    async fetch(config={}){
      const cliFlavor=normalizeCliFlavor(config.cliFlavor);
      const profile=CLI_PROFILES[cliFlavor];
      await runJson(['sync','--json'],profile,'同步',{exec,timeoutMs});
      const activePayload=await runJson(['tasks','list','--json'],profile,'读取待办',{exec,timeoutMs});
      const active=parseCliTasks(activePayload,{forceDone:false}).filter(task=>!task.done);
      let completed=[];
      let completedAvailable=true;
      let completedWarning=null;
      try{
        const completedPayload=await runJson(['tasks','completed','--json'],profile,'读取已完成待办',{exec,timeoutMs});
        completed=parseCliTasks(completedPayload,{forceDone:true});
      }catch(error){
        completedAvailable=false;
        completedWarning=error.message;
      }
      const activeIds=new Set(active.map(task=>task.externalId));
      completed=completed.filter(task=>!activeIds.has(task.externalId));
      return {
        provider:'dida_cli',cliFlavor,host:profile.host,
        active,completed,completedAvailable,completedWarning,
        fetchedAt:new Date().toISOString()
      };
    }
  };
}
