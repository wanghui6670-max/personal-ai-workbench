const DEFAULT_BASE_URL='https://aihot.virxact.com';
const ALLOWED_WINDOWS=new Set(['6h','12h','24h','3d','7d']);
const ALLOWED_MODES=new Set(['selected','all']);

function normalizeLimit(value){
  const limit=value===undefined?20:Number(value);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('AIHot limit must be an integer between 1 and 100');
  return limit;
}

function normalizeWindow(value){
  const window=String(value??'24h');
  if(!ALLOWED_WINDOWS.has(window))throw new TypeError(`Unsupported AIHot window: ${window}`);
  return window;
}

function normalizeMode(value){
  const mode=String(value??'selected');
  if(!ALLOWED_MODES.has(mode))throw new TypeError(`Unsupported AIHot mode: ${mode}`);
  return mode;
}

export class AihotClient{
  #fetch;
  #baseUrl;
  #cache=new Map();
  constructor({fetchImpl=globalThis.fetch,baseUrl=DEFAULT_BASE_URL}={}){
    if(typeof fetchImpl!=='function')throw new TypeError('AIHot fetch implementation is required');
    const parsed=new URL(baseUrl);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw new TypeError('AIHot base URL must be a clean HTTPS origin');
    this.#fetch=fetchImpl;
    this.#baseUrl=parsed.origin;
  }
  async latest({limit=20,window='24h',mode='selected'}={}){
    const params=new URLSearchParams({mode:normalizeMode(mode),window:normalizeWindow(window),limit:String(normalizeLimit(limit))});
    const url=`${this.#baseUrl}/api/v1/items?${params}`;
    const cached=this.#cache.get(url);
    const headers={Accept:'application/json','User-Agent':'personal-ai-workbench-aihot/1.0'};
    if(cached?.etag)headers['If-None-Match']=cached.etag;
    const response=await this.#fetch(url,{method:'GET',headers,redirect:'error'});
    if(response.status===304){
      if(!cached)throw new Error('AIHot returned 304 without a cached response');
      return cached.body;
    }
    if(!response.ok)throw new Error(`AIHot request failed with HTTP ${response.status}`);
    const body=await response.json();
    const etag=response.headers?.get?.('etag')||null;
    this.#cache.set(url,{etag,body});
    return body;
  }
}

export const AIHOT_BASE_URL=DEFAULT_BASE_URL;
