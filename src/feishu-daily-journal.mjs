import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeFeishuProjectDocumentUrl } from './project-record-contract.mjs';

const execFileAsync=promisify(execFile);
const DEFAULT_TIMEOUT_MS=30_000;
const MAX_BUFFER=4*1024*1024;
const SAFE_OPERATION_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const DAILY_JOURNAL_HEADING='每日工作日记';
export const DAILY_TASKS_PREFIX='[WORKBENCH_DAILY_TODOS]';
export const DAILY_SUMMARY_PREFIX='[WORKBENCH_DAILY_SUMMARY]';

export class FeishuDailyJournalError extends Error{
  constructor(message,{cause,code='FEISHU_DAILY_JOURNAL_UNAVAILABLE',statusCode=502}={}){
    super(message,{cause});
    this.name='FeishuDailyJournalError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function decodeXmlText(value){
  return String(value??'')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<[^>]+>/g,'')
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"')
    .replace(/&#39;|&apos;/g,"'")
    .replace(/&amp;/g,'&')
    .replace(/[ \t]+/g,' ')
    .replace(/\s*\n\s*/g,'\n')
    .trim();
}

function escapeXml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'
  }[char]));
}

function escapeRegExp(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

function extractJson(stdout){
  const raw=String(stdout??'').replace(/^\uFEFF/,'').trim();
  if(!raw)throw new FeishuDailyJournalError('飞书 CLI 没有返回内容。');
  try{return JSON.parse(raw);}catch{}
  const start=raw.indexOf('{');
  const end=raw.lastIndexOf('}');
  if(start>=0&&end>start){
    try{return JSON.parse(raw.slice(start,end+1));}catch{}
  }
  throw new FeishuDailyJournalError('飞书 CLI 返回内容无法解析。',{code:'FEISHU_DAILY_JOURNAL_INVALID_JSON'});
}

function documentContent(payload){
  const document=payload?.data?.document;
  if(typeof document?.content!=='string')throw new FeishuDailyJournalError('飞书文档读回结果缺少正文。',{code:'FEISHU_DAILY_JOURNAL_FORMAT'});
  return {content:document.content,revisionId:document.revision_id??null,documentId:document.document_id??null};
}

function normalizeUrl(value){
  try{return normalizeFeishuProjectDocumentUrl(value);}
  catch(error){throw new FeishuDailyJournalError(error.message,{cause:error,code:error.code||'INVALID_FEISHU_JOURNAL',statusCode:error.statusCode||400});}
}

function normalizeOperationId(value){
  const operationId=String(value??'').trim();
  if(!SAFE_OPERATION_ID.test(operationId))throw new FeishuDailyJournalError('飞书日记 operationId 格式无效。',{code:'INVALID_FEISHU_JOURNAL_OPERATION',statusCode:400});
  return operationId;
}

function cliError(error,action){
  if(error instanceof FeishuDailyJournalError)return error;
  const message=error?.code==='ENOENT'
    ?'未找到 lark-cli，请在安装并登录 lark-cli 的本机运行工作台。'
    :`飞书日记${action}失败，请检查登录状态和文档权限。`;
  return new FeishuDailyJournalError(message,{cause:error});
}

async function runCli(args,action,{exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  try{
    const result=await exec('lark-cli',args,{timeout:timeoutMs,maxBuffer:MAX_BUFFER,windowsHide:true});
    return extractJson(result.stdout);
  }catch(error){throw cliError(error,action);}
}

async function fetchDocument(documentUrl,options){
  const url=normalizeUrl(documentUrl);
  const payload=await runCli([
    'docs','+fetch','--api-version','v2','--as','user','--doc',url,
    '--detail','with-ids','--format','json'
  ],'读取',options);
  return {...documentContent(payload),url};
}

async function updateDocument(documentUrl,{anchorBlockId,content},options){
  const url=normalizeUrl(documentUrl);
  if(!String(anchorBlockId||'').trim())throw new FeishuDailyJournalError('飞书日记缺少写入锚点。',{code:'FEISHU_DAILY_JOURNAL_FORMAT'});
  await runCli([
    'docs','+update','--api-version','v2','--as','user','--doc',url,
    '--command','block_insert_after','--block-id',String(anchorBlockId),
    '--content',content,'--format','json'
  ],'写入',options);
}

function lastDocumentBlockId(xml){
  const pattern=/<(?:title|h1|h2|h3|p|checkbox|li)\b([^>]*)>/gi;
  let match,last=null;
  while((match=pattern.exec(String(xml??'')))){
    const id=match[1].match(/\bid=["']([^"']+)["']/i)?.[1]||null;
    if(id)last=id;
  }
  return last;
}

export function parseFeishuDailyJournalXml(xml,{heading=DAILY_JOURNAL_HEADING}={}){
  const source=String(xml??'');
  const headingPattern=new RegExp(`<h1\\b[^>]*>${escapeRegExp(heading)}<\\/h1\\s*>`,'i');
  const headingMatch=headingPattern.exec(source);
  if(!headingMatch)return{sectionFound:false,headingBlockId:null,items:[]};
  const afterHeading=source.slice(headingMatch.index+headingMatch[0].length);
  const nextHeading=/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/i.exec(afterHeading);
  const section=nextHeading?afterHeading.slice(0,nextHeading.index):afterHeading;
  const blockPattern=/<(p|checkbox|li)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  const items=[];
  let match;
  while((match=blockPattern.exec(section))){
    const rawText=decodeXmlText(match[3]);
    let kind=null,prefix=null;
    if(rawText.startsWith(DAILY_TASKS_PREFIX)){kind='tasks';prefix=DAILY_TASKS_PREFIX;}
    else if(rawText.startsWith(DAILY_SUMMARY_PREFIX)){kind='summary';prefix=DAILY_SUMMARY_PREFIX;}
    else continue;
    let value=rawText.slice(prefix.length).trim();
    const opMatch=value.match(/^\[WORKBENCH_OP:([A-Za-z0-9][A-Za-z0-9_-]{0,127})\]\s*/);
    const operationId=opMatch?.[1]||null;
    if(opMatch)value=value.slice(opMatch[0].length).trim();
    const blockId=match[2].match(/\bid=["']([^"']+)["']/i)?.[1]||null;
    if(!blockId||!value)continue;
    items.push({blockId,kind,operationId,text:value,rawText,tag:match[1].toLowerCase()});
  }
  const unique=new Map(items.map(item=>[item.blockId,item]));
  const headingBlockId=headingMatch[0].match(/\bid=["']([^"']+)["']/i)?.[1]||null;
  return{sectionFound:true,headingBlockId,items:[...unique.values()]};
}

function normalizeText(value){
  const text=String(value??'').replace(/\r\n/g,'\n').trim();
  if(!text)throw new FeishuDailyJournalError('飞书日记正文不能为空。',{code:'INVALID_FEISHU_DAILY_JOURNAL',statusCode:400});
  if(text.length>20_000)throw new FeishuDailyJournalError('飞书日记正文不能超过 20000 个字符。',{code:'INVALID_FEISHU_DAILY_JOURNAL',statusCode:400});
  return text;
}

export function createFeishuDailyJournalClient({exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  const options={exec,timeoutMs};
  async function fetchRecords(documentUrl,{heading=DAILY_JOURNAL_HEADING}={}){
    const document=await fetchDocument(documentUrl,options);
    return{...document,...parseFeishuDailyJournalXml(document.content,{heading}),heading};
  }
  async function ensureSection(documentUrl,heading){
    let current=await fetchRecords(documentUrl,{heading});
    if(current.sectionFound&&current.headingBlockId)return current;
    const anchor=lastDocumentBlockId(current.content);
    if(!anchor)throw new FeishuDailyJournalError('飞书文档缺少可创建“每日工作日记”章节的锚点。',{code:'FEISHU_DAILY_JOURNAL_FORMAT'});
    await updateDocument(documentUrl,{anchorBlockId:anchor,content:`<h1>${escapeXml(heading)}</h1>`},options);
    current=await fetchRecords(documentUrl,{heading});
    if(!current.sectionFound||!current.headingBlockId)throw new FeishuDailyJournalError('飞书日记章节创建后读回失败。',{code:'FEISHU_DAILY_JOURNAL_READBACK_FAILED'});
    return current;
  }
  async function append(documentUrl,{kind,text,operationId,heading=DAILY_JOURNAL_HEADING}={}){
    if(!['tasks','summary'].includes(kind))throw new FeishuDailyJournalError('飞书日记记录类型无效。',{code:'INVALID_FEISHU_DAILY_JOURNAL',statusCode:400});
    const value=normalizeText(text);
    const op=normalizeOperationId(operationId);
    const url=normalizeUrl(documentUrl);
    const current=await ensureSection(url,heading);
    const existing=current.items.filter(item=>item.kind===kind&&item.operationId===op);
    if(existing.length>1)throw new FeishuDailyJournalError('飞书日记中存在重复 operationId，需要人工核对。',{code:'FEISHU_DAILY_JOURNAL_DUPLICATE_OPERATION',statusCode:409});
    if(existing.length===1)return{...current,item:existing[0],replayed:true,operationId:op};
    const anchor=current.items.at(-1)?.blockId||current.headingBlockId;
    const prefix=kind==='tasks'?DAILY_TASKS_PREFIX:DAILY_SUMMARY_PREFIX;
    await updateDocument(url,{
      anchorBlockId:anchor,
      content:`<p>${escapeXml(`${prefix} [WORKBENCH_OP:${op}] ${value}`)}</p>`
    },options);
    const fetched=await fetchRecords(url,{heading});
    const matches=fetched.items.filter(item=>item.kind===kind&&item.operationId===op);
    if(matches.length!==1)throw new FeishuDailyJournalError('飞书日记写入后无法唯一读回 operationId。',{code:'FEISHU_DAILY_JOURNAL_READBACK_FAILED'});
    return{...fetched,item:matches[0],replayed:false,operationId:op};
  }
  return{
    fetch:fetchRecords,
    appendTasks(documentUrl,text,options={}){return append(documentUrl,{...options,kind:'tasks',text});},
    appendSummary(documentUrl,text,options={}){return append(documentUrl,{...options,kind:'summary',text});}
  };
}
