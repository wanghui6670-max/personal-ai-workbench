import crypto from 'node:crypto';
import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS=20_000;
const DEFAULT_MAX_RESPONSE_BYTES=2_000_000;
const AUTH_MODES=new Set(['fixture','signed_session','trusted_proxy']);
const NETWORK_ZONES=new Set(['local_loopback','private_http','public_https']);
const ROLES=new Set(['admin','member']);

function boundedInteger(value,fallback,{min,max}){
  const parsed=Number(value);
  if(!Number.isInteger(parsed))return fallback;
  return Math.min(max,Math.max(min,parsed));
}

function firstNonEmpty(...values){
  for(const value of values){
    const text=String(value??'').trim();
    if(text)return text;
  }
  return '';
}

function normalizeHostname(value){
  return String(value||'').trim().toLowerCase().replace(/^\[|\]$/g,'').replace(/%.*$/,'');
}

function isLoopbackHostname(value){
  const hostname=normalizeHostname(value);
  if(hostname==='localhost'||hostname==='::1')return true;
  if(isIP(hostname)===4)return hostname.startsWith('127.');
  return false;
}

function isPrivateIpv4(hostname){
  if(isIP(hostname)!==4)return false;
  const parts=hostname.split('.').map(Number);
  return parts[0]===10||parts[0]===127||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168)||(parts[0]===169&&parts[1]===254);
}

function isPrivateHostname(value){
  const hostname=normalizeHostname(value);
  if(isLoopbackHostname(hostname)||isPrivateIpv4(hostname))return true;
  if(isIP(hostname)===6)return /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(hostname);
  return !hostname.includes('.')||hostname.endsWith('.local')||hostname.endsWith('.internal');
}

function normalizedBaseUrl(value,networkZone){
  let url;
  try{url=new URL(value);}catch{return {ok:false,reason:'base_url_invalid'};}
  if(url.username||url.password||url.search||url.hash)return {ok:false,reason:'base_url_unsafe'};
  if(!['http:','https:'].includes(url.protocol))return {ok:false,reason:'base_url_protocol'};
  if(networkZone==='public_https'&&url.protocol!=='https:')return {ok:false,reason:'https_required'};
  if(networkZone==='local_loopback'&&!(url.protocol==='http:'&&isLoopbackHostname(url.hostname)))return {ok:false,reason:'loopback_required'};
  if(networkZone==='private_http'&&!(url.protocol==='http:'&&isPrivateHostname(url.hostname)))return {ok:false,reason:'private_host_required'};
  url.pathname=url.pathname.replace(/\/+$/,'');
  return {ok:true,url:url.toString().replace(/\/$/,'')};
}

function configFailure(reason,details={}){
  return {enabled:true,ok:false,reason,...details};
}

export function resolveJoycrewConfig(env=process.env){
  const enabled=String(env.JOYCREW_ENABLED||'').trim()==='1';
  if(!enabled)return {enabled:false,ok:false,reason:'disabled'};
  const networkZone=firstNonEmpty(env.JOYCREW_NETWORK_ZONE,'local_loopback');
  if(!NETWORK_ZONES.has(networkZone))return configFailure('network_zone_invalid');
  const base=normalizedBaseUrl(firstNonEmpty(env.JOYCREW_BASE_URL,'http://127.0.0.1:4000'),networkZone);
  if(!base.ok)return configFailure(base.reason,{networkZone});
  const authMode=firstNonEmpty(env.JOYCREW_AUTH_MODE,'trusted_proxy');
  if(!AUTH_MODES.has(authMode))return configFailure('auth_mode_invalid',{networkZone,baseUrl:base.url});
  if(authMode==='fixture'&&String(env.NODE_ENV||'').toLowerCase()==='production')return configFailure('fixture_forbidden',{networkZone,baseUrl:base.url,authMode});
  const userId=firstNonEmpty(env.JOYCREW_USER_ID,'user-chris');
  const workspaceId=firstNonEmpty(env.JOYCREW_WORKSPACE_ID,'ws-dongjue');
  const role=firstNonEmpty(env.JOYCREW_ROLE,'admin');
  if(!ROLES.has(role))return configFailure('role_invalid',{networkZone,baseUrl:base.url,authMode});
  const proxyToken=firstNonEmpty(env.JOYCREW_TRUSTED_PROXY_TOKEN);
  const sessionToken=firstNonEmpty(env.JOYCREW_SESSION_TOKEN);
  if(authMode==='trusted_proxy'&&Buffer.byteLength(proxyToken)<24)return configFailure('proxy_token_missing',{networkZone,baseUrl:base.url,authMode,workspaceId,userId,role});
  if(authMode==='signed_session'&&!sessionToken)return configFailure('session_token_missing',{networkZone,baseUrl:base.url,authMode,workspaceId,userId,role});
  return {
    enabled:true,
    ok:true,
    reason:null,
    baseUrl:base.url,
    networkZone,
    authMode,
    userId,
    workspaceId,
    role,
    proxyToken,
    sessionToken,
    timeoutMs:boundedInteger(env.JOYCREW_TIMEOUT_MS,DEFAULT_TIMEOUT_MS,{min:1_000,max:180_000}),
    maxResponseBytes:boundedInteger(env.JOYCREW_MAX_RESPONSE_BYTES,DEFAULT_MAX_RESPONSE_BYTES,{min:16_384,max:10_000_000})
  };
}

