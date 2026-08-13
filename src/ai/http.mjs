import { aiProviderError, normalizeProviderFailure } from './errors.mjs';

const DEFAULT_MAX_RESPONSE_BYTES=2_000_000;

function concatChunks(chunks,total){
  const output=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}
  return output;
}

export async function readJsonBodyBounded(response,maxBytes=DEFAULT_MAX_RESPONSE_BYTES){
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes)throw aiProviderError('AI_PROVIDER_RESPONSE_TOO_LARGE','AI Provider 响应超过大小上限');
  let bytes;
  if(response.body?.getReader){
    const reader=response.body.getReader();
    const chunks=[];
    let total=0;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      const chunk=value instanceof Uint8Array?value:new Uint8Array(value);
      total+=chunk.byteLength;
      if(total>maxBytes){
        try{await reader.cancel();}catch{}
        throw aiProviderError('AI_PROVIDER_RESPONSE_TOO_LARGE','AI Provider 响应超过大小上限');
      }
      chunks.push(chunk);
    }
    bytes=concatChunks(chunks,total);
  }else if(typeof response.arrayBuffer==='function'){
    const buffer=await response.arrayBuffer();
    if(buffer.byteLength>maxBytes)throw aiProviderError('AI_PROVIDER_RESPONSE_TOO_LARGE','AI Provider 响应超过大小上限');
    bytes=new Uint8Array(buffer);
  }else if(typeof response.json==='function'){
    // Keep the unit-test/fake-fetch boundary compatible with the pre-Provider
    // contract. Real fetch Responses expose body/arrayBuffer, so this branch
    // cannot bypass the bounded streaming path in production.
    let parsed;
    try{parsed=await response.json();}
    catch{throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','AI Provider 返回格式无效');}
    let serialized;
    try{serialized=JSON.stringify(parsed);}
    catch{throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','AI Provider 返回格式无效');}
    if(new TextEncoder().encode(serialized).byteLength>maxBytes)throw aiProviderError('AI_PROVIDER_RESPONSE_TOO_LARGE','AI Provider 响应超过大小上限');
    return parsed;
  }else{
    throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','AI Provider 返回格式无效');
  }
  try{return JSON.parse(new TextDecoder().decode(bytes));}
  catch{throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','AI Provider 返回格式无效');}
}

export async function postProviderJson({url,headers,body,timeoutMs,maxResponseBytes,fetchImpl=globalThis.fetch,profileId,adapterId}){
  if(typeof fetchImpl!=='function')throw aiProviderError('AI_PROVIDER_NETWORK_ERROR','当前运行时不支持 AI Provider 网络请求',{profileId,adapterId});
  let response;
  try{
    response=await fetchImpl(url,{
      method:'POST',
      headers:{'Content-Type':'application/json',...headers},
      redirect:'error',
      signal:AbortSignal.timeout(timeoutMs),
      body:JSON.stringify(body)
    });
  }catch(error){throw normalizeProviderFailure(error,{profileId,adapterId});}
  if(!response?.ok){
    try{await response?.body?.cancel?.();}catch{}
    const status=Number.isInteger(response?.status)?response.status:undefined;
    const code=status===429?'AI_PROVIDER_RATE_LIMITED':(status===401||status===403)?'AI_PROVIDER_AUTH_FAILED':'AI_PROVIDER_HTTP_ERROR';
    const message=status===429?'AI Provider 请求被限流':(status===401||status===403)?'AI Provider 认证失败':`AI Provider 请求失败（HTTP ${status??'unknown'}）`;
    throw aiProviderError(code,message,{status,profileId,adapterId});
  }
  try{return await readJsonBodyBounded(response,maxResponseBytes);}
  catch(error){throw normalizeProviderFailure(error,{profileId,adapterId});}
}
