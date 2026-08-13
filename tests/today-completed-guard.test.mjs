import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setToday } from '../src/domain.mjs';
import { createWorkbenchRegistry } from '../src/mcp/registry.mjs';
import { JsonStore } from '../src/store.mjs';

function todo(id,{title='已经完成的待办',done=true}={}){
  return {id,title,dueDate:'2099-08-20',done,projectId:null,createdAt:'2026-08-13T00:00:00.000Z'};
}

function state(overrides={}){
  return {
    schemaVersion:1,inbox:[],inboxAcks:[],todos:[],todayPlan:[],todayPlanDate:null,
    projects:[],confirmations:[],notes:[],activities:[],morningSessions:[],...overrides
  };
}

async function fixture(t,prefix='workbench-completed-today-'){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return {root,store};
}

function waitFor(url,timeout=8000){
  const started=Date.now();
  return new Promise((resolve,reject)=>{
    const tick=async()=>{
      if(Date.now()-started>=timeout)return reject(new Error('server did not start'));
      try{const response=await fetch(url);if(response.ok)return resolve();}catch{}
      setTimeout(tick,80);
    };
    tick();
  });
}

test('domain rejects adding a completed todo to today without mutating state',async t=>{
  const {store}=await fixture(t);
  await store.writeState(state({todos:[todo('td_done')]}));

  await assert.rejects(
    setToday({store,todoId:'td_done',add:true}),
    error=>error.statusCode===409&&error.code==='TODO_ALREADY_COMPLETED'&&/已完成待办不能加入今日/.test(error.message)
  );

  const persisted=await store.readState();
  assert.deepEqual(persisted.todayPlan,[]);
  assert.equal(persisted.todayPlanDate,null);
  assert.equal(persisted.activities.length,0);
});

test('AI/MCP planning refuses to preview a completed todo for today',async t=>{
  const {root,store}=await fixture(t,'workbench-completed-planner-');
  await store.writeState(state({todos:[todo('td_done_plan',{title:'提交已经完成的报告'})]}));
  const previousKey=process.env.OPENAI_API_KEY;
  const previousProvider=process.env.AI_PROVIDER_ENABLED;
  delete process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER_ENABLED='0';
  try{
    const registry=createWorkbenchRegistry({appRoot:root,store});
    const plan=await registry.plan('把提交已经完成的报告加入今日');
    assert.equal(plan.kind,'clarification');
    assert.equal(plan.toolName,null);
    assert.match(plan.message,/已经完成.*不能加入今日/);
    await assert.rejects(
      registry.call('todo_today',{todoId:'td_done_plan',add:true},{confirmed:true}),
      error=>error.statusCode===409&&error.code==='TODO_ALREADY_COMPLETED'
    );
  }finally{
    if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;
    if(previousProvider===undefined)delete process.env.AI_PROVIDER_ENABLED;else process.env.AI_PROVIDER_ENABLED=previousProvider;
  }
});

test('HTTP today endpoint returns a clear 409 business error for completed todos',async t=>{
  const {root,store}=await fixture(t,'workbench-completed-http-');
  const workspace=path.join(root,'workspace');
  await fsp.mkdir(workspace,{recursive:true});
  await store.writeState(state({todos:[todo('td_done_http')]}));
  const port=43000+Math.floor(Math.random()*1000);
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:path.resolve('.'),
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:store.dataDir,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:'',AI_PROVIDER_ENABLED:'0',WORKBENCH_PASSWORD:'',SESSION_SECRET:'',TRUSTED_ORIGINS:'',CAPTURE_TOKEN:''},
    stdio:'ignore'
  });
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}});
  await waitFor(base+'/api/health');
  const response=await fetch(base+'/api/todos/today',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({todoId:'td_done_http',add:true})
  });
  const body=await response.json();
  assert.equal(response.status,409);
  assert.equal(body.code,'TODO_ALREADY_COMPLETED');
  assert.match(body.error,/已完成待办不能加入今日/);
  assert.deepEqual((await store.readState()).todayPlan,[]);
});
