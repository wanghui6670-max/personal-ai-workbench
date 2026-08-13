import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {JsonStore} from '../src/store.mjs';
import {createWorkbenchRegistry} from '../src/mcp/registry.mjs';
import {planAIConsole} from '../src/ai.mjs';

async function setup(){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-mcp-'));
  const dataDir=path.join(root,'data');await fsp.mkdir(dataDir,{recursive:true});
  const store=new JsonStore(dataDir);await store.ensure();
  return {root,store};
}

test('MCP registry exposes a bounded tool list and requires confirmation for writes',async t=>{
  const {root,store}=await setup();t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const registry=createWorkbenchRegistry({appRoot:root,store});
  const names=registry.list().map(tool=>tool.name);
  assert.ok(names.includes('workbench_get_state'));
  assert.ok(names.includes('panel_navigate'));
  assert.ok(names.includes('todo_today'));
  assert.ok(names.includes('inbox_process'));
  assert.equal(names.some(name=>/shell|exec|filesystem|http/i.test(name)),false);

  const added=await registry.call('inbox_add',{text:'MCP 确认门测试'},{confirmed:true});
  const inboxId=added.result.id;
  assert.equal(added.state.inbox.some(item=>item.id===inboxId),true);
  await assert.rejects(registry.call('inbox_process',{itemId:inboxId,command:'做成独立待办，2026年8月20日截止'}),error=>error.code==='MCP_CONFIRMATION_REQUIRED');
  const processed=await registry.call('inbox_process',{itemId:inboxId,command:'做成独立待办，2026年8月20日截止'},{confirmed:true});
  assert.equal(processed.state.todos.length,1);
  assert.equal(processed.state.todayTodos.length,0,'MCP must not auto-schedule a todo');
  const todoId=processed.state.todos[0].id;
  await assert.rejects(registry.call('todo_today',{todoId,add:true}),error=>error.code==='MCP_CONFIRMATION_REQUIRED');
  const scheduled=await registry.call('todo_today',{todoId,add:true},{confirmed:true});
  assert.deepEqual(scheduled.state.todayPlan,[todoId]);
  const panel=await registry.call('panel_navigate',{view:'journal',id:null,modal:'none'});
  assert.deepEqual(panel.result.navigation,{view:'journal',id:null,modal:'none'});
  assert.equal(panel.state.inbox.length,0,'panel navigation must read back the same shared state');
});

test('MCP planner is read-only for ambiguous instructions and maps explicit actions',async t=>{
  const {root,store}=await setup();t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const registry=createWorkbenchRegistry({appRoot:root,store});
  await registry.call('inbox_add',{text:'准备工作台验收'},{confirmed:true});
  const read=await registry.plan('查看收件箱');
  assert.equal(read.toolName,'inbox_search');
  assert.equal(read.confirmationRequired,false);
  const ambiguous=await registry.plan('把它处理一下');
  assert.equal(ambiguous.kind,'clarification');
  const needsDate=await registry.plan('把准备工作台验收做成待办');
  assert.equal(needsDate.kind,'clarification');
  assert.match(needsDate.message,/截止日期/);
  const navigate=await registry.plan('打开工作日志');
  assert.equal(navigate.toolName,'panel_navigate');
  assert.deepEqual(navigate.args,{view:'journal',id:null,modal:'none'});
  assert.equal(navigate.confirmationRequired,false);
  const settings=await registry.plan('打开设置');
  assert.equal(settings.toolName,'panel_navigate');
  assert.deepEqual(settings.args,{view:'today',id:null,modal:'settings'});
});

