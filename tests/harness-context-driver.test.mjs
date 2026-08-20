import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, createSessionManager, createContextAwareDriver, createHarnessRunScope } from '../src/harness-core/index.mjs';

function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return{promise,resolve};
}

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
  const runScope=createHarnessRunScope();
  const runtime={
    async run(input){
      seen.push({...input,trustedSessionRef:runScope.currentSessionRef()});
      return {sessionId:'dsh-1',reply:'继续做 Slice 7',trajectory:[],navigation:null,source:'deepseek_harness',readOnly:true};
    },
    status(){return {available:true};}
  };
  const driver=createContextAwareDriver({sessionManager:manager,runtime,runScope});
  const result=await driver.run({message:'继续',route:{view:'project',id:'prj-1'}});
  assert.equal(result.readOnly,true);
  assert.equal(seen[0].context.projectId,'prj-1');
  assert.equal(seen[0].context.working.authority,'live');
  assert.equal(seen[0].context.working.live.git.head,'live-head');
  assert.match(seen[0].trustedSessionRef,/^sess_[a-f0-9]{32}$/);
  assert.equal(runScope.currentSessionRef(),null);
  assert.equal(result.working.project.id,'prj-1');
});

test('trusted run scope rejects concurrent Navigator runs',async()=>{
  const started=deferred();
  const release=deferred();
  const sessionId=`sess_${'a'.repeat(32)}`;
  const runScope=createHarnessRunScope();
  const sessionManager={
    async openProject(){return{id:sessionId,projectId:'p1'};},
    async hydrate(){return{authority:'live',project:{id:'p1'}};}
  };
  const runtime={
    async run(){
      started.resolve();
      await release.promise;
      return {sessionId:'dsh-1',reply:'ok',trajectory:[],navigation:null,source:'deepseek_harness',readOnly:true};
    }
  };
  const driver=createContextAwareDriver({sessionManager,runtime,runScope});
  const first=driver.run({message:'first',route:{view:'project',id:'p1'}});
  await started.promise;
  await assert.rejects(
    driver.run({message:'second',route:{view:'project',id:'p2'}}),
    error=>error.code==='HARNESS_RUN_BUSY'&&error.statusCode===409
  );
  release.resolve();
  await first;
  assert.equal(runScope.currentSessionRef(),null);
});

test('trusted run scope clears after a runtime failure',async()=>{
  const sessionId=`sess_${'b'.repeat(32)}`;
  const runScope=createHarnessRunScope();
  const sessionManager={
    async openProject(){return{id:sessionId,projectId:'p1'};},
    async hydrate(){return{authority:'live',project:{id:'p1'}};}
  };
  const runtime={async run(){throw new Error('runtime failed');}};
  const driver=createContextAwareDriver({sessionManager,runtime,runScope});
  await assert.rejects(driver.run({message:'fail',route:{view:'project',id:'p1'}}),/runtime failed/);
  assert.equal(runScope.currentSessionRef(),null);
});
