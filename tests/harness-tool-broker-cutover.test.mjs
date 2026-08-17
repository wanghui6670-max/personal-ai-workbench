import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import {once} from 'node:events';
import {createHarnessHttp} from '../src/harness-http.mjs';
import {HARNESS_NAVIGATOR_TOOL_ALLOWLIST} from '../src/harness-policy.mjs';

async function rpc(base,token,method,params={}){
  const response=await fetch(`${base}/api/harness/mcp`,{
    method:'POST',
    headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({jsonrpc:'2.0',id:'cutover',method,params})
  });
  return{response,body:await response.json()};
}

test('Harness MCP tools/call uses Tool Broker instead of calling the legacy MCP registry directly',async t=>{
  const token='b'.repeat(43);
  const brokerCalls=[];
  const navigator={bridgeToken:token,status:()=>({enabled:true,available:true}),run:async()=>({})};
  const mcpRegistry={
    list:()=>[{name:'project_list',description:'read',inputSchema:{type:'object'},readOnly:true,requiresConfirmation:false}],
    call:async()=>{throw new Error('direct mcpRegistry.call is forbidden after Tool Broker cutover');}
  };
  const toolBroker={
    call:async(name,args,options)=>{
      brokerCalls.push({name,args,options});
      return{result:[{id:'p1'}]};
    }
  };
  const handlers=createHarnessHttp({navigator,mcpRegistry,toolBroker});
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(await handlers.handleBridge(req,res,pathname))return;
    res.writeHead(404);res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));

  const base=`http://127.0.0.1:${server.address().port}`;
  const result=await rpc(base,token,'tools/call',{name:'project_list',arguments:{includeArchived:false}});
  assert.equal(result.body.result.structuredContent.readback,true);
  assert.deepEqual(brokerCalls,[{
    name:'project_list',
    args:{includeArchived:false},
    options:{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST}
  }]);
});

test('server composition explicitly installs Capability Registry, legacy provider, Tool Broker and legacy invoker',async()=>{
  const source=await fsp.readFile('src/server.mjs','utf8');
  assert.match(source,/CapabilityRegistry/);
  assert.match(source,/createLegacyMcpProvider/);
  assert.match(source,/ToolBroker/);
  assert.match(source,/createLegacyMcpInvoker/);
  assert.match(source,/createHarnessHttp\(\{navigator:harnessNavigator,mcpRegistry,toolBroker:harnessToolBroker\}\)/);
});
