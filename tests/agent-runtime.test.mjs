import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessRuntime,SessionStore,InMemoryEventStore} from '../platform/index.mjs';

test('AgentRuntime gives runners a constrained tool gateway and persists the run into Session/Event trace',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-runtime-'));
  const sessions=new SessionStore({root});
  await sessions.create({id:'project:agent-test',scope:'project',goal:'test'});
  const events=new InMemoryEventStore();
  const runtime=new HarnessRuntime({sessions,events});
  runtime.install({id:'agent-pack',name:'Agent Pack',version:'1.0.0',tools:[
    {name:'allowed.read',risk:'read',execute:async input=>({echo:input.value})},
    {name:'blocked.read',risk:'read',execute:async()=>({secret:true})}
  ],agents:[{id:'limited-agent',name:'Limited Agent',allowedTools:['allowed.read']}]});
  const result=await runtime.runAgent('limited-agent',{sessionId:'project:agent-test',input:'hello',runner:async ctx=>{
    const tool=await ctx.invoke('allowed.read',{value:7});
    assert.equal(ctx.session.goal,'test');
    return {input:ctx.input,tool:tool.result};
  }});
  assert.deepEqual(result.result,{input:'hello',tool:{echo:7}});
  const restored=await sessions.load('project:agent-test');
  assert.equal(restored.events.some(event=>event.type==='tool.completed'),true);
  assert.equal(restored.events.some(event=>event.type==='agent.completed'),true);
  const trace=await events.list({sessionId:'project:agent-test'});
  assert.equal(trace.some(event=>event.type==='agent.requested'),true);
  assert.equal(trace.some(event=>event.type==='agent.completed'),true);
});

test('AgentRuntime cannot bypass an agent tool allowlist',async()=>{
  const runtime=new HarnessRuntime();
  runtime.install({id:'agent-pack',name:'Agent Pack',version:'1.0.0',tools:[
    {name:'allowed.read',risk:'read',execute:async()=>1},
    {name:'blocked.read',risk:'read',execute:async()=>2}
  ],agents:[{id:'limited-agent',name:'Limited Agent',allowedTools:['allowed.read']}]});
  await assert.rejects(()=>runtime.runAgent('limited-agent',{runner:ctx=>ctx.invoke('blocked.read')}),/tool not allowed/);
});
