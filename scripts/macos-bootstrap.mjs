#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';
import {
  chooseMacosDataDir,
  chooseMacosWorkspace,
  envValuesFromSource,
  macosP0Updates,
  restoreEnvFile,
  upsertEnvSource,
  writeEnvAtomically
} from '../src/macos-bootstrap.mjs';

const execFileAsync=promisify(execFile);
const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home=os.homedir();
const envPath=path.join(appRoot,'.env');
const label='com.dongjue.personal-ai-workbench';
const uid=process.getuid?.();
let envRecord=null;
let previousServiceLoaded=false;
let dataDir=null;
let bootstrapReportPath=null;
let succeeded=false;
let processEnvBefore=null;

function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]||null:null;}
function flag(name){return process.argv.includes(name);}
function domain(){return `gui/${uid}`;}
function serviceTarget(){return `${domain()}/${label}`;}
function baseUrl(port){return `http://127.0.0.1:${port}`;}

async function execResult(file,args,{timeout=120_000,env=process.env}={}){
  try{const result=await execFileAsync(file,args,{cwd:appRoot,timeout,maxBuffer:4*1024*1024,env});return{code:0,stdout:result.stdout,stderr:result.stderr};}
  catch(error){return{code:Number.isInteger(error.code)?error.code:1,stdout:error.stdout||'',stderr:error.stderr||error.message||''};}
}

async function git(args){
  const result=await execResult('git',args,{timeout:30_000});
  if(result.code!==0)throw new Error(String(result.stderr||result.stdout||'git 执行失败').trim());
  return String(result.stdout||'').trim();
}

function runNode(script,args=[]){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{cwd:appRoot,env:process.env,stdio:'inherit'});
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
}

function portInUse(port){
  return new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port});
    const finish=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(600);
    socket.once('connect',()=>finish(true));
    socket.once('timeout',()=>finish(false));
    socket.once('error',()=>finish(false));
  });
}

async function waitForPortFree(port,timeoutMs=5000){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    if(!(await portInUse(port)))return true;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return false;
}

async function serviceLoaded(){
  if(!Number.isInteger(uid))return false;
  return (await execResult('launchctl',['print',serviceTarget()],{timeout:10_000})).code===0;
}

async function serviceCommand(command,args=[]){
  const result=await runNode('scripts/macos-launch-agent.mjs',[command,...args]);
  if(result.code!==0)throw new Error(`macOS 服务命令失败：${command}`);
}

async function readOptional(file){
  try{return await fsp.readFile(file,'utf8');}
  catch(error){if(error?.code==='ENOENT')return '';throw error;}
}

async function verifyRepository(){
  const branch=await git(['branch','--show-current']);
  if(branch!=='main')throw new Error(`一键部署只能从 main 运行；当前分支是 ${branch||'detached'}。请先运行 install-macos.command，它会安全切换并更新 main。`);
  const changes=await git(['status','--porcelain','--untracked-files=no']);
  if(changes)throw new Error('仓库存在已跟踪文件修改，拒绝自动部署。请先提交或还原这些修改。');
  const commit=await git(['rev-parse','HEAD']);
  let originMain=null;
  try{originMain=await git(['rev-parse','refs/remotes/origin/main']);}catch{}
  if(originMain&&originMain!==commit)throw new Error('本地 main 与 origin/main 不一致。请重新运行 install-macos.command 完成 fast-forward 更新。');
  return{branch,commit};
}

async function writeReport(value){
  if(!bootstrapReportPath)return;
  await fsp.mkdir(path.dirname(bootstrapReportPath),{recursive:true,mode:0o700});
  await fsp.writeFile(bootstrapReportPath,`${JSON.stringify(value,null,2)}\n`,{encoding:'utf8',mode:0o600});
}