export class JoycrewClientError extends Error{
  constructor(code,message,{statusCode=502,retryable=false,details=null,cause}={}){
    super(message,{cause});
    this.name='JoycrewClientError';
    this.code=code;
    this.statusCode=statusCode;
    this.retryable=Boolean(retryable);
    this.details=details;
  }
}

async function readBoundedResponse(response,maxBytes){
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes){
    try{await response.body?.cancel?.();}catch{}
    throw new JoycrewClientError('JOYCREW_RESPONSE_TOO_LARGE','Joycrew 响应超过安全大小限制。',{statusCode:502});
  }
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader();
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      const chunk=Buffer.from(value);
      total+=chunk.byteLength;
      if(total>maxBytes){
        try{await reader.cancel();}catch{}
        throw new JoycrewClientError('JOYCREW_RESPONSE_TOO_LARGE','Joycrew 响应超过安全大小限制。',{statusCode:502});
      }
      chunks.push(chunk);
    }
  }finally{reader.releaseLock?.();}
  return Buffer.concat(chunks,total);
}

function publicConfig(config){
  return {
    enabled:Boolean(config.enabled),
    configured:Boolean(config.ok),
    reason:config.reason||null,
    authMode:config.authMode||null,
    workspaceId:config.workspaceId||null,
    role:config.role||null
  };
}

function safeJson(value,depth=0){
  if(depth>8)return '[truncated]';
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value==='string')return value.length<=12_000?value:`${value.slice(0,11_999)}…`;
  if(Array.isArray(value))return value.slice(0,500).map(item=>safeJson(item,depth+1));
  if(value&&typeof value==='object'){
    const output={};
    for(const [key,item] of Object.entries(value).slice(0,500)){
      if(/token|secret|password|authorization|cookie|api.?key/i.test(key)){output[key]='[redacted]';continue;}
      output[key]=safeJson(item,depth+1);
    }
    return output;
  }
  return String(value);
}

function queryString(query={}){
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(query)){
    if(value===undefined||value===null||value==='')continue;
    params.set(key,String(value));
  }
  const text=params.toString();
  return text?`?${text}`:'';
}

export class JoycrewClient{
  constructor({env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}){
    if(typeof fetchImpl!=='function')throw new Error('JoycrewClient requires fetch');
    this.env=env;
    this.fetchImpl=fetchImpl;
    this.now=now;
  }

  config(){return resolveJoycrewConfig(this.env);}

  status(){
    const config=this.config();
    return {...publicConfig(config),available:false,checkedAt:new Date(this.now()).toISOString()};
  }

  headers(config,correlationId){
    const headers={
      accept:'application/json',
      'content-type':'application/json',
      'x-correlation-id':correlationId,
      'x-request-id':correlationId
    };
    if(config.authMode==='trusted_proxy'){
      headers['x-joycrew-proxy-token']=config.proxyToken;
      headers['x-user-id']=config.userId;
      headers['x-workspace-id']=config.workspaceId;
      headers['x-role']=config.role;
    }else if(config.authMode==='signed_session')headers.authorization=`Bearer ${config.sessionToken}`;
    else{
      headers['x-user-id']=config.userId;
      headers['x-workspace-id']=config.workspaceId;
      headers['x-role']=config.role;
    }
    return headers;
  }

