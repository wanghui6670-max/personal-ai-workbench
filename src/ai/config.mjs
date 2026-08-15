import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { aiProviderError } from './errors.mjs';

export const AI_DEFAULT_PROFILE_ID='openai_luna';
export const OPENAI_DEFAULT_MODEL='gpt-5.6-luna';
export const AI_REASONING_LEVEL='xhigh';
export const AI_DEFAULT_TIMEOUT_MS=120_000;
export const AI_DEFAULT_MAX_OUTPUT_TOKENS=32_000;
export const AI_MAX_OUTPUT_TOKENS_LIMIT=64_000;
export const AI_DEFAULT_MAX_RESPONSE_BYTES=2_000_000;
// The console planner is deliberately a first-class workflow. It may only
// propose one registered MCP tool call (or ask a clarification); the registry
// still owns argument validation, confirmation and execution. GetNote insight
// is also registered explicitly so note content cannot piggy-back on another
// workflow's provider allow-list.
export const AI_WORKFLOWS=Object.freeze(['project_creation','project_progress','morning_dialogue','ai_console','getnote_insight']);

const PROFILE_ALIASES=new Map([
  ['openai','openai_luna'],
  ['responses_compatible','third_party_responses'],
  ['chat_completions_compatible','third_party_chat_completions']
]);
const PROFILE_IDS=new Set(['openai_luna','third_party_responses','third_party_chat_completions']);
const WORKFLOW_SET=new Set(AI_WORKFLOWS);

function clean(value){return typeof value==='string'?value.trim():'';}
function enabledFlag(value){return clean(value)==='1';}
function boundedInteger(value,fallback,min,max,label){
  const raw=clean(value);
  if(!raw)return fallback;
  if(!/^\d+$/.test(raw))throw profileError(`${label} 必须是整数`);
  const parsed=Number(raw);
  if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw profileError(`${label} 必须在 ${min} 到 ${max} 之间`);
  return parsed;
}
function commaList(value){return [...new Set(clean(value).split(',').map(item=>item.trim()).filter(Boolean))];}
function profileError(message){return aiProviderError('AI_PROVIDER_PROFILE_INVALID',message);}

function normalizeProfileId(value){
  const requested=clean(value)||AI_DEFAULT_PROFILE_ID;
  return PROFILE_ALIASES.get(requested)||requested;
}

function normalizeBaseUrl(value){
  let url;
  try{url=new URL(clean(value));}catch{throw profileError('AI Provider endpoint 无效');}
  if(url.username||url.password||url.search||url.hash)throw profileError('AI Provider endpoint 不得包含凭证、查询参数或 fragment');
  url.pathname=url.pathname.replace(/\/+$/,'')||'/';
  return url;
}

function normalizeOrigin(value){
  try{return new URL(value).origin;}catch{throw profileError('AI Provider allowed origin 无效');}
}

function normalizeHostname(hostname){
  const value=String(hostname||'').toLowerCase();
  return value.startsWith('[')&&value.endsWith(']')?value.slice(1,-1):value;
}

function assertNoHeaderControls(value,label){
  if(/[\r\n]/.test(value))throw profileError(`${label} 不得包含换行符`);
  return value;
}

function isPrivateIpv4(address){
  const parts=address.split('.').map(Number);
  if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255))return true;
  const [a,b]=parts;
  return a===0||a===10||a===127||a>=224||
    (a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||
    (a===192&&b===0)||(a===192&&b===168)||(a===198&&(b===18||b===19))||
    (a===192&&b===0&&parts[2]===2)||(a===198&&b===51&&parts[2]===100)||(a===203&&b===0&&parts[2]===113);
}

function isPrivateIpv6(address){
  const normalized=address.toLowerCase();
  if(normalized==='::'||normalized==='::1')return true;
  const mapped=normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if(mapped)return isPrivateIpv4(mapped[1]);
  const groups=normalized.split(':');
  const first=Number.parseInt(groups[0]||'0',16);
  const second=Number.parseInt(groups[1]||'0',16);
  // Public profiles accept only global-unicast 2000::/3, then conservatively
  // reject documentation and transition/special-purpose ranges inside it.
  if(!Number.isInteger(first)||first<0x2000||first>0x3fff)return true;
  if(first===0x2001&&(second<=0x01ff||second===0x0db8))return true;
  if(first===0x2002||first===0x3fff)return true;
  return false;
}

function isPublicAddress(address){
  const family=net.isIP(address);
  if(family===4)return !isPrivateIpv4(address);
  if(family===6)return !isPrivateIpv6(address);
  return false;
}

function isLoopbackHost(hostname){
  const host=normalizeHostname(hostname);
  if(host==='localhost'||host==='::1'||host==='[::1]')return true;
  if(net.isIP(host)===4)return host.startsWith('127.');
  return false;
}