try{
  assert.equal(process.platform,'darwin','一键真实主机部署仅支持 macOS。');
  assert.ok(Number(process.versions.node.split('.')[0])>=24,'需要 Node.js 24+。');
  assert.ok(Number.isInteger(uid),'无法确定当前 macOS 用户。');

  const repository=await verifyRepository();
  const existingSource=await readOptional(envPath);
  const existing=envValuesFromSource(existingSource);
  const workspaceRoot=await chooseMacosWorkspace({explicit:arg('--workspace'),existing:existing.WORKSPACE_ROOT,home});
  dataDir=await chooseMacosDataDir({explicit:arg('--data-dir'),existing:existing.DATA_DIR,appRoot,home});
  const port=Number(arg('--port')||existing.PORT||44173);
  const updates=macosP0Updates({workspaceRoot,dataDir,port});
  processEnvBefore=new Map(Object.keys(updates).map(key=>[key,{present:Object.hasOwn(process.env,key),value:process.env[key]}]));
  await fsp.mkdir(dataDir,{recursive:true,mode:0o700});
  bootstrapReportPath=path.join(dataDir,'p0','macos-bootstrap.json');

  previousServiceLoaded=await serviceLoaded();
  if(previousServiceLoaded){
    console.log('检测到现有 Workbench LaunchAgent，先暂停服务；失败时会恢复。');
    await serviceCommand('stop');
  }
  if(!(await waitForPortFree(port)))throw new Error(`端口 127.0.0.1:${port} 被非 Workbench 进程占用，未执行覆盖。`);

  const updatedSource=upsertEnvSource(existingSource,updates);
  envRecord=await writeEnvAtomically(envPath,updatedSource,{backupDir:path.join(dataDir,'p0','env-backups')});
  Object.assign(process.env,updates);
  console.log(`已绑定真实项目目录：${workspaceRoot}`);
  console.log(`已绑定持久化数据目录：${dataDir}`);
  console.log(`本机地址：${baseUrl(port)}`);
  if(envRecord.backupPath)console.log(`原 .env 已备份：${envRecord.backupPath}`);

  const preflight=await runNode('scripts/p0-host-preflight.mjs');
  if(preflight.code!==0)throw new Error('真实主机 P0 未通过，未安装常驻服务。');

  if(flag('--prepare-only')){
    if(previousServiceLoaded)await serviceCommand('start');
    await writeReport({schemaVersion:1,status:'prepared',finishedAt:new Date().toISOString(),productVersion:PRODUCT_VERSION,commit:repository.commit,workspaceRoot,dataDir,port,envBackup:envRecord.backupPath});
    succeeded=true;
    console.log('真实主机 P0 已通过；按 --prepare-only 要求未替换常驻服务。');
  }else{
    await serviceCommand('install');
    await serviceCommand('status');
    const url=baseUrl(port);
    if(!flag('--no-open'))await execResult('open',[url],{timeout:10_000});
    await writeReport({schemaVersion:1,status:'installed',finishedAt:new Date().toISOString(),product:PRODUCT_DISPLAY_NAME,productVersion:PRODUCT_VERSION,commit:repository.commit,workspaceRoot,dataDir,port,url,envBackup:envRecord.backupPath,service:label});
    succeeded=true;
    console.log(`\n${PRODUCT_DISPLAY_NAME} v${PRODUCT_VERSION} 已在真实 Mac 上启动。`);
    console.log(`打开：${url}`);
    console.log('状态：npm run service:macos -- status');
    console.log('日志：~/Library/Logs/PersonalAIWorkbench/');
  }
}catch(error){
  console.error(`\n部署停止：${error.message||error}`);
  if(envRecord){
    await restoreEnvFile(envPath,envRecord).catch(restoreError=>console.error(`恢复 .env 失败：${restoreError.message}`));
  }
  if(processEnvBefore){
    for(const [key,previous] of processEnvBefore){
      if(previous.present)process.env[key]=previous.value;
      else delete process.env[key];
    }
  }
  if(previousServiceLoaded){
    await serviceCommand('start').catch(startError=>console.error(`恢复旧服务失败：${startError.message}`));
  }
  await writeReport({schemaVersion:1,status:'failed',finishedAt:new Date().toISOString(),error:String(error.message||error),envRestored:Boolean(envRecord),previousServiceRestored:previousServiceLoaded}).catch(()=>undefined);
  process.exitCode=1;
}finally{
  if(!succeeded&&envRecord?.backupPath)console.error(`原配置备份仍保留：${envRecord.backupPath}`);
}
