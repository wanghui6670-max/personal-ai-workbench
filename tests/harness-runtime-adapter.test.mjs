import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDshRuntimeAdapter, defineRuntimeAdapter } from '../src/harness-core/index.mjs';

test('adapter exposes only the harness agent contract',async()=>{
  const calls=[];
  const navigator={
    async run(input){calls.push(input);return {sessionId:'s1',reply:'ok',trajectory:[],navigation:null,source:'deepseek_harness',readOnly:true};},
    status(){return {available:true};}
  };
  const adapter=createDshRuntimeAdapter({navigator});
  const result=await adapter.run({message:'继续',sessionId:null,context:{view:'project',projectId:'p1'}});
  assert.equal(result.readOnly,true);
  assert.equal(result.sessionId,'s1');
  assert.equal(calls[0].route.view,'project');
  assert.equal(calls[0].route.id,'p1');
  assert.equal(Object.hasOwn(result,'DeepSeekHarness'),false);
});

test('adapter forwards hydrated working context so DSH can continue a project',async()=>{
  const calls=[];
  const navigator={
    async run(input){calls.push(input);return {sessionId:'s1',reply:'ok',trajectory:[],navigation:null,source:'deepseek_harness',readOnly:true};},
    status(){return {available:true};}
  };
  const adapter=createDshRuntimeAdapter({navigator});
  const working={
    authority:'live',
    session:{id:'sess_1',projectId:'p1',checkpoint:{note:'停在 Slice 7'}},
    project:{id:'p1',name:'Personal AI Workbench',git:'git@x',feishu:''},
    live:{git:{head:'live-head',remote:'git@x',dirty:false},feishu:{documentUrl:''},executions:[]},
    conflicts:[]
  };
  await adapter.run({
    message:'继续',
    sessionId:null,
    context:{view:'project',projectId:'p1',sessionId:'sess_1',working}
  });
  assert.equal(calls[0].route.view,'project');
  assert.equal(calls[0].route.id,'p1');
  assert.equal(calls[0].route.working.authority,'live');
  assert.equal(calls[0].route.working.project.id,'p1');
  assert.equal(calls[0].route.working.live.git.head,'live-head');
  assert.equal(calls[0].route.working.session.checkpoint.note,'停在 Slice 7');
});

test('core sources do not import DSH-specific types',async()=>{
  const files=[
    'src/harness-core/runtime-adapter.mjs',
    'src/harness-core/dsh-runtime-adapter.mjs',
    'src/harness-core/context-aware-driver.mjs',
    'src/harness-http.mjs',
    'src/server.mjs'
  ];
  for(const file of files){
    let text='';
    try{text=await readFile(file,'utf8');}catch{continue;}
    assert.equal(text.includes('DeepSeekHarness'),false,file);
    assert.equal(text.includes('@deepseek-ai/dsh'),false,file);
  }
});
