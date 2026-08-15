import crypto from 'node:crypto';
import {createGetnoteReader,GetnoteRuntimeError} from './getnote-runtime.mjs';

const PAGE_SIZE=20;
const DEFAULT_NOTE_LIMIT=100;
const MAX_NOTE_LIMIT=500;
const DEFAULT_TIME_ZONE='Asia/Shanghai';
const MAX_TRACKED_NOTES=500;

export class ExternalTaskSourceError extends Error{
  constructor(message,{cause,code='EXTERNAL_TASK_SOURCE_UNAVAILABLE',statusCode=502}={}){
    super(message,{cause});
    this.name='ExternalTaskSourceError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function firstText(...values){
  for(const value of values){
    if(value===undefined||value===null)continue;
    const text=String(value).trim();
    if(text)return text;
  }
  return null;
}

function normalizeText(value){return String(value??'').replace(/\s+/g,' ').trim();}
function pad(value){return String(value).padStart(2,'0');}
function validDate(year,month,day){
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}
function referenceDateOnly(value,fallbackDateOnly=null,timeZone=DEFAULT_TIME_ZONE){
  const text=String(value||'').trim();
  const direct=text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(direct&&validDate(Number(direct[1]),Number(direct[2]),Number(direct[3])))return `${direct[1]}-${direct[2]}-${direct[3]}`;
  if(text){
    const offsetTimestamp=/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    if(offsetTimestamp){
      const date=new Date(text);
      if(Number.isFinite(date.getTime()))return getnoteDateOnlyInTimeZone(date,timeZone);
    }
    const localPrefix=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T])/);
    if(localPrefix&&validDate(Number(localPrefix[1]),Number(localPrefix[2]),Number(localPrefix[3])))return `${localPrefix[1]}-${localPrefix[2]}-${localPrefix[3]}`;
    const date=new Date(text);
    if(Number.isFinite(date.getTime()))return getnoteDateOnlyInTimeZone(date,timeZone);
  }
  if(fallbackDateOnly&&/^\d{4}-\d{2}-\d{2}$/.test(fallbackDateOnly))return fallbackDateOnly;
  return getnoteDateOnlyInTimeZone(new Date(),timeZone);
}
function addDays(dateOnly,days){
  const date=new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
function monthDayInReferenceYear(month,day,referenceDate){return validDate(Number(referenceDate.slice(0,4)),month,day);}
function parseDate(text,referenceDate){
  const fullChinese=text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if(fullChinese)return validDate(Number(fullChinese[1]),Number(fullChinese[2]),Number(fullChinese[3]));
  const fullNumeric=text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if(fullNumeric)return validDate(Number(fullNumeric[1]),Number(fullNumeric[2]),Number(fullNumeric[3]));
  const monthDay=text.match(/(?:^|\D)(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if(monthDay)return monthDayInReferenceYear(Number(monthDay[1]),Number(monthDay[2]),referenceDate);
  if(/后天/.test(text))return addDays(referenceDate,2);
  if(/明天|明日/.test(text))return addDays(referenceDate,1);
  if(/今天|今日/.test(text))return referenceDate;
  return null;
}
function parseTime(text){
  const clock=text.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/);
  if(clock)return `${pad(Number(clock[1]))}:${clock[2]}`;
  const chinese=text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*点(?:\s*(半|[0-5]?\d)\s*分?)?/);
  if(!chinese)return null;
  const period=chinese[1]||'';
  let hour=Number(chinese[2]);
  if(hour>24)return null;
  if(['下午','傍晚','晚上'].includes(period)&&hour<12)hour+=12;
  if(period==='中午'&&hour<11)hour+=12;
  if(period==='凌晨'&&hour===12)hour=0;
  if(['早上','上午'].includes(period)&&hour===12)hour=0;
  if(hour===24)hour=0;
  const minute=chinese[3]==='半'?30:Number(chinese[3]||0);
  return `${pad(hour)}:${pad(minute)}`;
}

export function normalizeGetnoteTimeZone(value=DEFAULT_TIME_ZONE){
  const timeZone=String(value||DEFAULT_TIME_ZONE).trim();
  if(!timeZone||timeZone.length>100)throw new ExternalTaskSourceError('得到大脑任务时区无效。',{code:'INVALID_EXTERNAL_TASK_SOURCE',statusCode:400});
  try{new Intl.DateTimeFormat('en-US',{timeZone}).format(new Date('2026-01-01T00:00:00Z'));}
  catch(error){throw new ExternalTaskSourceError(`得到大脑任务时区无效：${timeZone}`,{cause:error,code:'INVALID_EXTERNAL_TASK_SOURCE',statusCode:400});}
  return timeZone;
}

export function getnoteDateOnlyInTimeZone(value=new Date(),timeZone=DEFAULT_TIME_ZONE){
  const zone=normalizeGetnoteTimeZone(timeZone);
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.getTime()))throw new ExternalTaskSourceError('得到大脑任务日期基准无效。',{code:'INVALID_EXTERNAL_TASK_SOURCE',statusCode:400});
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:zone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(date);
  const fields=Object.fromEntries(parts.filter(part=>['year','month','day'].includes(part.type)).map(part=>[part.type,part.value]));
  if(!fields.year||!fields.month||!fields.day)throw new ExternalTaskSourceError('得到大脑任务日期基准无法按时区解析。',{code:'INVALID_EXTERNAL_TASK_SOURCE',statusCode:500});
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function parseTodoSchedule(text,{referenceDate=null,timeZone=DEFAULT_TIME_ZONE}={}){
  const zone=normalizeGetnoteTimeZone(timeZone);
  const fallback=getnoteDateOnlyInTimeZone(new Date(),zone);
  const base=referenceDateOnly(referenceDate,fallback,zone);
  const dueDate=parseDate(String(text||''),base);
  if(!dueDate)return{dueDate:null,dueAt:null,startAt:null,allDay:true,timeZone:zone};
  const time=parseTime(String(text||''));
  return{
    dueDate,
    dueAt:time?`${dueDate}T${time}:00`:dueDate,
    startAt:null,
    allDay:!time,
    timeZone:zone
  };
}

