import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';

const execFileAsync=promisify(execFile);
const CLI='getnote';
const DEFAULT_TIMEOUT_MS=45_000;
const MAX_BUFFER=16*1024*1024;
const MAX_HTTP_BYTES=16*1024*1024;
const MODES=new Set(['local_cli','private_http']);
const LOCAL_CLI_ENV_KEYS=Object.freeze([
  'HOME','PATH','USER','LOGNAME','TMPDIR','LANG','LC_ALL','LC_CTYPE','XDG_CONFIG_HOME',
  'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy',
  'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS',
  'GETNOTE_API_KEY','GETNOTE_CLIENT_ID'
]);

export class GetnoteRuntimeError extends Error{
  constructor(message,{code='GETNOTE_RUNTIME_UNAVAILABLE',statusCode=502,cause}={}){
    super(message,{cause});
    this.name='GetnoteRuntimeError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function fail(message,code='GETNOTE_RUNTIME_INVALID',statusCode=400,cause){
  throw new GetnoteRuntimeError(message,{code,statusCode,cause});
}
function clean(value){return typeof value==='string'?value.trim():'';}
function integer(value,fallback,min,max,label){
  const raw=clean(String(value??''));
  if(!raw)return fallback;
  if(!/^\d+$/.test(raw))fail(`${label} 必须是整数。`,'GETNOTE_RUNTIME_INVALID',400);
  const parsed=Number(raw);
  if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)fail(`${label} 必须在 ${min}-${max} 之间。`,'GETNOTE_RUNTIME_INVALID',400);
  return parsed;
}
export function normalizeGetnoteNoteId(value){
  const id=String(value??'').trim();
  if(!id||id.length>256||/[\s/\\?#\0]/.test(id))fail('得到大脑 note_id 格式无效。','INVALID_GETNOTE_NOTE_ID',400);
  return id;
}
function parseJsonText(value,label='得到大脑运行时'){
  const raw=String(value??'').replace(/^\uFEFF/,'').trim();
  if(!raw)fail(`${label} 没有返回 JSON。`,'GETNOTE_RUNTIME_EMPTY',502);
  try{return JSON.parse(raw);}catch{}
  const starts=[raw.indexOf('{'),raw.indexOf('[')].filter(index=>index>=0).sort((a,b)=>a-b);
  for(const start of starts){
    const close=raw[start]==='['?raw.lastIndexOf(']'):raw.lastIndexOf('}');
    if(close<=start)continue;
    try{return JSON.parse(raw.slice(start,close+1));}catch{}
  }
  fail(`${label} 返回内容无法解析为 JSON。`,'GETNOTE_RUNTIME_INVALID_JSON',502);
}
function localCliError(error,action){
  if(error instanceof GetnoteRuntimeError)return error;
  if(error?.code==='ENOENT')return new GetnoteRuntimeError('未找到 getnote CLI。请先安装并完成得到大脑授权。',{code:'GETNOTE_CLI_MISSING',cause:error});
  if(error?.killed||error?.signal)return new GetnoteRuntimeError(`得到大脑 CLI ${action}超时。`,{code:'GETNOTE_RUNTIME_TIMEOUT',statusCode:504,cause:error});
  return new GetnoteRuntimeError(`得到大脑 CLI ${action}失败。请运行 getnote doctor -o json 检查登录和网络。`,{cause:error});
}
function localCliEnv(source={}){
  const env={};
  for(const key of LOCAL_CLI_ENV_KEYS){
    const value=source?.[key];
    if(typeof value==='string'&&value.length)env[key]=value;
  }
  return env;
}

export function createLocalGetnoteReader({exec=execFileAsync,timeoutMs=DEFAULT_TIMEOUT_MS,processEnv=process.env}={}){
  const timeout=integer(timeoutMs,DEFAULT_TIMEOUT_MS,1_000,120_000,'GetNote timeout');
  const childEnv=localCliEnv(processEnv);
  async function run(args,action){
    try{
      const result=await exec(CLI,args,{timeout,maxBuffer:MAX_BUFFER,windowsHide:true,env:childEnv});
      return parseJsonText(result.stdout,'得到大脑 CLI');
    }catch(error){throw localCliError(error,action);}
  }
  return{
    status(){return{mode:'local_cli',transport:'execFile',readOnly:true};},
    async listNotes({limit=20,cursor=null}={}){
      const size=integer(limit,20,1,500,'limit');
      const args=['notes','--limit',String(size)];
      const next=clean(cursor);
      if(next){
        if(next.length>512||/[\r\n\0]/.test(next))fail('得到大脑 cursor 格式无效。','GETNOTE_RUNTIME_INVALID',400);
        args.push('--cursor',next);
      }
      args.push('-o','json');
      return run(args,'读取最近笔记');
    },
    async fetchTodos(noteId){
      return run(['note','todos',normalizeGetnoteNoteId(noteId),'-o','json'],'读取笔记待办');
    },
    async fetchNote(noteId){
      return run(['note',normalizeGetnoteNoteId(noteId),'-o','json'],'读取笔记原文');
    }
  };
}

function privateIpv4(address){
  const parts=address.split('.').map(Number);
  if(parts.length!==4||parts.some(value=>!Number.isInteger(value)||value<0||value>255))return false;
  const [a,b]=parts;
  return a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
}
function privateIpv6(address){
  const value=address.toLowerCase();
  return value==='::1'||value.startsWith('fc')||value.startsWith('fd')||value.startsWith('fe8')||value.startsWith('fe9')||value.startsWith('fea')||value.startsWith('feb');
}
function privateRuntimeHost(hostname){
  const host=String(hostname||'').toLowerCase().replace(/^\[|\]$/g,'');
  if(host==='localhost'||host==='host.docker.internal'||host.endsWith('.internal')||host.endsWith('.local'))return true;
  if(!host.includes('.')&&!host.includes(':'))return /^[a-z0-9][a-z0-9-]{0,62}$/.test(host);
  const family=net.isIP(host);
  if(family===4)return privateIpv4(host);
  if(family===6)return privateIpv6(host);
  return false;
}
function runtimeBaseUrl(value){
  let url;
  try{url=new URL(clean(value));}catch{fail('GETNOTE_RUNTIME_BASE_URL 无效。','GETNOTE_RUNTIME_INVALID',400);}
  if(!['http:','https:'].includes(url.protocol))fail('GetNote private runtime 只允许 http/https。','GETNOTE_RUNTIME_INVALID',400);
  if(url.username||url.password||url.search||url.hash)fail('GETNOTE_RUNTIME_BASE_URL 不得包含凭证、查询参数或 fragment。','GETNOTE_RUNTIME_INVALID',400);
  if(url.pathname!=='/'&&url.pathname!=='')fail('GETNOTE_RUNTIME_BASE_URL 只能配置 origin，不允许额外路径。','GETNOTE_RUNTIME_INVALID',400);
  if(!privateRuntimeHost(url.hostname))fail('GetNote private runtime 必须位于 loopback、私网 IP、Docker 内部名称或 .internal/.local 主机。','GETNOTE_RUNTIME_INVALID',400);
  return new URL(url.origin);
}
function serviceToken(value){
  const token=clean(value);
  if(token.length<32||/[\r\n]/.test(token))fail('GETNOTE_RUNTIME_SERVICE_TOKEN 至少需要 32 个字符。','GETNOTE_RUNTIME_NOT_CONFIGURED',500);
  return token;
}
function httpRuntimeError(status){
  if(status===401||status===403)return new GetnoteRuntimeError('GetNote private runtime 身份校验失败。',{code:'GETNOTE_RUNTIME_AUTH_FAILED',statusCode:502});
  if(status===404)return new GetnoteRuntimeError('GetNote private runtime 未找到请求的资源。',{code:'GETNOTE_RUNTIME_NOT_FOUND',statusCode:404});
  if(status===409)return new GetnoteRuntimeError('GetNote private runtime 暂时无法提供该笔记原文。',{code:'GETNOTE_RUNTIME_CONFLICT',statusCode:409});
  if(status===413)return new GetnoteRuntimeError('GetNote private runtime 返回的笔记过大。',{code:'GETNOTE_RUNTIME_TOO_LARGE',statusCode:413});
  if(status===429)return new GetnoteRuntimeError('GetNote private runtime 请求过于频繁。',{code:'GETNOTE_RUNTIME_RATE_LIMITED',statusCode:429});
  return new GetnoteRuntimeError('GetNote private runtime 请求失败。',{code:'GETNOTE_RUNTIME_UNAVAILABLE',statusCode:502});
}

export function createPrivateHttpGetnoteReader({baseUrl,token,timeoutMs=DEFAULT_TIMEOUT_MS,fetchImpl=globalThis.fetch}={}){
  const base=runtimeBaseUrl(baseUrl);
  const secret=serviceToken(token);
  const timeout=integer(timeoutMs,DEFAULT_TIMEOUT_MS,1_000,120_000,'GETNOTE_RUNTIME_TIMEOUT_MS');
  if(typeof fetchImpl!=='function')fail('当前 Node runtime 没有 fetch。','GETNOTE_RUNTIME_UNAVAILABLE',500);
  async function request(pathname,searchParams=null){
    const url=new URL(pathname,base);
    if(url.origin!==base.origin)fail('GetNote runtime URL 越界。','GETNOTE_RUNTIME_INVALID',500);
    if(searchParams)for(const [key,value] of Object.entries(searchParams))if(value!==null&&value!==undefined&&value!=='')url.searchParams.set(key,String(value));
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();
    let response;
    try{
      response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json',Authorization:`Bearer ${secret}`},redirect:'error',signal:controller.signal});
    }catch(error){
      if(error?.name==='AbortError')throw new GetnoteRuntimeError('GetNote private runtime 请求超时。',{code:'GETNOTE_RUNTIME_TIMEOUT',statusCode:504,cause:error});
      throw new GetnoteRuntimeError('无法连接 GetNote private runtime。',{code:'GETNOTE_RUNTIME_NETWORK_ERROR',statusCode:502,cause:error});
    }finally{clearTimeout(timer);}
    if(!response.ok)throw httpRuntimeError(response.status);
    const declared=Number(response.headers.get('content-length')||0);
    if(Number.isFinite(declared)&&declared>MAX_HTTP_BYTES)fail('GetNote private runtime 响应过大。','GETNOTE_RUNTIME_RESPONSE_TOO_LARGE',502);
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.byteLength>MAX_HTTP_BYTES)fail('GetNote private runtime 响应过大。','GETNOTE_RUNTIME_RESPONSE_TOO_LARGE',502);
    return parseJsonText(new TextDecoder().decode(bytes),'GetNote private runtime');
  }
  return{
    status(){return{mode:'private_http',transport:'http',origin:base.origin,readOnly:true};},
    async listNotes({limit=20,cursor=null}={}){
      const size=integer(limit,20,1,500,'limit');
      const next=clean(cursor);
      if(next&&(next.length>512||/[\r\n\0]/.test(next)))fail('得到大脑 cursor 格式无效。','GETNOTE_RUNTIME_INVALID',400);
      return request('/v1/notes',{limit:size,cursor:next||null});
    },
    async fetchTodos(noteId){return request(`/v1/notes/${encodeURIComponent(normalizeGetnoteNoteId(noteId))}/todos`);},
    async fetchNote(noteId){return request(`/v1/notes/${encodeURIComponent(normalizeGetnoteNoteId(noteId))}`);}
  };
}

export function getnoteRuntimeConfig(env=process.env){
  const mode=clean(env.GETNOTE_RUNTIME_MODE)||'local_cli';
  if(!MODES.has(mode))fail('GETNOTE_RUNTIME_MODE 只允许 local_cli 或 private_http。','GETNOTE_RUNTIME_INVALID',400);
  if(mode==='local_cli')return{mode,readOnly:true};
  const base=runtimeBaseUrl(env.GETNOTE_RUNTIME_BASE_URL);
  serviceToken(env.GETNOTE_RUNTIME_SERVICE_TOKEN);
  return{mode,origin:base.origin,readOnly:true,timeoutMs:integer(env.GETNOTE_RUNTIME_TIMEOUT_MS,DEFAULT_TIMEOUT_MS,1_000,120_000,'GETNOTE_RUNTIME_TIMEOUT_MS')};
}

export function createGetnoteReader({env=process.env,mode,exec,timeoutMs,fetchImpl}={}){
  const selected=mode||clean(env.GETNOTE_RUNTIME_MODE)||'local_cli';
  if(!MODES.has(selected))fail('GETNOTE_RUNTIME_MODE 只允许 local_cli 或 private_http。','GETNOTE_RUNTIME_INVALID',400);
  if(selected==='local_cli')return createLocalGetnoteReader({exec:exec||execFileAsync,timeoutMs:timeoutMs??env.GETNOTE_RUNTIME_TIMEOUT_MS??DEFAULT_TIMEOUT_MS,processEnv:env});
  return createPrivateHttpGetnoteReader({
    baseUrl:env.GETNOTE_RUNTIME_BASE_URL,
    token:env.GETNOTE_RUNTIME_SERVICE_TOKEN,
    timeoutMs:timeoutMs??env.GETNOTE_RUNTIME_TIMEOUT_MS??DEFAULT_TIMEOUT_MS,
    fetchImpl
  });
}