test('model-backed console planner can only propose an allow-listed tool and keeps arguments auditable',async()=>{
  const tools=[{name:'inbox_search',description:'读取收件箱',inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string'}},required:[]},readOnly:true,requiresConfirmation:false}];
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='unit-console-key';
  try{
    let request;
    const result=await planAIConsole({
      message:'查看收件箱',state:{inbox:[],projects:[],todos:[],todayPlan:[],confirmations:[]},tools,
      fetchImpl:async(url,options)=>{request={url,options};const body=JSON.parse(options.body);const output={analysis:{evidence:[{id:'user_message',observation:'用户明确要求读取收件箱'}],conflicts:[],gaps:[]},decision:{kind:'tool',toolName:'inbox_search',argsJson:JSON.stringify({query:''}),reason:'读取收件箱',message:'已准备只读读取'}};return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}),{status:200});}
    });
    assert.equal(result.toolName,'inbox_search');
    assert.deepEqual(result.args,{query:''});
    assert.equal(result.analysis.evidence[0].id,'user_message');
    assert.equal(request.url,'https://api.openai.com/v1/responses');
    const body=JSON.parse(request.options.body);assert.equal(body.model,'gpt-5.6-luna');assert.equal(body.text.format.schema.properties.decision.properties.argsJson.type,'string');
  }finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
});

function waitFor(url,timeout=8000){
  const start=Date.now();
  return new Promise((resolve,reject)=>{
    const tick=async()=>{if(Date.now()-start>=timeout)return reject(new Error('server did not start'));try{const response=await fetch(url);if(response.ok)return resolve();}catch{}setTimeout(tick,80);};
    tick();
  });
}
function request(base,url,body,method='POST'){
  return fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)}).then(async response=>({response,data:await response.json()}));
}

test('HTTP AI plan/execute and MCP transport read back the shared state',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-mcp-http-'));const dataDir=path.join(root,'data'),workspace=path.join(root,'workspace');await fsp.mkdir(dataDir,{recursive:true});await fsp.mkdir(workspace,{recursive:true});
  const port=41000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dataDir,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:'',WORKBENCH_PASSWORD:'',SESSION_SECRET:'',TRUSTED_ORIGINS:'',CAPTURE_TOKEN:''},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await fsp.rm(root,{recursive:true,force:true});});
  await waitFor(base+'/api/health');
  let result=await request(base,'/api/ai/tools',null,'GET');assert.equal(result.response.status,200);assert.ok(result.data.tools.some(tool=>tool.name==='todo_today'));
  result=await request(base,'/api/inbox',{text:'HTTP MCP 收件箱事项'});assert.equal(result.response.status,201);const inboxId=result.data.item.id;
  result=await request(base,'/api/ai/plan',{message:'查看收件箱'});assert.equal(result.response.status,200);assert.equal(result.data.plan.toolName,'inbox_search');assert.equal(result.data.plan.confirmationRequired,false);
  result=await request(base,'/api/ai/execute',{planId:result.data.plan.id,confirmed:true});assert.equal(result.response.status,200);assert.equal(result.data.readback,true);assert.ok(result.data.state.inbox.some(item=>item.id===inboxId));
  result=await request(base,'/api/mcp',{jsonrpc:'2.0',id:'init-1',method:'initialize',params:{}});assert.equal(result.response.status,200);assert.equal(result.data.result.serverInfo.name,'personal-ai-workbench');
  result=await request(base,'/api/mcp',{jsonrpc:'2.0',id:'ready-1',method:'notifications/initialized',params:{}});assert.equal(result.response.status,200);assert.deepEqual(result.data.result,{});
  result=await request(base,'/api/mcp',{jsonrpc:'2.0',id:'list-1',method:'tools/list',params:{}});assert.equal(result.response.status,200);assert.equal(result.data.result.tools.some(tool=>tool.name==='workbench_get_state'),true);
  result=await request(base,'/api/mcp',{jsonrpc:'2.0',id:'call-1',method:'tools/call',params:{name:'workbench_get_state',arguments:{}}});assert.equal(result.response.status,200);assert.equal(result.data.result.structuredContent.readback,true);assert.ok(result.data.result.structuredContent.state.inbox.some(item=>item.id===inboxId));
  result=await request(base,'/api/mcp',{jsonrpc:'2.0',id:'bad-write',method:'tools/call',params:{name:'inbox_add',arguments:{text:'must confirm'}}});assert.equal(result.response.status,200);assert.equal(result.data.error.code,-32001);
});
