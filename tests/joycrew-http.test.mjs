import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function freePort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function waitFor(url,attempts=80){
  for(let index=0;index<attempts;index++){
    try{const response=await fetch(url);if(response.ok)return response;}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error(`server did not become ready: ${url}`);
}
async function json(url,options={}){
  const response=await fetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  const body=await response.json();
  return{response,body};
}

test('Joycrew-disabled HTTP path keeps Workbench healthy and never executes an unconfirmed preview',async t=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-joycrew-http-'));
  t.after(()=>fsp.rm(temp,{recursive:true,force:true}));
  const port=await freePort();
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:root,
    env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:path.join(temp,'data'),WORKSPACE_ROOT:path.join(temp,'workspace'),OPENAI_API_KEY:'',AI_PROVIDER_ENABLED:'0',HARNESS_ENABLED:'0',JOYCREW_ENABLED:'0',WORKBENCH_PASSWORD:'',SESSION_SECRET:''},
    stdio:['ignore','pipe','pipe']
  });
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  t.after(()=>{if(!child.killed)child.kill('SIGTERM');});
  await waitFor(`http://127.0.0.1:${port}/api/health`);

  const status=await json(`http://127.0.0.1:${port}/api/joycrew/status`);
  assert.equal(status.response.status,200,output);
  assert.equal(status.body.joycrew.enabled,false);

  const prepared=await json(`http://127.0.0.1:${port}/api/joycrew/actions/prepare`,{method:'POST',body:JSON.stringify({type:'run.create',source:'http-test',payload:{projectId:'p-1',task:'读取明确来源并生成 Evidence',employeeId:'e-1',sources:[{kind:'records',sourceId:'s-1',entity:'Project',filters:[]}]}})});
  assert.equal(prepared.response.status,201,output);
  assert.equal(prepared.body.action.status,'pending');

  const denied=await json(`http://127.0.0.1:${port}/api/joycrew/actions/${prepared.body.action.id}/execute`,{method:'POST',body:JSON.stringify({confirmed:false})});
  assert.equal(denied.response.status,409);
  assert.equal(denied.body.code,'JOYCREW_ACTION_CONFIRMATION_REQUIRED');

  const attempted=await json(`http://127.0.0.1:${port}/api/joycrew/actions/${prepared.body.action.id}/execute`,{method:'POST',body:JSON.stringify({confirmed:true})});
  assert.equal(attempted.response.status,503);
  assert.equal(attempted.body.code,'JOYCREW_DISABLED');

  const actions=await json(`http://127.0.0.1:${port}/api/joycrew/actions`);
  assert.equal(actions.body.actions.length,1);
  assert.equal(actions.body.actions[0].status,'pending');
});
