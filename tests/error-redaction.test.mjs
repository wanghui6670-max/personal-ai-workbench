import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

async function waitFor(url,timeout=8000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    try{const response=await fetch(url);if(response.ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('server did not start');
}

async function api(base,pathname,{method='GET',body}={}){
  const response=await fetch(base+pathname,{
    method,
    headers:body===undefined?{}:{'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  return{response,data:await response.json()};
}

async function waitForText(read,{includes,timeout=3000}){
  const started=Date.now();
  while(Date.now()-started<timeout){
    if(read().includes(includes))return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail(`server log did not include: ${includes}`);
}

test('unexpected filesystem errors are redacted while explicit 4xx errors remain useful',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-error-redaction-'));
  const data=path.join(root,'data'),workspace=path.join(root,'workspace');
  const port=51500+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
  let stderr='';
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:path.resolve('.'),
    env:{
      ...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,
      OPENAI_API_KEY:'',WORKBENCH_PASSWORD:'',SESSION_SECRET:'',CAPTURE_TOKEN:'',TRUSTED_ORIGINS:'',ALLOW_INSECURE_PUBLIC:''
    },
    stdio:['ignore','ignore','pipe']
  });
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{child.kill('SIGTERM');await fsp.rm(root,{recursive:true,force:true});});
  await waitFor(base+'/api/health');

  let result=await api(base,'/api/inbox',{method:'POST',body:{text:42}});
  assert.equal(result.response.status,400);
  assert.equal(result.data.error,'text 类型无效。');

  result=await api(base,'/api/inbox',{method:'POST',body:{text:'原始收件箱事项'}});
  assert.equal(result.response.status,201);
  result=await api(base,'/api/projects',{method:'POST',body:{
    description:'被篡改的项目描述',endDate:'2026-08-30',sourceInboxId:result.data.item.id
  }});
  assert.equal(result.response.status,409);
  assert.equal(result.data.error,'项目描述必须与来源收件箱事项一致。');

  const blockedBusinessPath=path.join(workspace,'01_动觉AI');
  await fsp.rmdir(blockedBusinessPath);
  await fsp.writeFile(blockedBusinessPath,'ordinary-file-conflict','utf8');
  result=await api(base,'/api/businesses',{method:'POST',body:{name:'临时业务'}});
  assert.equal(result.response.status,500);
  assert.deepEqual(result.data,{error:'服务器内部错误，请稍后重试。'});
  const serialized=JSON.stringify(result.data);
  assert.equal(serialized.includes(root),false,'client response must not expose the temporary absolute path');
  assert.equal(serialized.includes('项目路径不是目录'),false,'client response must not expose the filesystem detail');

  await waitForText(()=>stderr,{includes:'项目路径不是目录'});
  assert.match(stderr,new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'full diagnostic remains in the local server log');

  result=await api(base,'/api/state');
  assert.equal(result.response.status,200,'server remains usable after the handled 500');
  assert.equal(Array.isArray(result.data.inbox),true);
});
