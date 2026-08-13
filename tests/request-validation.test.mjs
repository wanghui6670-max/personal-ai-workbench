import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {requestSchemas,validateRequestBody} from '../src/request-validation.mjs';

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

async function waitFor(url,timeout=8000){const start=Date.now();while(Date.now()-start<timeout){try{const response=await fetch(url);if(response.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('server did not start');}
async function request(base,url,body,{method='POST',headers={}}={}){const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return{response,data:await response.json().catch(()=>({}))};}
async function snapshot(root){
  const entries=[];
  async function walk(directory,relative=''){
    for(const name of (await fsp.readdir(directory)).sort()){
      const full=path.join(directory,name),rel=path.join(relative,name);const stat=await fsp.lstat(full);
      if(stat.isDirectory()){entries.push(`${rel}/`);await walk(full,rel);}else entries.push(`${rel}:${await fsp.readFile(full,'utf8')}`);
    }
  }
  await walk(root);return entries;
}

test('request schema rejects non-object bodies, missing fields, wrong types, and unknown fields',()=>{
  for(const value of [null,[],42,'text'])assert.throws(()=>validateRequestBody(value,requestSchemas.inbox),error=>error.statusCode===400);
  for(const value of [{},{text:null},{text:42},{text:'   '},{text:'ok',extra:true}])assert.throws(()=>validateRequestBody(value,requestSchemas.inbox),error=>error.statusCode===400);
  assert.deepEqual(validateRequestBody({text:'ok'},requestSchemas.inbox),{text:'ok'});
});

test('malformed mutation bodies return 400 before state, config, workspace, or backups change',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-request-validation-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const data=path.join(root,'data'),workspace=path.join(root,'workspace');const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:'',WORKBENCH_PASSWORD:'',SESSION_SECRET:'',TRUSTED_ORIGINS:'',CAPTURE_TOKEN:'validation-token'},stdio:'ignore'});
  t.after(()=>child.kill('SIGTERM'));await waitFor(base+'/api/health');
  const before=await snapshot(root);
  const cases=[
    ['/api/auth/login',null,{}],
    ['/api/auth/login',{password:42},{}],
    ['/api/capture',null,{headers:{Authorization:'Bearer validation-token'}}],
    ['/api/capture',{text:42},{headers:{Authorization:'Bearer validation-token'}}],
    ['/api/inbox',null,{}],
    ['/api/inbox',{text:42},{}],
    ['/api/inbox',{text:null},{}],
    ['/api/inbox/command',null,{}],
    ['/api/inbox/command',{itemId:42,command:null},{}],
    ['/api/config',null,{method:'PATCH'}],
    ['/api/config',{workspaceRoot:42},{method:'PATCH'}],
    ['/api/businesses',{name:42},{}],
    ['/api/businesses',{name:null},{}],
    ['/api/businesses/nope',{name:null},{method:'PATCH'}],
    ['/api/projects',null,{}],
    ['/api/projects/nope/classify',null,{}],
    ['/api/projects/nope/classify',{businessId:null},{}],
    ['/api/projects/nope',null,{method:'PATCH'}],
    ['/api/projects/sync',null,{}],
    ['/api/projects/nope/sync',null,{}],
    ['/api/todos/today',{todoId:'nope',add:null},{}],
    ['/api/todos/today',{todoId:'nope',add:'true'},{}],
    ['/api/todos/nope',null,{method:'PATCH'}],
    ['/api/morning/chat',null,{}],
    ['/api/morning/chat',{message:42},{}],
    ['/api/confirmations/clear',null,{}],
    ['/api/confirmations/clear',{id:null},{}],
    ['/api/backup',null,{}],
    ['/api/businesses/nope',null,{method:'DELETE'}],
    ['/api/notes',null,{}]
  ];
  for(const [url,body,options] of cases){
    const result=await request(base,url,body,options);assert.equal(result.response.status,400,`${options.method||'POST'} ${url} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(await snapshot(root),before);
});
