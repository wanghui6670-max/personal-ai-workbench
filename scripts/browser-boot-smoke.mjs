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
const debugPort=49272;
const base=`http://127.0.0.1:${port}`;
const env={
  ...process.env,
  HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dataDir,WORKSPACE_ROOT:workspaceRoot,
  WORKBENCH_PASSWORD:'',SESSION_SECRET:'',CAPTURE_TOKEN:'',TRUSTED_ORIGINS:'',ALLOW_INSECURE_PUBLIC:'',COOKIE_SECURE:'',
  OPENAI_API_KEY:'',AI_PROVIDER_ENABLED:'0',HARNESS_ENABLED:'0',JOYCREW_ENABLED:'0'
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function run(file,args,{env:childEnv=process.env,timeout=10_000}={}){
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

async function waitForTarget(){
  const started=Date.now();
  while(Date.now()-started<12_000){
    try{
      const list=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const target=list.find(item=>item.type==='page'&&String(item.url||'').startsWith(base));
      if(target?.webSocketDebuggerUrl)return target;
    }catch{}
    await sleep(150);
  }
  throw new Error('Chrome DevTools target did not appear');
}

async function inspectWithCdp(target){
  if(typeof WebSocket!=='function')throw new Error('Node runtime does not provide WebSocket');
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let seq=0;const pending=new Map();const exceptions=[];const consoleErrors=[];
  ws.addEventListener('message',event=>{
    let message;try{message=JSON.parse(String(event.data));}catch{return;}
    if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);if(message.error)reject(new Error(JSON.stringify(message.error)));else resolve(message.result);return;}
    if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params?.exceptionDetails||{});
    if(message.method==='Runtime.consoleAPICalled'&&message.params?.type==='error')consoleErrors.push(message.params);
    if(message.method==='Log.entryAdded'&&message.params?.entry?.level==='error')consoleErrors.push(message.params.entry);
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  try{
    await send('Runtime.enable');await send('Page.enable');await send('Log.enable');
    await sleep(4500);
    const result=await send('Runtime.evaluate',{
      expression:`JSON.stringify({readyState:document.readyState,text:document.body?.innerText||'',html:document.documentElement?.outerHTML?.slice(0,12000)||''})`,
      returnByValue:true,awaitPromise:true
    });
    const value=JSON.parse(result?.result?.value||'{}');
    return{...value,exceptions,consoleErrors};
  }finally{ws.close();}
}

const server=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
const serverErr=[];server.stderr.on('data',c=>serverErr.push(c));
let chrome=null;const chromeErr=[];
try{
  await waitForHealth();
  const executable=await findChrome();
  chrome=spawn(executable,[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(tmp,'chrome-profile')}`,base
  ],{cwd:root,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',c=>chromeErr.push(c));
  const target=await waitForTarget();
  const page=await inspectWithCdp(target);
  const diagnostic=JSON.stringify({readyState:page.readyState,exceptions:page.exceptions,consoleErrors:page.consoleErrors}).slice(0,8000);
  if(page.text.includes('正在打开动觉 AI 工作台'))throw new Error(`Browser remained on boot placeholder. ${diagnostic}`);
  if(!page.text.includes('今日与收件箱'))throw new Error(`Browser did not render Workbench v3 dashboard. text=${page.text.slice(0,3000)} ${diagnostic}`);
  if(page.exceptions.length)throw new Error(`Browser rendered but emitted runtime exceptions: ${diagnostic}`);
  console.log('browser-boot-smoke: ok');
}finally{
  if(chrome){chrome.kill('SIGTERM');await sleep(150);if(chrome.exitCode===null)chrome.kill('SIGKILL');}
  server.kill('SIGTERM');await sleep(150);if(server.exitCode===null)server.kill('SIGKILL');
  if(serverErr.length)process.stderr.write(Buffer.concat(serverErr));
  if(chromeErr.length)process.stderr.write(Buffer.concat(chromeErr).toString('utf8').split('\n').filter(line=>!/dbus|DevTools listening/.test(line)).slice(0,30).join('\n'));
  await fsp.rm(tmp,{recursive:true,force:true});
}
