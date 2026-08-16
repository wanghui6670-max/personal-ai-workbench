#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

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
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function run(file,args,{timeout=8_000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd:root,stdio:['ignore','pipe','pipe']});
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
    await sleep(150);
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
let browser=null;
try{
  await waitForHealth();
  const executablePath=await findChrome();
  browser=await puppeteer.launch({
    executablePath,headless:true,
    args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check']
  });
  const page=await browser.newPage();
  const pageErrors=[];const consoleErrors=[];const failedRequests=[];
  page.on('pageerror',error=>pageErrors.push(String(error?.stack||error)));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('requestfailed',request=>failedRequests.push({url:request.url(),error:request.failure()?.errorText||'failed'}));
  const response=await page.goto(base,{waitUntil:'domcontentloaded',timeout:15_000});
  if(!response||response.status()!==200)throw new Error(`Homepage navigation failed: ${response?.status()||'no response'}`);
  try{
    await page.waitForFunction(()=>!document.body?.innerText?.includes('正在打开动觉 AI 工作台'),{timeout:8_000});
  }catch{
    const snapshot=await page.evaluate(()=>({readyState:document.readyState,text:document.body?.innerText||'',html:document.documentElement?.outerHTML?.slice(0,8000)||''}));
    throw new Error(`Browser stayed on boot placeholder. snapshot=${JSON.stringify(snapshot).slice(0,9000)} pageErrors=${JSON.stringify(pageErrors).slice(0,5000)} consoleErrors=${JSON.stringify(consoleErrors).slice(0,5000)} failedRequests=${JSON.stringify(failedRequests).slice(0,5000)}`);
  }
  const text=await page.evaluate(()=>document.body?.innerText||'');
  if(!text.includes('今日与收件箱'))throw new Error(`Workbench v3 dashboard not rendered. text=${text.slice(0,4000)} pageErrors=${JSON.stringify(pageErrors).slice(0,5000)} consoleErrors=${JSON.stringify(consoleErrors).slice(0,5000)} failedRequests=${JSON.stringify(failedRequests).slice(0,5000)}`);
  if(pageErrors.length)throw new Error(`Workbench rendered but emitted page errors: ${JSON.stringify(pageErrors).slice(0,8000)}`);
  console.log('browser-boot-smoke: ok');
}finally{
  if(browser)await browser.close().catch(()=>undefined);
  server.kill('SIGTERM');await sleep(150);if(server.exitCode===null)server.kill('SIGKILL');
  if(serverErr.length)process.stderr.write(Buffer.concat(serverErr));
  await fsp.rm(tmp,{recursive:true,force:true});
}