async function lookupWithTimeout(hostname,timeoutMs){
  let timer;
  try{
    return await Promise.race([
      lookup(hostname,{all:true,verbatim:true}),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(aiProviderError('AI_PROVIDER_TIMEOUT','AI Provider endpoint DNS 解析超时')),Math.min(timeoutMs,10_000));
        timer.unref?.();
      })
    ]);
  }finally{if(timer)clearTimeout(timer);}
}

function resolveWorkflowAllowlist(value){
  const configured=commaList(value);
  const workflows=configured.length?configured:AI_WORKFLOWS;
  if(workflows.some(item=>!WORKFLOW_SET.has(item)))throw profileError('AI Provider workflow allowlist 包含未知工作流');
  return workflows;
}

function resolveReasoning(env){
  const mode=clean(env.AI_PROVIDER_REASONING_MODE)||'xhigh';
  if(mode==='xhigh')return {requestedLevel:AI_REASONING_LEVEL,mode:'xhigh',degraded:false};
  if(mode==='approved_downgrade'&&enabledFlag(env.AI_PROVIDER_ALLOW_REASONING_DOWNGRADE)){
    return {requestedLevel:AI_REASONING_LEVEL,mode:'omit',degraded:true};
  }
  throw aiProviderError('AI_PROVIDER_CAPABILITY_MISMATCH','第三方 Provider 不满足 xhigh 推理要求');
}

function resolveStructuredOutput(env,adapter){
  const mode=clean(env.AI_PROVIDER_STRUCTURED_OUTPUT_MODE)||'strict_native';
  if(mode==='strict_native')return {mode,degraded:false};
  if(adapter==='openai_chat_completions_compatible'&&mode==='json_object_local_validate'&&enabledFlag(env.AI_PROVIDER_ALLOW_SCHEMA_DOWNGRADE)){
    return {mode,degraded:true};
  }
  throw aiProviderError('AI_PROVIDER_CAPABILITY_MISMATCH','第三方 Provider 不满足结构化输出要求');
}

function resolveRetention(env){
  const mode=clean(env.AI_PROVIDER_NO_STORE_MODE)||'send';
  if(mode==='send')return {mode,sendNoStore:true,degraded:false};
  if(mode==='approved_unsupported'&&enabledFlag(env.AI_PROVIDER_ALLOW_NO_STORE_DOWNGRADE)){
    return {mode,sendNoStore:false,degraded:true};
  }
  throw aiProviderError('AI_PROVIDER_CAPABILITY_MISMATCH','第三方 Provider 不满足 no-store 要求');
}

function baseProfile({id,provider,adapter,model,credential,endpoint,workflowAllowlist,reasoning,structuredOutput,retention,enabled,configured,env,availableModels=[],configuredModels=[]}){
  const chatTokenField=adapter==='openai_chat_completions_compatible'?(clean(env.AI_PROVIDER_CHAT_TOKEN_FIELD)||'max_completion_tokens'):'max_completion_tokens';
  if(adapter==='openai_chat_completions_compatible'&&!['max_completion_tokens','max_tokens'].includes(chatTokenField))throw profileError('AI_PROVIDER_CHAT_TOKEN_FIELD 只允许 max_completion_tokens 或 max_tokens');
  return {
    id,provider,adapter,model,credential,endpoint,workflowAllowlist,reasoning,structuredOutput,retention,
    availableModels,configuredModels,
    enabled,configured,
    timeoutMs:boundedInteger(env.AI_PROVIDER_TIMEOUT_MS,AI_DEFAULT_TIMEOUT_MS,1_000,300_000,'AI_PROVIDER_TIMEOUT_MS'),
    maxResponseBytes:boundedInteger(env.AI_PROVIDER_MAX_RESPONSE_BYTES,AI_DEFAULT_MAX_RESPONSE_BYTES,16_384,8_000_000,'AI_PROVIDER_MAX_RESPONSE_BYTES'),
    chatTokenField,
    degraded:Boolean(reasoning.degraded||structuredOutput.degraded||retention.degraded)
  };
}

