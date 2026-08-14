#!/usr/bin/env node
import readline from 'node:readline';
import { normalizeInputSchema } from './joycrew-schema.mjs';

const MAX_RESPONSE_BYTES=2_000_000;
const ALLOWED_RAW_NAMES=new Set([
  'panel_navigate','inbox_search','project_list','todo_list',
  'journal_read','confirmation_list','business_list','project_records_read',
  'joycrew_workspace_open','joycrew_status_read','joycrew_dashboard_read',
  'joycrew_project_list','joycrew_project_read','joycrew_customer_list',
  'joycrew_task_list','joycrew_approval_list','joycrew_deliverable_list',
  'joycrew_pending_action_list','joycrew_run_prepare',
  'joycrew_deliverable_prepare','joycrew_approval_prepare'
]);

function runtimeConfig(){
  const rawUrl=String(process.env.JOYCREW_BRIDGE_URL||'').trim();
  const token=String(process.env.JOYCREW_BRIDGE_TOKEN||'').trim();
  if(!rawUrl||token.length<32)throw new Error('Workbench MCP proxy configuration is missing');
  let url;
  try{url=new URL(rawUrl);}catch{throw new Error('Workbench MCP proxy URL is invalid');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash){
    throw new Error('Workbench MCP proxy URL is unsafe');
  }
  return{url:url.toString(),token};
}

async function boundedJson(response){
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.byteLength>MAX_RESPONSE_BYTES)throw new Error('Workbench MCP proxy response is too large');
  try{return JSON.parse(buffer.toString('utf8'));}
  catch{throw new Error('Workbench MCP proxy received invalid JSON');}
}

function normalizeToolList(payload){
  const tools=payload?.result?.tools;
  if(!Array.isArray(tools))throw new Error('Workbench MCP proxy received no tool list');
  if(tools.length!==ALLOWED_RAW_NAMES.size)throw new Error('Workbench MCP tool catalog size changed');
  const seen=new Set();
  payload.result.tools=tools.map(tool=>{
    const name=String(tool?.name||'');
    if(!ALLOWED_RAW_NAMES.has(name)||seen.has(name))throw new Error('Workbench MCP tool catalog contains an unreviewed name');
    seen.add(name);
    return{
      name,
      description:String(tool.description||name),
      inputSchema:normalizeInputSchema(tool.inputSchema||{type:'object',properties:{},additionalProperties:false})
    };
  });
  return payload;
}

function publicError(id,message='Workbench MCP proxy request failed'){
  return{jsonrpc:'2.0',id,error:{code:-32000,message}};
}

const {url,token}=runtimeConfig();
let output=Promise.resolve();
function send(payload){
  output=output.then(()=>new Promise((resolve,reject)=>{
    process.stdout.write(`${JSON.stringify(payload)}\n`,error=>error?reject(error):resolve());
  }));
  return output;
}

async function forward(message){
  const hasId=Object.hasOwn(message,'id');
  const originalId=message.id;
  if(message.method==='tools/call'&&!ALLOWED_RAW_NAMES.has(String(message.params?.name||''))){
    if(hasId)await send(publicError(originalId,'Tool is not allowed by the unified Workbench proxy'));
    return;
  }
  const forwarded={...message};
  if(hasId)forwarded.id=String(originalId);
  const response=await fetch(url,{
    method:'POST',
    redirect:'error',
    headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify(forwarded)
  });
  if(!response.ok)throw new Error(`Workbench MCP proxy HTTP ${response.status}`);
  let payload=await boundedJson(response);
  if(message.method==='tools/list')payload=normalizeToolList(payload);
  if(!hasId)return;
  payload.id=originalId;
  await send(payload);
}

const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
const pending=new Set();
for await(const line of input){
  if(!line.trim())continue;
  let message;
  try{message=JSON.parse(line);}catch{
    await send(publicError(null,'Invalid JSON-RPC message'));
    continue;
  }
  const task=forward(message).catch(async error=>{
    if(Object.hasOwn(message,'id'))await send(publicError(message.id));
    process.stderr.write(`[workbench-mcp-proxy] ${String(error?.message||'request failed').slice(0,300)}\n`);
  });
  pending.add(task);
  void task.finally(()=>pending.delete(task));
}
await Promise.allSettled([...pending]);
await output;
