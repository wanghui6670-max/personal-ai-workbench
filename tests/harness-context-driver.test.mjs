import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, createSessionManager, createContextAwareDriver } from '../src/harness-core/index.mjs';

test('project route hydrates live context before running runtime',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harness-drv-'));
  const store=createSessionStore({file:path.join(dir,'sessions.json')});
  const manager=createSessionManager({
    store,
    projectLookup:async()=>({id:'prj-1',name:'Personal AI Workbench',git:'git@x',feishu:''}),
    authorities:{
      async readGit(){return {head:'live-head'};},
      async readFeishu(){return {documentUrl:''};}
    }
  });
  const seen=[];
  const runtime={
    async run(input){seen.push(input);return {sessionId:'dsh-1',reply:'继续做 Slice 7',trajectory:[],navigation:null,source:'deepseek_harness',readOnly:true};},
    status(){return {available:true};}
  };
  const driver=createContextAwareDriver({sessionManager:manager,runtime});
  const result=await driver.run({message:'继续',route:{view:'project',id:'prj-1'}});
  assert.equal(result.readOnly,true);
  assert.equal(seen[0].context.projectId,'prj-1');
  assert.equal(seen[0].context.working.authority,'live');
  assert.equal(seen[0].context.working.live.git.head,'live-head');
  assert.equal(result.working.project.id,'prj-1');
});
