#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root=process.cwd();
const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-browser-smoke-'));
const dataDir=path.join(tmp,'data');
const workspaceRoot=path.join(tmp,'workspace');
const port=49271;
const base=`http://127.0.0.1:${port}`;
const env={
  ...process.env,
  HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dataDir,WORKSPACE_ROOT:workspaceRoot,
  WORKBENCH_PASSWORD:'',SESSION_SECRET:'',CAPTURE_TOKEN:'',TRUSTED_ORIGINS:'',ALLOW_INSECURE_PUBLIC:'',COOKIE_SECURE:'',
  OPENAI_API_KEY:'',AI_PROVIDER_ENABLED:'0',HARNESS_ENABLED:'0',JOYCREW_ENABLED:'0'
};

function run(file,args,{env:childEnv=process.env,timeout=30_000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']});
    const out=[],err=[];
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${file} timed out`));},timeout);
    child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>err.push(chunk));
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);resolve({code,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8')});});
  });
}

async function waitForHealth(){
  const started=Date.now();
  while(Date.now()-started<15_000){
    try{const response=await fetch(`${base}/api/health`,{cache:'no-store'});if(response.status===200){const body=await response.json();if(body.ok===true&&body.version==='3.0.0')return body;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error('Workbench server did not become healthy for browser smoke');
}

async function findChrome(){
  for(const candidate of [process.env.CHROME_BIN,'google-chrome','google-chrome-stable','chromium','chromium-browser'].filter(Boolean)){
    const probe=await run('bash',['-lc',`command -v ${JSON.stringify(candidate)}`],{timeout:5_000}).catch(()=>null);
    if(probe?.code===0&&probe.stdout.trim())return probe.stdout.trim();
  }
  throw new Error('No Chrome/Chromium executable found on runner');
}

const server=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
const serverErr=[];server.stderr.on('data',c=>serverErr.push(c));
try{
  await waitForHealth();
  const chrome=await findChrome();
  const result=await run(chrome,[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--virtual-time-budget=6000','--dump-dom',`${base}/`
  ],{timeout:25_000});
  if(result.code!==0)throw new Error(`Chrome exited ${result.code}: ${result.stderr.slice(0,2000)}`);
  const dom=result.stdout;
  if(dom.includes('正在打开动觉 AI 工作台'))throw new Error('Browser remained on the boot placeholder; app.js did not complete startup');
  if(!dom.includes('今日与收件箱'))throw new Error(`Browser did not render Workbench v3 dashboard. DOM excerpt: ${dom.slice(0,2500)}`);
  console.log('browser-boot-smoke: ok');
}finally{
  server.kill('SIGTERM');
  await new Promise(resolve=>setTimeout(resolve,200));
  if(server.exitCode===null)server.kill('SIGKILL');
  await fsp.rm(tmp,{recursive:true,force:true});
  if(serverErr.length)process.stderr.write(Buffer.concat(serverErr));
}