function assertSuccessful(payload){
  if(payload&&typeof payload==='object'&&!Array.isArray(payload)&&payload.success===false){
    const message=firstText(payload.message,payload.reason,payload.error?.message,payload.error)||'得到大脑 API 返回失败。';
    throw new ExternalTaskSourceError(message,{code:'EXTERNAL_TASK_SOURCE_REJECTED'});
  }
  return payload;
}

function normalizeNote(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const noteId=firstText(raw.note_id,raw.noteId,raw.id,raw.sourceNoteId);
  if(!noteId)return null;
  return{
    noteId,
    title:firstText(raw.title,raw.sourceNoteTitle)||'未命名笔记',
    noteType:firstText(raw.note_type,raw.noteType,raw.sourceNoteType)||'',
    createdAt:firstText(raw.created_at,raw.createdAt,raw.sourceNoteCreatedAt),
    updatedAt:firstText(raw.updated_at,raw.updatedAt,raw.sourceNoteUpdatedAt,raw.externalUpdatedAt),
    noteUrl:firstText(raw.note_url,raw.noteUrl,raw.sourceNoteUrl)||''
  };
}

export function parseNotesPage(payload){
  const value=assertSuccessful(payload);
  const data=value?.data&&typeof value.data==='object'?value.data:value;
  const rawNotes=Array.isArray(data?.notes)?data.notes:Array.isArray(data?.items)?data.items:[];
  const notes=rawNotes.map(normalizeNote).filter(Boolean);
  return{
    notes,
    hasMore:data?.has_more===true||data?.hasMore===true,
    cursor:firstText(data?.cursor,data?.next_cursor,data?.nextCursor)
  };
}

function todoContainer(payload){
  const value=assertSuccessful(payload);
  const data=value?.data&&typeof value.data==='object'?value.data:value;
  const container=data?.meeting_todos??data?.meetingTodos??value?.meeting_todos??value?.meetingTodos??{};
  return{data,container:container&&typeof container==='object'?container:{}};
}
function stableExternalId(noteId,text,occurrence){
  const normalized=text.toLocaleLowerCase('zh-CN');
  return `getnote-${crypto.createHash('sha256').update(`${noteId}\0${normalized}\0${occurrence}`).digest('hex').slice(0,32)}`;
}

export function parseMeetingTodos(payload,note={},options={}){
  const {data,container}=todoContainer(payload);
  const noteId=firstText(data?.note_id,data?.noteId,note.noteId,note.id);
  if(!noteId)throw new ExternalTaskSourceError('得到大脑待办结果缺少 note_id。',{code:'EXTERNAL_TASK_SOURCE_SCHEMA'});
  const noteTitle=firstText(data?.title,note.title)||'未命名笔记';
  const noteUrl=firstText(data?.note_url,data?.noteUrl,note.noteUrl)||'';
  const source=firstText(container.source)||'meeting_summary';
  const items=Array.isArray(container.items)?container.items:[];
  const timeZone=normalizeGetnoteTimeZone(options.timeZone||DEFAULT_TIME_ZONE);
  const fallbackReferenceDate=getnoteDateOnlyInTimeZone(new Date(),timeZone);
  const referenceDate=referenceDateOnly(note.createdAt||note.updatedAt||'',fallbackReferenceDate,timeZone);
  const occurrences=new Map();
  const tasks=[];
  for(const item of items){
    const text=normalizeText(typeof item==='string'?item:item?.text);
    if(!text)continue;
    const normalized=text.toLocaleLowerCase('zh-CN');
    const occurrence=occurrences.get(normalized)||0;
    occurrences.set(normalized,occurrence+1);
    const externalId=stableExternalId(noteId,text,occurrence);
    const schedule=parseTodoSchedule(text,{referenceDate,timeZone});
    tasks.push({
      externalId,
      externalIdentityKind:'text_fingerprint',
      title:text,
      content:'',
      description:'',
      done:typeof item==='object'&&item?.completed===true,
      completedAt:typeof item==='object'&&item?.completed===true?(note.updatedAt||note.createdAt||null):null,
      updatedAt:note.updatedAt||note.createdAt||null,
      priority:0,
      priorityLabel:'',
      tags:[],
      ...schedule,
      sourceNoteId:noteId,
      sourceNoteTitle:noteTitle,
      sourceNoteUrl:noteUrl,
      sourceNoteType:note.noteType||'',
      sourceNoteCreatedAt:note.createdAt||null,
      sourceNoteUpdatedAt:note.updatedAt||null,
      todoSource:source
    });
  }
  return tasks;
}