  async request(method,pathname,{query,body}={}){
    const config=this.config();
    if(!config.enabled)throw new JoycrewClientError('JOYCREW_DISABLED','Joycrew 尚未启用。',{statusCode:503});
    if(!config.ok)throw new JoycrewClientError('JOYCREW_CONFIGURATION_INVALID',`Joycrew 配置无效：${config.reason}。`,{statusCode:503,details:publicConfig(config)});
    const correlationId=`wb-${crypto.randomUUID()}`;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),config.timeoutMs);
    let response;
    try{
      response=await this.fetchImpl(`${config.baseUrl}${pathname}${queryString(query)}`,{
        method,
        redirect:'error',
        headers:this.headers(config,correlationId),
        signal:controller.signal,
        ...(body===undefined?{}:{body:JSON.stringify(body)})
      });
    }catch(error){
      clearTimeout(timeout);
      if(error?.name==='AbortError')throw new JoycrewClientError('JOYCREW_TIMEOUT','Joycrew 请求超时。',{statusCode:504,retryable:true,cause:error});
      throw new JoycrewClientError('JOYCREW_UNREACHABLE','无法连接 Joycrew；个人工作台仍可继续使用。',{statusCode:503,retryable:true,cause:error});
    }
    let buffer;
    try{buffer=await readBoundedResponse(response,config.maxResponseBytes);}
    catch(error){
      if(error instanceof JoycrewClientError)throw error;
      if(error?.name==='AbortError')throw new JoycrewClientError('JOYCREW_TIMEOUT','Joycrew 响应超时。',{statusCode:504,retryable:true,cause:error});
      throw new JoycrewClientError('JOYCREW_BAD_RESPONSE','无法读取 Joycrew 响应。',{statusCode:502,retryable:true,cause:error});
    }finally{clearTimeout(timeout);}
    let payload={};
    const text=buffer.toString('utf8').trim();
    if(text){
      try{payload=JSON.parse(text);}
      catch(error){throw new JoycrewClientError('JOYCREW_BAD_RESPONSE','Joycrew 返回了无效 JSON。',{statusCode:502,cause:error});}
    }
    payload=safeJson(payload);
    if(!response.ok){
      const code=typeof payload?.errorCode==='string'?payload.errorCode:`JOYCREW_HTTP_${response.status}`;
      const message=typeof payload?.message==='string'&&payload.message?payload.message:`Joycrew 请求失败（${response.status}）。`;
      throw new JoycrewClientError(code,message,{statusCode:response.status,retryable:Boolean(payload?.retryable),details:payload?.details||null});
    }
    return payload;
  }

  health(){return this.request('GET','/health');}
  meta(){return this.request('GET','/api/meta');}
  bootstrap(){return this.request('GET','/api/bootstrap');}
  dashboard(){return this.request('GET','/api/dashboard');}
  projects(){return this.request('GET','/api/projects');}
  project(projectId){return this.request('GET',`/api/projects/${encodeURIComponent(String(projectId))}`);}
  customers(){return this.request('GET','/api/customers');}
  customer(customerId){return this.request('GET',`/api/customers/${encodeURIComponent(String(customerId))}`);}
  tasks(filters={}){return this.request('GET','/api/tasks',{query:filters});}
  approvals(){return this.request('GET','/api/approvals');}
  deliverables(){return this.request('GET','/api/deliverables');}
  run(runId){return this.request('GET',`/api/runs/${encodeURIComponent(String(runId))}`);}
  createRun(projectId,input){return this.request('POST',`/api/projects/${encodeURIComponent(String(projectId))}/runs`,{body:input});}
  createDeliverable(runId,title){return this.request('POST',`/api/runs/${encodeURIComponent(String(runId))}/deliverables`,{body:{title}});}
  approve(approvalId){return this.request('POST',`/api/approvals/${encodeURIComponent(String(approvalId))}/approve`,{body:{}});}
  reject(approvalId){return this.request('POST',`/api/approvals/${encodeURIComponent(String(approvalId))}/reject`,{body:{}});}

  async probe(){
    const config=this.config();
    const base={...publicConfig(config),available:false,checkedAt:new Date(this.now()).toISOString()};
    if(!config.enabled||!config.ok)return base;
    try{
      const health=await this.health();
      if(health?.featureEnabled===false)return {...base,errorCode:'FEATURE_DISABLED',error:'Joycrew 功能开关当前关闭。',retryable:false,health};
      if(health?.status&&health.status!=='ok')return {...base,errorCode:'JOYCREW_NOT_READY',error:'Joycrew 当前未就绪。',retryable:true,health};
      return {...base,available:true,health};
    }catch(error){
      if(error instanceof JoycrewClientError)return {...base,errorCode:error.code,error:error.message,retryable:error.retryable};
      throw error;
    }
  }

  async overview(){
    const [health,meta,bootstrap,dashboard,customers,tasks]=await Promise.all([
      this.health(),this.meta(),this.bootstrap(),this.dashboard(),this.customers(),this.tasks()
    ]);
    return {health,meta,bootstrap,dashboard,customers:customers.customers||[],tasks:tasks.tasks||[],fetchedAt:new Date(this.now()).toISOString()};
  }
}

export function createJoycrewClient(options){return new JoycrewClient(options);}
