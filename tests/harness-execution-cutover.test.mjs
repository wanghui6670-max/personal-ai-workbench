import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import {once} from 'node:events';
import {CapabilityRegistry} from '../src/harness-core/capability-registry.mjs';
import {ToolBroker} from '../src/harness-core/tool-broker.mjs';
import {createHarnessHttp} from '../src/harness-http.mjs';
import {HARNESS_NAVIGATOR_TOOL_ALLOWLIST} from '../src/harness-policy.mjs';

function registryFixture(){
  const registry=new CapabilityRegistry();
  registry.registerProvider({
    id:'fixture-provider',
    capabilities:[{id:'fixture.reads',toolNames:['fixture_read']}],
    tools:[{name:'fixture_read',capabilityId:'fixture.reads',risk:'read',readOnly:true,inputSchema:{type:'object'}}]
  });
  return registry;
}

test('Tool Broker wraps provider invocation in Execution while preserving the provider outcome',async()=>{
  const records=[];
  let providerCalls=0;
  const executionRecorder={
    async run(input,operation){
      records.push(input);
      return{outcome:await operation(),executionId:'ex-1'};
    }
  };
  const broker=new ToolBroker({registry:registryFixture(),executionRecorder});
  broker.registerInvoker({
    providerId:'fixture-provider',
    invoke:async(name,args,options)=>{providerCalls+=1;return{result:{name,args,options}};}
  });

  const outcome=await broker.call(
    'fixture_read',
    {projectId:'p1'},
    {readOnlyOnly:true},
    {trigger:'harness_mcp',actor:'harness-navigator',sessionId:null}
  );

  assert.equal(providerCalls,1);
  assert.deepEqual(outcome,{result:{name:'fixture_read',args:{projectId:'p1'},options:{readOnlyOnly:true}}});
  assert.deepEqual(records,[{
    tool:{
      name:'fixture_read',
      description:'',
      capabilityId:'fixture.reads',
      effect:'read',
      risk:'read',
      readOnly:true,
      requiresConfirmation:false,
      inputSchema:{type:'object'},
      metadata:{},
      providerId:'fixture-provider'
    },
    args:{projectId:'p1'},
    context:{trigger:'harness_mcp',actor:'harness-navigator',sessionId:null}
  }]);
});

test('provider invocation never starts when the Execution start receipt cannot be persisted',async()=>{
  let providerCalls=0;
  const executionRecorder={
    async run(){throw Object.assign(new Error('receipt unavailable'),{code:'EXECUTION_RECEIPT_UNAVAILABLE'});}
  };
  const broker=new ToolBroker({registry:registryFixture(),executionRecorder});
  broker.registerInvoker({providerId:'fixture-provider',invoke:async()=>{providerCalls+=1;return{result:'should-not-run'};}});

  await assert.rejects(()=>broker.call(
    'fixture_read',
    {secret:'value'},
    {},
    {trigger:'harness_mcp',actor:'harness-navigator',sessionId:null}
  ),error=>error?.code==='EXECUTION_RECEIPT_UNAVAILABLE');
  assert.equal(providerCalls,0);
});

async function rpc(base,token,params){
  const response=await fetch(`${base}/api/harness/mcp`,{
    method:'POST',
    headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({jsonrpc:'2.0',id:'execution-cutover',method:'tools/call',params})
  });
  return response.json();
}

test('Harness MCP bridge supplies bounded Execution context without changing legacy MCP options',async t=>{
  const token='e'.repeat(43);
  const calls=[];
  const navigator={bridgeToken:token,status:()=>({enabled:true,available:true}),run:async()=>({})};
  const mcpRegistry={list:()=>[{name:'project_list',readOnly:true,inputSchema:{type:'object'}}]};
  const toolBroker={
    call:async(name,args,options,context)=>{
      calls.push({name,args,options,context});
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
  const body=await rpc(base,token,{name:'project_list',arguments:{includeArchived:false}});
  assert.equal(body.result.structuredContent.readback,true);
  assert.deepEqual(calls,[{
    name:'project_list',
    args:{includeArchived:false},
    options:{readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST},
    context:{trigger:'harness_mcp',actor:'harness-navigator',sessionId:null}
  }]);
});

test('server composition installs private Execution storage and injects the recorder plus shadow Policy into Tool Broker',async()=>{
  const source=await fsp.readFile('src/server.mjs','utf8');
  assert.match(source,/ExecutionReceiptStore/);
  assert.match(source,/ExecutionRecorder/);
  assert.match(source,/ToolPolicy/);
  assert.match(source,/new ExecutionReceiptStore\(\{dataDir:DATA_DIR\}\)/);
  assert.match(source,/await harnessExecutionStore\.ensure\(\)/);
  assert.match(source,/new ExecutionRecorder\(\{store:harnessExecutionStore\}\)/);
  assert.match(source,/new ToolPolicy\(\{mode:'shadow'\}\)/);
  assert.match(source,/new ToolBroker\(\{registry:harnessCapabilityRegistry,executionRecorder:harnessExecutionRecorder,policy:harnessToolPolicy\}\)/);
});
