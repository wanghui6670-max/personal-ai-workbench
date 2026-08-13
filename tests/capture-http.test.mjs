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

async function capture(base,token,body){
  const response=await fetch(`${base}/api/capture`,{
    method:'POST',
    headers:{
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });
  return{response,data:await response.json()};
}

test('POST /api/capture accepts captureId, replays safely, and rejects changed content',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-capture-http-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'data');
  const workspace=path.join(root,'workspace');
  const port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  const token='capture-http-contract-token';
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:path.resolve('.'),
    env:{
      ...process.env,
      PORT:String(port),
      HOST:'127.0.0.1',
      DATA_DIR:dataDir,
      WORKSPACE_ROOT:workspace,
      OPENAI_API_KEY:'',
      WORKBENCH_PASSWORD:'',
      SESSION_SECRET:'',
      TRUSTED_ORIGINS:'',
      CAPTURE_TOKEN:token
    },
    stdio:'ignore'
  });
  t.after(()=>child.kill('SIGTERM'));
  await waitFor(`${base}/api/health`);

  const body={
    captureId:'capture-http-0001',
    text:'从快捷指令采集且只允许出现一次',
    source:'untrusted-client-label'
  };
  const first=await capture(base,token,body);
  const replay=await capture(base,token,body);
  const conflict=await capture(base,token,{...body,text:'同一 ID 的不同正文'});

  assert.equal(first.response.status,201);
  assert.equal(first.data.replayed,false);
  assert.equal(first.data.captureId,body.captureId);
  assert.equal(first.data.item.source,'iphone-shortcut');
  assert.equal(replay.response.status,200);
  assert.equal(replay.data.replayed,true);
  assert.equal(replay.data.item.id,first.data.item.id);
  assert.equal(conflict.response.status,409);

  const store=new JsonStore(dataDir);
  const state=await store.readState();
  assert.equal(state.inbox.filter(item=>item.captureId===body.captureId).length,1);
  assert.equal((await store.listCaptureReceipts()).filter(item=>item.captureId===body.captureId).length,1);
});
