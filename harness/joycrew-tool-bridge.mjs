const MAX_RESPONSE_BYTES=1_000_000;
const NAME_PATTERN=/^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_RAW_NAMES=new Set([
  'panel_navigate',
  'inbox_search',
  'project_list',
  'todo_list',
  'journal_read',
  'confirmation_list',
  'business_list',
  'project_records_read'
]);

function config(){
  const url=String(process.env.JOYCREW_BRIDGE_URL||'').trim();
  const token=String(process.env.JOYCREW_BRIDGE_TOKEN||'').trim();
  if(!url||token.length<32)throw new Error('Joycrew bridge URL/token missing');
  let parsed;
  try{parsed=new URL(url);}catch{throw new Error('Joycrew bridge URL invalid');}
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash){
    throw new Error('Joycrew bridge URL unsafe');
  }
  return {url:parsed.toString(),token};
}

async function readBoundedJson(response){
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.byteLength>MAX_RESPONSE_BYTES)throw new Error('Joycrew bridge response too large');
  try{return JSON.parse(buffer.toString('utf8'));}
  catch{throw new Error('Joycrew bridge returned invalid JSON');}
}

function rpcError(payload){
  const message=String(payload?.error?.message||'Joycrew bridge request failed').slice(0,500);
  const error=new Error(message);
  error.code=String(payload?.error?.code||'JOYCREW_BRIDGE_ERROR');
  return error;
}

function createRpcClient(){
  const {url,token}=config();
  let nextId=1;
  return async(method,params={},signal)=>{
    const response=await fetch(url,{
      method:'POST',
      redirect:'error',
      headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
      body:JSON.stringify({jsonrpc:'2.0',id:String(nextId++),method,params}),
      ...(signal?{signal}:{})
    });
    if(!response.ok)throw new Error(`Joycrew bridge HTTP ${response.status}`);
    const payload=await readBoundedJson(response);
    if(payload?.error)throw rpcError(payload);
    return payload?.result;
  };
}

function publicName(rawName){
  const joined=`joycrew__${rawName}`.replace(/[^A-Za-z0-9_-]/g,'_');
  if(!NAME_PATTERN.test(joined))throw new Error(`Joycrew tool name is not model-safe: ${rawName}`);
  return joined;
}

function resultText(value){
  const text=JSON.stringify(value);
  return text.length<=50_000?text:`${text.slice(0,49_999)}…`;
}

export function normalizeInputSchema(value){
  if(Array.isArray(value))return value.map(normalizeInputSchema);
  if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'anyOf')&&Object.hasOwn(value,'oneOf')){
    throw new Error('Joycrew tool schema cannot declare both anyOf and oneOf');
  }
  const normalized={};
  for(const [key,item] of Object.entries(value))normalized[key==='anyOf'?'oneOf':key]=normalizeInputSchema(item);
  return normalized;
}

function createDefinition(rpc,tool){
  const rawName=String(tool.name);
  return {
    name:publicName(rawName),
    description:`Joycrew 只读工具：${String(tool.description||rawName)}`,
    parameters:normalizeInputSchema(tool.inputSchema||{type:'object',additionalProperties:false,properties:{}}),
    output:{
      schema:{
        type:'object',
        properties:{result:{},readback:{type:'boolean'}},
        required:['result','readback'],
        additionalProperties:false
      },
      render(_args,value){return [{type:'text',text:resultText(value)}];}
    },
    async execute(args,exec){
      const result=await rpc('tools/call',{name:rawName,arguments:args&&typeof args==='object'?args:{}},exec.signal);
      const structured=result?.structuredContent;
      return {
        result:structured&&Object.hasOwn(structured,'result')?structured.result:null,
        readback:Boolean(structured?.readback)
      };
    }
  };
}

export const name='joycrew-readonly-tool-bridge';
export const inject=['tools'];

export async function apply(ctx){
  const rpc=createRpcClient();
  const listed=await rpc('tools/list',{});
  const tools=Array.isArray(listed?.tools)?listed.tools:[];
  if(tools.length!==ALLOWED_RAW_NAMES.size)throw new Error('Joycrew bridge tool catalog does not match the fixed Navigator contract');

  const seen=new Set();
  const definitions=[];
  for(const tool of tools){
    const rawName=String(tool?.name||'');
    if(!rawName||!ALLOWED_RAW_NAMES.has(rawName)||tool?.readOnly!==true||tool?.requiresConfirmation===true){
      throw new Error(`Joycrew bridge returned an unreviewed or non-read-only tool: ${rawName||'(unnamed)'}`);
    }
    const modelName=publicName(rawName);
    if(seen.has(modelName))throw new Error(`Duplicate Joycrew tool: ${modelName}`);
    seen.add(modelName);
    definitions.push(createDefinition(rpc,tool));
  }
  if(seen.size!==ALLOWED_RAW_NAMES.size)throw new Error('Joycrew bridge tool catalog is incomplete');

  // Tool registrations are lifecycle resources. Keep every disposer inside a
  // Cordis effect so activation publishes the full generation and unloading
  // removes it. Direct registration in an async continuation is not durable.
  ctx.effect(()=>{
    const disposers=[];
    try{
      for(const definition of definitions)disposers.push(ctx.tools.register(definition));
    }catch(error){
      for(const dispose of disposers.reverse())dispose();
      throw error;
    }
    return()=>{for(const dispose of disposers.reverse())dispose();};
  },'joycrew-readonly-tool-bridge.tools');
}