function resolveOpenAIProfile(env){
  const credential=assertNoHeaderControls(clean(env.OPENAI_API_KEY),'OPENAI_API_KEY');
  return baseProfile({
    id:'openai_luna',provider:'openai',adapter:'openai_responses',
    model:assertNoHeaderControls(clean(env.OPENAI_MODEL)||OPENAI_DEFAULT_MODEL,'OPENAI_MODEL'),
    credential,
    endpoint:{id:'openai_public',baseUrl:'https://api.openai.com/v1',origin:'https://api.openai.com',networkZone:'public_https',trustedBuiltIn:true},
    workflowAllowlist:AI_WORKFLOWS,
    reasoning:{requestedLevel:AI_REASONING_LEVEL,mode:'xhigh',degraded:false},
    structuredOutput:{mode:'strict_native',degraded:false},
    retention:{mode:'send',sendNoStore:true,degraded:false},
    enabled:Boolean(credential),configured:Boolean(credential),env,
    availableModels:[assertNoHeaderControls(clean(env.OPENAI_MODEL)||OPENAI_DEFAULT_MODEL,'OPENAI_MODEL')],
    configuredModels:credential?[assertNoHeaderControls(clean(env.OPENAI_MODEL)||OPENAI_DEFAULT_MODEL,'OPENAI_MODEL')]:[]
  });
}

function resolveThirdPartyProfile(env,id){
  const adapter=id==='third_party_responses'?'openai_responses_compatible':'openai_chat_completions_compatible';
  const provider=id==='third_party_responses'?'responses-compatible':'chat-completions-compatible';
  const enabled=enabledFlag(env.AI_PROVIDER_ENABLED);
  const baseUrlValue=clean(env.AI_PROVIDER_BASE_URL);
  const primaryModel=assertNoHeaderControls(clean(env.AI_PROVIDER_MODEL),'AI_PROVIDER_MODEL');
  const primaryCredential=assertNoHeaderControls(clean(env.AI_PROVIDER_API_KEY),'AI_PROVIDER_API_KEY');
  const grokModel=assertNoHeaderControls(clean(env.AI_PROVIDER_GROK_MODEL),'AI_PROVIDER_GROK_MODEL');
  const grokCredential=assertNoHeaderControls(clean(env.AI_PROVIDER_GROK_API_KEY),'AI_PROVIDER_GROK_API_KEY');
  const requestedActiveModel=assertNoHeaderControls(clean(env.AI_PROVIDER_ACTIVE_MODEL),'AI_PROVIDER_ACTIVE_MODEL');
  const networkZone=clean(env.AI_PROVIDER_NETWORK_ZONE)||'public_https';
  const allowAnonymous=enabledFlag(env.AI_PROVIDER_ALLOW_ANONYMOUS);
  const allowedOrigins=commaList(env.AI_PROVIDER_ALLOWED_ORIGINS).map(normalizeOrigin);
  if(!['public_https','local_loopback'].includes(networkZone))throw profileError('AI Provider network zone 无效');
  if(allowAnonymous&&networkZone!=='local_loopback')throw profileError('匿名第三方 Provider 只允许 local_loopback');
  const modelEntries=[
    {model:primaryModel,credential:primaryCredential,key:'primary'},
    {model:grokModel,credential:grokCredential,key:'grok'}
  ].filter(entry=>entry.model);
  const availableModels=modelEntries.map(entry=>entry.model);
  if(new Set(availableModels).size!==availableModels.length)throw profileError('AI Provider 双模型配置中的模型 ID 必须唯一');
  if(grokCredential&&!grokModel)throw profileError('AI_PROVIDER_GROK_API_KEY 已设置但 AI_PROVIDER_GROK_MODEL 为空');
  const activeModel=requestedActiveModel||primaryModel||grokModel;
  if(activeModel&&!availableModels.includes(activeModel))throw profileError('AI_PROVIDER_ACTIVE_MODEL 必须匹配已配置的模型 ID');
  const selected=modelEntries.find(entry=>entry.model===activeModel);
  const model=selected?.model||activeModel||null;
  const credential=selected?.credential||'';
  const configuredModels=modelEntries.filter(entry=>entry.credential||allowAnonymous).map(entry=>entry.model);
  const configured=Boolean(baseUrlValue&&model&&(credential||allowAnonymous));
  if(!enabled){
    return baseProfile({
      id,provider,adapter,model:model||null,credential:null,endpoint:null,workflowAllowlist:resolveWorkflowAllowlist(env.AI_PROVIDER_WORKFLOWS),
      reasoning:{requestedLevel:AI_REASONING_LEVEL,mode:'xhigh',degraded:false},structuredOutput:{mode:'strict_native',degraded:false},retention:{mode:'send',sendNoStore:true,degraded:false},
      enabled:false,configured,env,availableModels,configuredModels
    });
  }
  if(!configured)throw aiProviderError('AI_PROVIDER_NOT_CONFIGURED','第三方 AI Provider 尚未完整配置');
  if(!allowedOrigins.length)throw profileError('第三方 AI Provider 必须配置 AI_PROVIDER_ALLOWED_ORIGINS');
  const url=normalizeBaseUrl(baseUrlValue);
  if(!allowedOrigins.includes(url.origin))throw profileError('AI Provider endpoint 不在 allowed origins 中');
  return baseProfile({
    id,provider,adapter,model,credential:credential||null,
    endpoint:{id:`${id}_endpoint`,baseUrl:url.href.replace(/\/$/,''),origin:url.origin,networkZone,trustedBuiltIn:false},
    workflowAllowlist:resolveWorkflowAllowlist(env.AI_PROVIDER_WORKFLOWS),
    reasoning:resolveReasoning(env),structuredOutput:resolveStructuredOutput(env,adapter),retention:resolveRetention(env),
    enabled:true,configured:true,env,availableModels,configuredModels
  });
}

