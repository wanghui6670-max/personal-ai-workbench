import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessRuntime} from '../platform/index.mjs';

test('agents default to no tool access when allowedTools is empty',async()=>{
  const runtime=new HarnessRuntime();
  runtime.install({
    id:'policy-pack',
    name:'Policy',
    version:'1.0.0',
    tools:[{name:'sample.read',risk:'read',execute:async()=>1}],
    agents:[{id:'no-tools-agent',name:'No Tools'}]
  });
  assert.equal(runtime.registry.getAgent('no-tools-agent').toolAccess,'none');
  await assert.rejects(()=>runtime.runAgent('no-tools-agent',{runner:ctx=>ctx.invoke('sample.read')}),/tool not allowed/);
});

test('toolAccess all must be explicit',async()=>{
  const runtime=new HarnessRuntime();
  runtime.install({
    id:'policy-pack',
    name:'Policy',
    version:'1.0.0',
    tools:[{name:'sample.read',risk:'read',execute:async()=>7}],
    agents:[{id:'all-tools-agent',name:'All Tools',toolAccess:'all'}]
  });
  const output=await runtime.runAgent('all-tools-agent',{runner:ctx=>ctx.invoke('sample.read')});
  assert.equal(output.result.result,7);
});
