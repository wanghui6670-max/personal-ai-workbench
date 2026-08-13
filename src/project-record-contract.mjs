import crypto from 'node:crypto';

export const PROJECT_RECORD_HEADING='项目分析与总结';
export const PROJECT_ANALYSIS_PREFIX='[WORKBENCH_ANALYSIS]';
export const PROJECT_SUMMARY_PREFIX='[WORKBENCH_SUMMARY]';
export const PROJECT_RECORD_TEXT_MAX=6_000;
export const PROJECT_RECORD_READ_DEFAULT=20;
export const PROJECT_RECORD_READ_MAX=100;

const SAFE_OPERATION_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FEISHU_DOCUMENT_PATH=/^\/(?:wiki|docx|docs)\/[A-Za-z0-9_-]+\/?$/;
const FEISHU_HOSTS=['feishu.cn','larksuite.com','larkoffice.com'];

function contractError(message,code='INVALID_FEISHU_PROJECT_DOCUMENT'){
  return Object.assign(new Error(message),{statusCode:400,code});
}

export function normalizeFeishuProjectDocumentUrl(value,{allowEmpty=false}={}){
  const raw=String(value??'').trim();
  if(!raw&&allowEmpty)return '';
  if(!raw)throw contractError('飞书项目文档 URL 不能为空。');
  let url;
  try{url=new URL(raw);}catch{throw contractError('飞书项目文档 URL 无效。');}
  const hostname=url.hostname.toLowerCase();
  const official=FEISHU_HOSTS.some(root=>hostname===root||hostname.endsWith(`.${root}`));
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!official||!FEISHU_DOCUMENT_PATH.test(url.pathname)){
    throw contractError('项目文档必须是官方飞书/Lark HTTPS 云文档链接，且不能包含凭证、查询参数或片段。');
  }
  return `${url.origin}${url.pathname.replace(/\/$/,'')}`;
}

export function isFeishuProjectDocumentUrl(value){
  try{normalizeFeishuProjectDocumentUrl(value);return true;}catch{return false;}
}

export function normalizeProjectRecordText(value){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  if(!text)throw contractError('飞书项目记录不能为空。','INVALID_FEISHU_PROJECT_RECORD');
  if(text.length>PROJECT_RECORD_TEXT_MAX)throw contractError(`飞书项目记录不能超过 ${PROJECT_RECORD_TEXT_MAX} 个字符。`,'INVALID_FEISHU_PROJECT_RECORD');
  return text;
}

export function normalizeProjectRecordOperationId(value){
  const operationId=String(value??'').trim();
  if(!SAFE_OPERATION_ID.test(operationId))throw contractError('项目记录 operationId 格式无效。','INVALID_FEISHU_PROJECT_RECORD');
  return operationId;
}

function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  return value;
}

export function projectRecordOperationId(kind,payload){
  if(!['analysis','summary','migration'].includes(kind))throw contractError('项目记录操作类型无效。','INVALID_FEISHU_PROJECT_RECORD');
  const digest=crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex').slice(0,40);
  return `${kind==='analysis'?'pa':kind==='summary'?'ps':'pm'}_${digest}`;
}

export function projectRecordMarker(operationId){
  return `[WORKBENCH_OP:${normalizeProjectRecordOperationId(operationId)}]`;
}

export function clearProjectRecordPointer(progress={}){
  if(!progress||typeof progress!=='object'||Array.isArray(progress))return progress;
  const next={...progress};
  delete next.feishuRevisionId;
  delete next.feishuRecordBlockId;
  delete next.feishuRecordedAt;
  delete next.feishuOperationId;
  return next;
}

export function boundedProjectRecordLimit(value){
  if(value===undefined||value===null||value==='')return PROJECT_RECORD_READ_DEFAULT;
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<1)throw contractError('项目记录 limit 必须是正整数。','INVALID_FEISHU_PROJECT_RECORD');
  return Math.min(PROJECT_RECORD_READ_MAX,parsed);
}

export { FEISHU_HOSTS };
