import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { harnessNodeSupported } from '../src/harness-navigator.mjs';

if(!harnessNodeSupported())throw new Error('Harness E2E requires Node 22.19+ or Node 24+');

const root=path.resolve('.');
const harnessDir=path.join(root,'harness');
const require=createRequire(path.join(harnessDir,'package.json'));
const sdkEntry=require.resolve('@deepseek-ai/dsh-sdk-client');
require.resolve('@deepseek-ai/dsh-llm-replay/package.json');
const {DeepSeekHarness}=await import(pathToFileURL(sdkEntry).href);

const token='navigator-e2e-token-'.padEnd(48,'x');
const toolNames=[
  'panel_navigate','inbox_search','project_list','todo_list',
  'journal_read','confirmation_list','business_list','project_records_read'
];
const calls=[];

function schema(name){
  if(name==='project_list')return{type:'object',additionalProperties:false,properties:{includeArchived:{type:'boolean'}},required:[]};
  if(name==='panel_navigate')return{type:'object',additionalProperties:false,properties:{view:{type:'string'},id:{anyOf:[{type:'string'},{type:'null'}]},modal:{type:'string'}},required:['view']};
  return{type:'object',additionalProperties:false,properties:{},required:[]};
}

const bridge=http.createServer(async(req,res)=>{
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  let body={};
  try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
  if(req.headers.authorization!==`Bearer ${token}`){
    res.writeHead(403,{'content-type':'application/json'});res.end('{"error":"denied"}');return;
  }
  let result;
  if(body.method==='tools/list'){
    result={tools:toolNames.map(name=>({name,description:`E2E ${name}`,inputSchema:schema(name),readOnly:true,requiresConfirmation:false}))};
  }else if(body.method==='tools/call'){
    calls.push({name:body.params?.name,args:body.params?.arguments});
    if(body.params?.name!=='project_list'){
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'unexpected tool'}}));return;
    }
    const projects=[{id:'project-e2e',name:'端到端测试项目',status:'active'}];
    result={content:[{type:'text',text:JSON.stringify(projects)}],structuredContent:{result:projects,readback:true}};
  }else result={};
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({jsonrpc:'2.0',id:body.id??null,result}));
});

bridge.listen(0,'127.0.0.1');
await once(bridge,'listening');
const address=bridge.address();
const childEnv={
  PATH:process.env.PATH,
  HOME:process.env.HOME,
  TMPDIR:process.env.TMPDIR||'/tmp',
  JOYCREW_BRIDGE_URL:`http://127.0.0.1:${address.port}/api/harness/mcp`,
  JOYCREW_BRIDGE_TOKEN:token,
  DSH_SNAPSHOT_FILE:path.join(harnessDir,'fixtures','navigator-session.jsonl'),
  DSH_SNAPSHOT_OVERRIDE:path.join(harnessDir,'fixtures','navigator-replay.override.json'),
  DSH_TELEMETRY_DISABLED:'1',
  NO_COLOR:'1'
};

const harness=new DeepSeekHarness({
  launch:{
    command:process.execPath,
    args:[path.join(harnessDir,'runtime-bin.mjs'),path.join(harnessDir,'navigator.test.cordis.yml')],
    cwd:harnessDir,
    env:childEnv,
    requestTimeoutMs:30_000,
    shutdownTimeoutMs:1500,
    disposeEofGraceMs:6000,
    disposeGraceMs:3000
  },
  cwd:root,
  provider:'joycrew',
  model:'navigator-replay',
  maxTokens:512
});

try{
  const first=await harness.run('请查看项目');
  assert.equal(first.finalResponse,'已读取 1 个项目：端到端测试项目。');
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'project_list');
  assert.deepEqual(calls[0].args,{});
  assert.ok(first.events.some(event=>event.type==='tool/call'&&event.data?.name==='joycrew__project_list'));
  assert.ok(first.events.some(event=>event.type==='tool/result'));

  const second=await harness.run('继续',{sessionId:first.sessionId});
  assert.equal(second.sessionId,first.sessionId);
  assert.equal(second.finalResponse,'同一会话可以继续。');
  assert.equal(calls.length,1,'second turn must retain context without inventing another tool call');
  console.log('Harness Navigator E2E passed: prompt -> tool call -> bridge -> tool result -> final reply -> continued session.');
}finally{
  await harness.close().catch(()=>undefined);
  await new Promise(resolve=>bridge.close(resolve));
}
