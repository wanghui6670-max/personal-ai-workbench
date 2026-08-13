import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JsonStore } from '../src/store.mjs';

function freePort(){
  return new Promise((resolve,reject)=>{
    const probe=net.createServer();
    probe.once('error',reject);
    probe.listen(0,'127.0.0.1',()=>{
      const address=probe.address();
      probe.close(error=>error?reject(error):resolve(address.port));
    });
  });
}

async function waitFor(url,timeout=8000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    try{const response=await fetch(url);if(response.ok)return;}
    catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('server did not start');
}

test('POST /api/todos/today returns a clear 409 for completed todos',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-completed-http-'));
  const dataDir=path.join(root,'data');
  const workspace=path.join(root,'workspace');
  const store=new JsonStore(dataDir);
  await store.ensure();
  await store.writeState({
    schemaVersion:1,
    inbox:[],inboxAcks:[],
    todos:[{id:'td_done_http',title:'已完成的 HTTP 合同待办',dueDate:'2099-08-20',done:true,projectId:null,createdAt:'2026-08-13T00:00:00.000Z'}],
    todayPlan:[],todayPlanDate:null,
    projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]
  });

  const port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:path.resolve('.'),
    env:{
      ...process.env,
      PORT:String(port),
      HOST:'127.0.0.1',
      DATA_DIR:dataDir,
      WORKSPACE_ROOT:workspace,
      OPENAI_API_KEY:'',
      AI_PROVIDER_ENABLED:'0',
      WORKBENCH_PASSWORD:'',
      SESSION_SECRET:'',
      TRUSTED_ORIGINS:'',
      CAPTURE_TOKEN:''
    },
    stdio:'ignore'
  });
  t.after(async()=>{
    if(child.exitCode===null){
      child.kill('SIGTERM');
      await new Promise(resolve=>child.once('exit',resolve));
    }
    await fsp.rm(root,{recursive:true,force:true});
  });
  await waitFor(`${base}/api/health`);

  const response=await fetch(`${base}/api/todos/today`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({todoId:'td_done_http',add:true})
  });
  const body=await response.json();

  assert.equal(response.status,409);
  assert.equal(body.code,'TODO_ALREADY_COMPLETED');
  assert.match(body.error,/已完成待办不能加入今日/);
  const persisted=await store.readState();
  assert.deepEqual(persisted.todayPlan,[]);
  assert.equal(persisted.todayPlanDate,null);
});
