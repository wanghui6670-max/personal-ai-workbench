import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityRegistry, createLegacyMcpProvider, createToolBroker, createExecutionStore, createExecutionService } from '../src/harness-core/index.mjs';

test('each broker call writes an execution receipt outside state.json',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harness-exec-'));
  const file=path.join(dir,'executions.json');
  const store=createExecutionStore({file});
  const execution=createExecutionService({store});
  const mcp={
    list:()=>[{name:'project_list',readOnly:true}],
    async call(){return {result:[{id:'p1'},{id:'p2'}]};}
  };
  const registry=createCapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.read',toolNames:['project_list']}]
  }));
  const broker=createToolBroker({registry,execution});
  const outcome=await broker.call({name:'project_list',arguments:{},trigger:'test',actor:'chris',sessionRef:'sess-1'});
  assert.equal(typeof outcome.executionId,'string');
  assert.match(outcome.executionId,/^ex_/);
  const records=await store.list();
  assert.equal(records.length,1);
  assert.equal(records[0].tool,'project_list');
  assert.equal(records[0].status,'ok');
  assert.equal(records[0].sessionRef,'sess-1');
  assert.equal(records[0].resultSummary,'project_list:2');
  const raw=await readFile(file,'utf8');
  assert.equal(raw.includes('完整客户数据'),false);
  assert.equal(raw.includes('"inbox"'),false);
});

test('failed call still stores errorCode',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harness-exec-'));
  const store=createExecutionStore({file:path.join(dir,'executions.json')});
  const execution=createExecutionService({store});
  const mcp={
    list:()=>[{name:'project_list',readOnly:true}],
    async call(){throw Object.assign(new Error('boom'),{code:'MCP_INVALID_PARAMS'});}
  };
  const registry=createCapabilityRegistry();
  registry.registerProvider(createLegacyMcpProvider({
    mcpRegistry:mcp,
    capabilities:[{id:'workbench.read',toolNames:['project_list']}]
  }));
  const broker=createToolBroker({registry,execution});
  await assert.rejects(()=>broker.call({name:'project_list'}));
  const records=await store.list();
  assert.equal(records[0].status,'error');
  assert.equal(records[0].errorCode,'MCP_INVALID_PARAMS');
});