export function resolveProviderProfile({env=process.env,profileId}={}){
  const id=normalizeProfileId(profileId||env.AI_PROVIDER_PROFILE||env.AI_PROVIDER);
  if(!PROFILE_IDS.has(id))throw profileError(`未注册的 AI Provider Profile：${id}`);
  return id==='openai_luna'?resolveOpenAIProfile(env):resolveThirdPartyProfile(env,id);
}

export function assertWorkflowAllowed(profile,workflow){
  if(!WORKFLOW_SET.has(workflow))throw profileError(`未知 AI 工作流：${workflow}`);
  if(!profile.workflowAllowlist.includes(workflow))throw aiProviderError('AI_PROVIDER_PROFILE_INVALID','当前 AI Provider 未获准处理该工作流',{profileId:profile.id,adapterId:profile.adapter});
}

export async function validateEndpointProfile(profile){
  const endpoint=profile.endpoint;
  if(!endpoint)throw aiProviderError('AI_PROVIDER_NOT_CONFIGURED','AI Provider endpoint 尚未配置',{profileId:profile.id,adapterId:profile.adapter});
  const url=normalizeBaseUrl(endpoint.baseUrl);
  if(url.origin!==endpoint.origin)throw profileError('AI Provider endpoint origin 已变化');
  if(endpoint.networkZone==='local_loopback'){
    if(!['http:','https:'].includes(url.protocol)||!isLoopbackHost(url.hostname))throw profileError('local_loopback 只能访问本机 loopback endpoint');
    return url;
  }
  if(url.protocol!=='https:')throw profileError('公网 AI Provider 必须使用 HTTPS');
  if(endpoint.trustedBuiltIn)return url;
  const hostname=normalizeHostname(url.hostname);
  if(net.isIP(hostname)){
    if(!isPublicAddress(hostname))throw profileError('公网 AI Provider 不得指向私网或保留地址');
    return url;
  }
  if(hostname==='localhost'||hostname.endsWith('.local'))throw profileError('公网 AI Provider hostname 无效');
  let addresses;
  try{addresses=await lookupWithTimeout(hostname,profile.timeoutMs);}
  catch(error){
    if(error?.code==='AI_PROVIDER_TIMEOUT')throw error;
    throw aiProviderError('AI_PROVIDER_NETWORK_ERROR','无法解析 AI Provider endpoint',{cause:error,profileId:profile.id,adapterId:profile.adapter});
  }
  if(!addresses.length||addresses.some(entry=>!isPublicAddress(entry.address)))throw profileError('公网 AI Provider DNS 指向私网或保留地址');
  return url;
}

export function providerRuntimeConfig({env=process.env,profileId}={}){
  const profile=resolveProviderProfile({env,profileId});
  return {
    provider:profile.provider,
    profileId:profile.id,
    adapter:profile.adapter,
    model:profile.model,
    activeModel:profile.model,
    availableModels:profile.availableModels,
    configuredModels:profile.configuredModels,
    reasoningEffort:profile.reasoning.requestedLevel,
    structuredOutputMode:profile.structuredOutput.mode,
    configured:profile.configured,
    enabled:profile.enabled,
    degraded:profile.degraded
  };
}

export function providerEnabled({env=process.env,profileId}={}){
  try{
    const profile=resolveProviderProfile({env,profileId});
    return Boolean(profile.enabled&&profile.configured);
  }catch{return false;}
}

export function fileContentOutboundEnabled(env=process.env){
  if(Object.hasOwn(env,'AI_SEND_FILE_CONTENT'))return clean(env.AI_SEND_FILE_CONTENT)==='1';
  const profileId=normalizeProfileId(env.AI_PROVIDER_PROFILE||env.AI_PROVIDER);
  return profileId==='openai_luna'&&clean(env.OPENAI_SEND_FILE_CONTENT)==='1';
}

export function boundMaxOutputTokens(value){
  return Number.isInteger(value)?Math.min(AI_MAX_OUTPUT_TOKENS_LIMIT,Math.max(256,value)):AI_DEFAULT_MAX_OUTPUT_TOKENS;
}