export function normalizeNoteLimit(value){
  const number=Number(value??DEFAULT_NOTE_LIMIT);
  if(!Number.isInteger(number)||number<20||number>MAX_NOTE_LIMIT){
    throw new ExternalTaskSourceError(`得到大脑最近笔记扫描数量必须是 20-${MAX_NOTE_LIMIT} 的整数。`,{code:'INVALID_EXTERNAL_TASK_SOURCE',statusCode:400});
  }
  return number;
}

function sourceError(error,action){
  if(error instanceof ExternalTaskSourceError)return error;
  if(error instanceof GetnoteRuntimeError){
    return new ExternalTaskSourceError(`得到大脑 ${action}失败：${error.message}`,{cause:error,code:error.code,statusCode:error.statusCode});
  }
  return new ExternalTaskSourceError(`得到大脑 ${action}失败。`,{cause:error});
}
async function runtimeCall(action,fn){try{return await fn();}catch(error){throw sourceError(error,action);}}

async function listRecentNotes(noteLimit,reader){
  const notes=[];
  const seenCursors=new Set();
  let cursor=null;
  while(notes.length<noteLimit){
    const pageLimit=Math.min(PAGE_SIZE,noteLimit-notes.length);
    const payload=await runtimeCall('读取最近笔记',()=>reader.listNotes({limit:pageLimit,cursor}));
    const page=parseNotesPage(payload);
    notes.push(...page.notes);
    if(!page.hasMore||!page.cursor||seenCursors.has(page.cursor)||page.notes.length===0)break;
    seenCursors.add(page.cursor);
    cursor=page.cursor;
  }
  return notes.slice(0,noteLimit);
}
function normalizeTrackedNotes(value){
  if(!Array.isArray(value))return[];
  const notes=new Map();
  for(const raw of value.slice(0,MAX_TRACKED_NOTES)){
    const note=normalizeNote(raw);if(note&&!notes.has(note.noteId))notes.set(note.noteId,note);
  }
  return [...notes.values()];
}

export function createTaskCliClient({reader=null,exec,timeoutMs,env=process.env,fetchImpl}={}){
  const runtime=reader||createGetnoteReader({env,exec,timeoutMs,fetchImpl});
  return{
    async fetch(config={}){
      const noteLimit=normalizeNoteLimit(config.noteLimit);
      const timeZone=normalizeGetnoteTimeZone(config.timeZone||DEFAULT_TIME_ZONE);
      const recentNotes=await listRecentNotes(noteLimit,runtime);
      const notesById=new Map(recentNotes.map(note=>[note.noteId,note]));
      let trackedNoteCount=0;
      for(const note of normalizeTrackedNotes(config.trackedNotes)){
        if(notesById.has(note.noteId))continue;
        notesById.set(note.noteId,note);trackedNoteCount+=1;
      }
      const notes=[...notesById.values()];
      const parsed=[];
      for(const note of notes){
        const payload=await runtimeCall(`读取笔记“${note.title}”的待办`,()=>runtime.fetchTodos(note.noteId));
        parsed.push(...parseMeetingTodos(payload,note,{timeZone}));
      }
      const unique=new Map();
      for(const task of parsed)unique.set(task.externalId,task);
      const tasks=[...unique.values()];
      return{
        provider:'getnote_cli',
        runtimeMode:runtime.status?.().mode||'unknown',
        noteCount:notes.length,
        recentNoteCount:recentNotes.length,
        trackedNoteCount,
        todoCount:tasks.length,
        active:tasks.filter(task=>!task.done),
        completed:tasks.filter(task=>task.done),
        completedAvailable:true,
        completedWarning:null,
        fetchedAt:new Date().toISOString()
      };
    }
  };
}
