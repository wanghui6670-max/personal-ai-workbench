import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DIRECTORY_MODE=0o700;
const FILE_MODE=0o600;
const CALENDAR_FILE='personal-ai-workbench.ics';

export class LocalCalendarError extends Error{
  constructor(message,{cause,code='LOCAL_CALENDAR_WRITE_FAILED',statusCode=500}={}){
    super(message,{cause});
    this.name='LocalCalendarError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function escapeText(value){
  return String(value??'')
    .replace(/\\/g,'\\\\')
    .replace(/\r?\n/g,'\\n')
    .replace(/,/g,'\\,')
    .replace(/;/g,'\\;');
}

function foldLine(line){
  const chunks=[];
  let current='';
  let bytes=0;
  for(const char of line){
    const size=Buffer.byteLength(char);
    if(bytes+size>73&&current){chunks.push(current);current=' ';bytes=1;}
    current+=char;
    bytes+=size;
  }
  if(current)chunks.push(current);
  return chunks.join('\r\n');
}

function addDays(dateOnly,days){
  const date=new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10).replaceAll('-','');
}

function utcStamp(value){
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return null;
  return date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
}

function hasExplicitTime(value){
  return typeof value==='string'&&/[T ]\d{2}:\d{2}/.test(value);
}

function eventUid(externalId){
  return `paw-${crypto.createHash('sha256').update(String(externalId)).digest('hex').slice(0,32)}@personal-ai-workbench`;
}

function eventLines(task,calendarName,generatedAt){
  if(task.done||!task.dueDate)return null;
  const lines=['BEGIN:VEVENT',`UID:${eventUid(task.externalId)}`,`DTSTAMP:${generatedAt}`];
  const timed=hasExplicitTime(task.startAt)&&hasExplicitTime(task.dueAt);
  const start=timed?utcStamp(task.startAt):null;
  const end=timed?utcStamp(task.dueAt):null;
  if(start&&end&&new Date(task.dueAt)>new Date(task.startAt)){
    lines.push(`DTSTART:${start}`,`DTEND:${end}`);
  }else{
    const date=task.dueDate.replaceAll('-','');
    lines.push(`DTSTART;VALUE=DATE:${date}`,`DTEND;VALUE=DATE:${addDays(task.dueDate,1)}`);
  }
  lines.push(
    `SUMMARY:${escapeText(task.title)}`,
    `DESCRIPTION:${escapeText(`来源：滴答清单 CLI\n外部任务 ID：${task.externalId}${task.dueAt?`\n原始截止：${task.dueAt}`:''}${task.content?`\n${task.content}`:''}`)}`,
    `CATEGORIES:${escapeText(calendarName)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT'
  );
  return lines;
}

export function buildLocalCalendar(tasks,{calendarName='个人 AI 工作台',generatedAt=new Date()}={}){
  const stamp=(generatedAt instanceof Date?generatedAt:new Date(generatedAt)).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const eligible=[...tasks]
    .filter(task=>task&&!task.done&&task.dueDate&&task.externalId&&task.title)
    .sort((a,b)=>String(a.dueDate).localeCompare(String(b.dueDate))||String(a.externalId).localeCompare(String(b.externalId)));
  const lines=[
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Personal AI Workbench//Dida CLI Calendar//ZH-CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`
  ];
  for(const task of eligible){
    const event=eventLines(task,calendarName,stamp);
    if(event)lines.push(...event);
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

async function assertSafeDirectory(target){
  let stat;
  try{stat=await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new LocalCalendarError('本机日历目录必须是普通目录，不能是符号链接。',{code:'UNSAFE_LOCAL_CALENDAR_PATH'});
  return stat;
}

async function assertSafeFile(target){
  let stat;
  try{stat=await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(stat.isSymbolicLink()||!stat.isFile())throw new LocalCalendarError('本机日历文件必须是普通文件，不能是符号链接。',{code:'UNSAFE_LOCAL_CALENDAR_PATH'});
  return stat;
}

export function localCalendarPath(store){
  if(!store?.dataDir)throw new LocalCalendarError('工作台数据目录不可用。');
  return path.join(store.dataDir,'calendar',CALENDAR_FILE);
}

export async function writeLocalCalendar({store,tasks,calendarName='个人 AI 工作台'}={}){
  const target=localCalendarPath(store);
  const directory=path.dirname(target);
  try{
    const existingDirectory=await assertSafeDirectory(directory);
    if(!existingDirectory)await fsp.mkdir(directory,{recursive:true,mode:DIRECTORY_MODE});
    await assertSafeDirectory(directory);
    await fsp.chmod(directory,DIRECTORY_MODE);
    await assertSafeFile(target);
    const content=buildLocalCalendar(tasks,{calendarName});
    const tmp=`${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp,content,{encoding:'utf8',flag:'wx',mode:FILE_MODE});
    await fsp.chmod(tmp,FILE_MODE);
    await assertSafeFile(target);
    await fsp.rename(tmp,target);
    await fsp.chmod(target,FILE_MODE);
    const eventCount=(content.match(/BEGIN:VEVENT/g)||[]).length;
    return {enabled:true,path:target,eventCount,writtenAt:new Date().toISOString()};
  }catch(error){
    if(error instanceof LocalCalendarError)throw error;
    throw new LocalCalendarError('本机日历文件写入失败。',{cause:error});
  }
}
