import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFeishuInboxXml, FeishuSourceError, escapeXml } from './feishu.mjs';
import { normalizeFeishuProjectDocumentUrl } from './project-record-contract.mjs';
import { captureMarker, normalizeCaptureId, parseCaptureMarker } from './capture-contract.mjs';

const execFileAsync=promisify(execFile);
const DEFAULT_TIMEOUT_MS=30_000;

function extractJson(stdout){
  const raw=String(stdout??'').trim();
  if(!raw)throw new FeishuSourceError('飞书 CLI 没有返回内容。');
  try{return JSON.parse(raw);}catch{}
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start>=0&&end>start){
    try{return JSON.parse(raw.slice(start,end+1));}catch{}
  }
  throw new FeishuSourceError('飞书 CLI 返回内容无法解析。');
}

function cliError(error,action){
  if(error instanceof FeishuSourceError)return error;
  const message=error?.code==='ENOENT'
    ?'未找到 lark-cli，请在安装并登录 lark-cli 的本机运行工作台。'
    :`飞书${action}失败，请检查登录状态和文档权限。`;
  return new FeishuSourceError(message,{cause:error});
}

async function runCli(args,action,{exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  try{
    const result=await exec('lark-cli',args,{timeout:timeoutMs,maxBuffer:4*1024*1024,windowsHide:true});
    return extractJson(result.stdout);
  }catch(error){throw cliError(error,action);}
}

function documentContent(payload){
  const document=payload?.data?.document;
  if(typeof document?.content!=='string')throw new FeishuSourceError('飞书文档读回结果缺少正文。');
  return{content:document.content,revisionId:document.revision_id??null,documentId:document.document_id??null};
}

async function fetchDocument(documentUrl,options){
  let url;
  try{url=normalizeFeishuProjectDocumentUrl(documentUrl);}
  catch(error){throw new FeishuSourceError(error.message,{cause:error,code:error.code,statusCode:error.statusCode});}
  const payload=await runCli([
    'docs','+fetch','--api-version','v2','--as','user','--doc',url,
    '--detail','with-ids','--format','json'
  ],'文档读取',options);
  return{...documentContent(payload),url};
}

async function updateDocument(documentUrl,{anchorBlockId,content},options){
  let url;
  try{url=normalizeFeishuProjectDocumentUrl(documentUrl);}
  catch(error){throw new FeishuSourceError(error.message,{cause:error,code:error.code,statusCode:error.statusCode});}
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(String(anchorBlockId||''))){
    throw new FeishuSourceError('飞书文档 block ID 格式无效。',{code:'INVALID_FEISHU_SOURCE',statusCode:400});
  }
  await runCli([
    'docs','+update','--api-version','v2','--as','user','--doc',url,
    '--command','block_insert_after','--block-id',anchorBlockId,
    '--content',content,'--format','json'
  ],'文档写入',options);
}

export function createFeishuCaptureClient({exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  const options={exec,timeoutMs};
  async function fetch(config){
    const document=await fetchDocument(config?.documentUrl,options);
    const parsed=parseFeishuInboxXml(document.content,{
      heading:config?.inboxHeading||'收件箱',
      prefix:config?.inboxPrefix||'[INBOX]'
    });
    if(!parsed.sectionFound){
      throw new FeishuSourceError(`文档中没有找到“${config?.inboxHeading||'收件箱'}”章节。`,{code:'FEISHU_SOURCE_FORMAT'});
    }
    return{
      ...document,
      ...parsed,
      items:parsed.items.map(item=>{
        const capture=parseCaptureMarker(item.text);
        return{...item,text:capture.text,captureId:capture.captureId};
      })
    };
  }

  async function appendAndFetch(config,text,{captureId}={}){
    const id=normalizeCaptureId(captureId);
    const normalized=String(text??'').trim();
    if(!normalized)throw new FeishuSourceError('采集内容不能为空。',{code:'INVALID_CAPTURE',statusCode:400});
    const current=await fetch(config);
    const existing=current.items.filter(item=>item.captureId===id);
    if(existing.length>1){
      throw new FeishuSourceError('飞书收件箱中存在重复 captureId，需要人工核对。',{code:'CAPTURE_DUPLICATE_REMOTE_ID',statusCode:409});
    }
    if(existing.length===1){
      if(existing[0].text!==normalized){
        throw new FeishuSourceError('同一 captureId 已用于不同内容，已拒绝覆盖。',{code:'CAPTURE_ID_CONFLICT',statusCode:409});
      }
      return{...current,item:existing[0],replayed:true,captureId:id};
    }

    const anchor=current.items.at(-1)?.blockId||current.headingBlockId;
    if(!anchor)throw new FeishuSourceError('飞书文档收件箱章节缺少可写入锚点。',{code:'FEISHU_SOURCE_FORMAT'});
    const prefix=config?.inboxPrefix||'[INBOX]';
    await updateDocument(config.documentUrl,{
      anchorBlockId:anchor,
      content:`<p>${escapeXml(`${prefix} ${captureMarker(id)} ${normalized}`)}</p>`
    },options);
    const fetched=await fetch(config);
    const matches=fetched.items.filter(item=>item.captureId===id);
    if(matches.length!==1){
      throw new FeishuSourceError('飞书采集写入后无法按 captureId 唯一读回。',{code:'CAPTURE_READBACK_FAILED'});
    }
    if(matches[0].text!==normalized){
      throw new FeishuSourceError('飞书采集读回内容与请求不一致。',{code:'CAPTURE_READBACK_FAILED'});
    }
    return{...fetched,item:matches[0],replayed:false,captureId:id};
  }

  return{fetch,appendAndFetch};
}
