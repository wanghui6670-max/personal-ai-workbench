import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHarnessHttp } from '../src/harness-http.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from '../src/harness-policy.mjs';

async function fixture(t){
  const token='h'.repeat(43);
  const calls=[];
  const navigator={
    bridgeToken:token,
    status:()=>({enabled:true,available:true,state:'ready'}),
    run:async input=>({sessionId:'s1',reply:`seen:${input.message}`,trajectory:[],navigation:null,readOnly:true})
  };
  const mcpRegistry={
    list:options=>{
      calls.push({kind:'list',options});
      return[{name:'project_list',description:'read',inputSchema:{type:'object'},readOnly:true,requiresConfirmation:false}];
    },
    call:async(name,args,options)=>{
      calls.push({kind:'call',name,args,options});
      return{result:[{id:'p1'}]};
    }
  };
  const toolBroker={call:(name,args,options)=>mcpRegistry.call(name,args,options)};
  const handlers=createHarnessHttp({navigator,mcpRegistry,toolBroker});
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(await handlers.handleBridge(req,res,pathname))return;
    if(await handlers.handleUser(req,res,pathname,{rateLimit:()=>false}))return;
    res.writeHead(404);res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return{base:`http://127.0.0.1:${server.address().port}`,token,calls};
}

async function rpc(base,token,method,params={}){
  const response=await fetch(`${base}/api/harness/mcp`,{
    method:'POST',
    headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({jsonrpc:'2.0',id:'1',method,params})
  });
  return{response,body:await response.json()};
}

test('internal bridge is token protected and always applies read-only options',async t=>{
  const f=await fixture(t);
  let response=await fetch(`${f.base}/api/harness/mcp`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'1',method:'tools/list',params:{}})
  });
  assert.equal(response.status,403);

  let result=await rpc(f.base,f.token,'tools/list');
  assert.equal(result.response.status,200);
  assert.equal(result.body.result.tools[0].name,'project_list');
  assert.deepEqual(f.calls[0].options,{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST});

  result=await rpc(f.base,f.token,'tools/call',{name:'project_list',arguments:{includeArchived:false}});
  assert.equal(result.body.result.structuredContent.readback,true);
  assert.deepEqual(f.calls[1].options,{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST});
  assert.equal(f.calls[1].name,'project_list');
});

test('user endpoint returns only the bounded Navigator result contract',async t=>{
  const f=await fixture(t);
  const status=await fetch(`${f.base}/api/harness/status`);
  assert.equal(status.status,200);
  assert.equal((await status.json()).navigator.available,true);

  const response=await fetch(`${f.base}/api/harness/navigator`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({message:'查看项目',sessionId:null,view:'project',id:'p1'})
  });
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.navigator.reply,'seen:查看项目');
  assert.equal(body.navigator.readOnly,true);
});
