import {createGetnoteReader,GetnoteRuntimeError,normalizeGetnoteNoteId} from './getnote-runtime.mjs';

export const MAX_GETNOTE_AI_CONTENT_CHARS=120_000;

export class GetnoteNoteError extends Error{
  constructor(message,{code='GETNOTE_NOTE_UNAVAILABLE',statusCode=502,cause}={}){
    super(message,{cause});this.name='GetnoteNoteError';this.code=code;this.statusCode=statusCode;
  }
}
function fail(message,code='GETNOTE_NOTE_UNAVAILABLE',statusCode=502,cause){throw new GetnoteNoteError(message,{code,statusCode,cause});}
function firstText(...values){for(const value of values){if(value===undefined||value===null)continue;const text=String(value).trim();if(text)return text;}return null;}
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

function runtimeError(error){
  if(error instanceof GetnoteNoteError)return error;
  if(error instanceof GetnoteRuntimeError)return new GetnoteNoteError(error.message,{code:error.code,statusCode:error.statusCode,cause:error});
  return new GetnoteNoteError('得到大脑笔记读取失败。',{cause:error});
}

export function createGetnoteNoteClient({reader=null,exec,timeoutMs,env=process.env,fetchImpl}={}){
  const runtime=reader||createGetnoteReader({env,exec,timeoutMs,fetchImpl});
  return{
    status(){return runtime.status?.()||{mode:'unknown',readOnly:true};},
    async fetch(noteId){
      const id=normalizeGetnoteNoteId(noteId);
      try{return parseGetnoteNoteDetail(await runtime.fetchNote(id));}
      catch(error){throw runtimeError(error);}
    }
  };
}
