const BASE_URL='https://aihot.virxact.com';
const MAX_LIMIT=50;
const REQUEST_TIMEOUT_MS=15_000;

function boundedLimit(value,fallback=20){
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<1)return fallback;
  return Math.min(MAX_LIMIT,parsed);
}

async function requestJson(fetchImpl,path,params={}){
  const url=new URL(path,BASE_URL);
  for(const [key,value] of Object.entries(params)){
    if(value===undefined||value===null||value==='')continue;
    url.searchParams.set(key,String(value));
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try{
    const response=await fetchImpl(url,{headers:{Accept:'application/json','User-Agent':'personal-ai-workbench-harness/4.0'},signal:controller.signal});
    if(!response?.ok)throw new Error(`AIHot request failed: ${response?.status??'unknown'}`);
    const data=await response.json();
    if(!data||typeof data!=='object')throw new Error('AIHot returned invalid JSON payload');
    return data;
  }finally{
    clearTimeout(timer);
  }
}

export function createAIHotPlugin({fetchImpl=globalThis.fetch}={}){
  if(typeof fetchImpl!=='function')throw new Error('AIHot fetch implementation is required');
  const latestTool={
    name:'aihot.latest',
    risk:'read',
    inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:50},category:{type:'string'},keyword:{type:'string'}},additionalProperties:true},
    execute:async args=>requestJson(fetchImpl,'/api/public/items',{
      limit:boundedLimit(args?.limit),
      category:typeof args?.category==='string'?args.category:'',
      q:typeof args?.keyword==='string'?args.keyword:''
    })
  };
  const dailyTool={
    name:'aihot.daily',
    risk:'read',
    inputSchema:{type:'object',properties:{date:{type:'string'}},additionalProperties:true},
    execute:async args=>requestJson(fetchImpl,'/api/public/daily',{
      date:typeof args?.date==='string'?args.date:''
    })
  };
  return Object.freeze({
    manifest:Object.freeze({id:'aihot',version:'1.0.0',adapter:'./index.mjs'}),
    capabilities:Object.freeze([Object.freeze({
      id:'aihot',
      version:'1.0.0',
      kind:'information-source',
      tools:Object.freeze([latestTool,dailyTool])
    })])
  });
}
