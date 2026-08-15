import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
const CLI='getnote';
const DEFAULT_TIMEOUT_MS=45_000;
const MAX_BUFFER=16*1024*1024;
export const MAX_GETNOTE_AI_CONTENT_CHARS=120_000;

export class GetnoteNoteError extends Error{
  constructor(message,{code='GETNOTE_NOTE_UNAVAILABLE',statusCode=502,cause}={}){
    super(message,{cause});this.name='GetnoteNoteError';this.code=code;this.statusCode=statusCode;
  }
}
function fail(message,code='GETNOTE_NOTE_UNAVAILABLE',statusCode=502,cause){throw new GetnoteNoteError(message,{code,statusCode,cause});}
function firstText(...values){for(const value of values){if(value===undefined||value===null)continue;const text=String(value).trim();if(text)return text;}return null;}
function extractJson(stdout){
  const raw=String(stdout??'').replace(/^\uFEFF/,'').trim();
  if(!raw)fail('得到大脑 CLI 没有返回笔记 JSON。','GETNOTE_NOTE_EMPTY');
  try{return JSON.parse(raw);}catch{}
  const starts=[raw.indexOf('{'),raw.indexOf('[')].filter(index=>index>=0).sort((a,b)=>a-b);
  for(const start of starts){const close=raw[start]==='['?raw.lastIndexOf(']'):raw.lastIndexOf('}');if(close<=start)continue;try{return JSON.parse(raw.slice(start,close+1));}catch{}}
  fail('得到大脑 CLI 返回的笔记详情无法解析为 JSON。','GETNOTE_NOTE_INVALID_JSON');
}
function assertSuccessful(payload){
  if(payload&&typeof payload==='object'&&!Array.isArray(payload)&&payload.success===false){
    fail(firstText(payload.message,payload.reason,payload.error?.message,payload.error)||'得到大脑返回笔记读取失败。','GETNOTE_NOTE_REJECTED');
  }
  return payload;
}
function rawObject(payload){
  const value=assertSuccessful(payload);
  const data=value?.data&&typeof value.data==='object'&&!Array.isArray(value.data)?value.data:value;
  const note=data?.note&&typeof data.note==='object'&&!Array.isArray(data.note)?data.note:data;
  if(!note||typeof note!=='object'||Array.isArray(note))fail('得到大脑笔记详情格式无效。','GETNOTE_NOTE_SCHEMA');
  return note;
}
function normalizeContent(value){return String(value??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').trim();}
function noteKind(noteType){return String(noteType||'').trim().toUpperCase();}
function typeMatches(kind,patterns){return patterns.some(pattern=>kind.includes(pattern));}

export function selectGetnoteRawContent({noteType,content,webContent,web_content,audioOriginal,audio_original,postMediaText,post_media_text}={}){
  const kind=noteKind(noteType);
  const post=normalizeContent(postMediaText??post_media_text);
  const audio=normalizeContent(audioOriginal??audio_original);
  const web=normalizeContent(webContent??web_content);
  const normal=normalizeContent(content);
  if(post)return{sourceField:'post_media_text',content:post};
  if(audio)return{sourceField:'audio_original',content:audio};
  if(web)return{sourceField:'web_content',content:web};
  if(typeMatches(kind,['BLOGGER','BLOG','LIVE','POST','MEDIA']))fail('该知识库内容的真实原文需要 post_media_text；当前 note detail 只有摘要，拒绝当作原文解析。','GETNOTE_RAW_CONTENT_UNAVAILABLE',409);
  if(typeMatches(kind,['MEETING','AUDIO','RECORD','VOICE']))fail('该录音/会议笔记缺少 audio_original；拒绝把 AI 总结 content 当作原文解析。','GETNOTE_RAW_CONTENT_UNAVAILABLE',409);
  if(typeMatches(kind,['LINK','WEB','URL','ARTICLE']))fail('该链接/网页笔记缺少 web_content；拒绝把 AI 总结 content 当作原文解析。','GETNOTE_RAW_CONTENT_UNAVAILABLE',409);
  if(normal)return{sourceField:'content',content:normal};
  fail('得到大脑笔记没有可用于 AI 解析的真实原文。','GETNOTE_RAW_CONTENT_UNAVAILABLE',409);
}

export function parseGetnoteNoteDetail(payload){
  const raw=rawObject(payload);
  const noteId=firstText(raw.note_id,raw.noteId,raw.id);
  if(!noteId)fail('得到大脑笔记详情缺少 note_id。','GETNOTE_NOTE_SCHEMA');
  const noteType=firstText(raw.note_type,raw.noteType,raw.type)||'';
  const selected=selectGetnoteRawContent({
    noteType,
    content:raw.content,
    webContent:raw.web_content??raw.webContent,
    audioOriginal:raw.audio_original??raw.audioOriginal,
    postMediaText:raw.post_media_text??raw.postMediaText
  });
  if(selected.content.length>MAX_GETNOTE_AI_CONTENT_CHARS)fail(`得到大脑原文超过 ${MAX_GETNOTE_AI_CONTENT_CHARS} 字符；v1 不截断证据，需后续分块解析。`,'GETNOTE_NOTE_TOO_LARGE',413);
  return{
    noteId:String(noteId),
    title:firstText(raw.title)||'未命名笔记',
    noteType,
    createdAt:firstText(raw.created_at,raw.createdAt),
    updatedAt:firstText(raw.updated_at,raw.updatedAt),
    noteUrl:firstText(raw.note_url,raw.noteUrl,raw.url)||'',
    sourceField:selected.sourceField,
    content:selected.content
  };
}

function cliError(error){
  if(error instanceof GetnoteNoteError)return error;
  if(error?.code==='ENOENT')return new GetnoteNoteError('未找到 getnote CLI。请先安装并完成得到大脑授权。',{code:'GETNOTE_CLI_MISSING',cause:error});
  if(error?.killed||error?.signal)return new GetnoteNoteError('得到大脑笔记读取超时。',{code:'GETNOTE_NOTE_TIMEOUT',statusCode:504,cause:error});
  return new GetnoteNoteError('得到大脑笔记读取失败。请运行 getnote doctor -o json 检查登录和网络。',{cause:error});
}

export function createGetnoteNoteClient({exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  return{
    async fetch(noteId){
      const id=String(noteId??'').trim();
      if(!id||id.length>256||/[\s\0]/.test(id))fail('得到大脑 note_id 格式无效。','INVALID_GETNOTE_NOTE_ID',400);
      try{
        const result=await exec(CLI,['note',id,'-o','json'],{timeout:timeoutMs,maxBuffer:MAX_BUFFER,windowsHide:true,env:{...process.env}});
        return parseGetnoteNoteDetail(extractJson(result.stdout));
      }catch(error){throw cliError(error);}
    }
  };
}
