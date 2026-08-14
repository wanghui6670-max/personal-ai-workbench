import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { harnessNodeSupported } from '../src/harness-navigator.mjs';

if(!harnessNodeSupported())throw new Error('Harness compile smoke requires Node 22.19+ or Node 24+');

const root=path.resolve('.');
const harnessDir=path.join(root,'harness');
const require=createRequire(path.join(harnessDir,'package.json'));
const sdkEntry=require.resolve('@deepseek-ai/dsh-sdk-client');
require.resolve('@deepseek-ai/dsh/package.json');
require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-server/package.json');
require.resolve('@deepseek-ai/dsh-mcp-client/package.json');
const runtimeBin=path.join(harnessDir,'runtime-bin.mjs');
const configPath=path.join(harnessDir,'navigator.cordis.yml');
const {DeepSeekHarness}=await import(pathToFileURL(sdkEntry).href);
if(typeof DeepSeekHarness!=='function')throw new Error('DeepSeekHarness export is unavailable');

const token='compile-smoke-token-'.padEnd(48,'x');
const SMOKE_TOOL_NAMES=[
  'panel_navigate','inbox_search','project_list','todo_list',
  'journal_read','confirmation_list','business_list','project_records_read'
];

function smokeSchema(name){
  if(name==='panel_navigate'){
    return{type:'object',additionalProperties:false,properties:{view:{type:'string',enum:['today','project']},id:{anyOf:[{type:'string',minLength:1},{type:'null'}]}},required:['view']};
  }
  return{type:'object',additionalProperties:false,properties:{}};
}

const bridge=http.createServer(async(req,res)=>{
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  let body={};
  try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(403,{'content-type':'application/json'});res.end('{"error":"denied"}');return;}
  let result;
  if(body.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'joycrew-smoke',version:'1.0.0'}};
  else if(body.method==='tools/list')result={tools:SMOKE_TOOL_NAMES.map(name=>({name,description:`compile smoke ${name}`,inputSchema:smokeSchema(name),readOnly:true,requiresConfirmation:false}))};
  else if(body.method==='tools/call')result={content:[{type:'text',text:'[]'}],structuredContent:{result:[],readback:true}};
  else result={};
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({jsonrpc:'2.0',id:body.id??null,result}));
});
bridge.listen(0,'127.0.0.1');
await once(bridge,'listening');
const address=bridge.address();
const childEnv={
  PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp',
  HARNESS_PROVIDER_API_KEY:'compile-smoke-not-a-real-secret',HARNESS_PROVIDER_MODEL:'compile-smoke-model',
  HARNESS_PROVIDER_API:'openai-responses',HARNESS_PROVIDER_BASE_URL:'https://example.invalid/v1',
  HARNESS_PROVIDER_CONTEXT_WINDOW:'32768',HARNESS_PROVIDER_MAX_TOKENS:'512',
  JOYCREW_BRIDGE_URL:`http://127.0.0.1:${address.port}/api/harness/mcp`,JOYCREW_BRIDGE_TOKEN:token,
  DSH_TELEMETRY_DISABLED:'1',NO_COLOR:'1'
};

const harness=new DeepSeekHarness({
  launch:{command:process.execPath,args:[runtimeBin,configPath],cwd:harnessDir,env:childEnv,requestTimeoutMs:30_000,shutdownTimeoutMs:1500,disposeEofGraceMs:6000,disposeGraceMs:3000},
  cwd:root,provider:'joycrew',model:'compile-smoke-model',maxTokens:512
});
try{await harness.start();console.log('Harness Navigator composition compiled and initialized successfully.');}
finally{await harness.close().catch(()=>undefined);await new Promise(resolve=>bridge.close(resolve));}
