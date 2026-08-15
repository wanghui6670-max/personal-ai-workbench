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
  macosUpgradeUpdates,
  recoverLegacyRuntimeEnvSource,
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
let deploymentMode='first_install';
let runtimeRecovery=null;

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

function runNode(script,args=[],{env=process.env}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{cwd:appRoot,env,stdio:'inherit'});
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

async function existingInstall(directory){
  try{
    const raw=JSON.parse(await fsp.readFile(path.join(directory,'p0','macos-service.json'),'utf8'));
    return raw?.label===label&&typeof raw?.commit==='string'&&raw.commit.length>=7?raw:null;
  }catch(error){
    if(error?.code==='ENOENT'||error instanceof SyntaxError)return null;
    throw error;
  }
}

async function legacyBootstrapBackup(directory){
  try{
    const report=JSON.parse(await fsp.readFile(path.join(directory,'p0','macos-bootstrap.json'),'utf8'));
    if(report?.schemaVersion!==1||report?.status!=='installed'||typeof report?.envBackup!=='string')return null;
    const backupPath=path.resolve(report.envBackup);
    const relative=path.relative(path.resolve(directory),backupPath);
    if(relative.startsWith('..')||path.isAbsolute(relative))return null;
    const source=await fsp.readFile(backupPath,'utf8');
    return{source,backupPath};
  }catch(error){
    if(error?.code==='ENOENT'||error instanceof SyntaxError)return null;
    throw error;
  }
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
  let existingSource=await readOptional(envPath);
  let existing=envValuesFromSource(existingSource);
  const workspaceRoot=await chooseMacosWorkspace({explicit:arg('--workspace'),existing:existing.WORKSPACE_ROOT,home});
  dataDir=await chooseMacosDataDir({explicit:arg('--data-dir'),existing:existing.DATA_DIR,appRoot,home});
  const port=Number(arg('--port')||existing.PORT||44173);
  await fsp.mkdir(dataDir,{recursive:true,mode:0o700});
  bootstrapReportPath=path.join(dataDir,'p0','macos-bootstrap.json');

  previousServiceLoaded=await serviceLoaded();
  const installedBefore=await existingInstall(dataDir);
  const preserveRuntime=!flag('--fresh-p0')&&(flag('--preserve-runtime')||previousServiceLoaded||Boolean(installedBefore));
  deploymentMode=preserveRuntime?'upgrade':'first_install';

  if(preserveRuntime&&!flag('--fresh-p0')){
    const legacy=await legacyBootstrapBackup(dataDir);
    if(legacy){
      const recovered=recoverLegacyRuntimeEnvSource(existingSource,legacy.source);
      if(recovered.recovered){
        existingSource=recovered.source;
        existing=envValuesFromSource(existingSource);
        runtimeRecovery={backupPath:legacy.backupPath,keys:recovered.keys};
        console.log(`检测到旧部署曾清空 Runtime 配置，已从部署前备份恢复 ${recovered.keys.length} 个运行时字段。`);
      }
    }
  }

  const updates=preserveRuntime
    ?macosUpgradeUpdates({workspaceRoot,dataDir,port})
    :macosP0Updates({workspaceRoot,dataDir,port});

  const updatedSource=upsertEnvSource(existingSource,updates);
  const updatedValues=envValuesFromSource(updatedSource);
  const processKeys=new Set([...Object.keys(updatedValues),...Object.keys(updates)]);
  processEnvBefore=new Map([...processKeys].map(key=>[key,{present:Object.hasOwn(process.env,key),value:process.env[key]}]));
  envRecord=await writeEnvAtomically(envPath,updatedSource,{backupDir:path.join(dataDir,'p0','env-backups')});
  Object.assign(process.env,updatedValues,updates);

  console.log(`部署模式：${preserveRuntime?'升级（保留现有 Joycrew / Harness / AI Provider 配置）':'首次 P0（安全关闭外部 Runtime）'}`);
  console.log(`已绑定真实项目目录：${workspaceRoot}`);
  console.log(`已绑定持久化数据目录：${dataDir}`);
  console.log(`本机地址：${baseUrl(port)}`);
  if(envRecord.backupPath)console.log(`原 .env 已备份：${envRecord.backupPath}`);
  if(previousServiceLoaded)console.log('检测到现有 Workbench LaunchAgent；升级 P0 期间保持旧服务运行，P0 通过后由安装器原子切换。');

  // Preflight 始终在外部 Runtime 关闭的只读环境中执行，但升级模式不会改写
  // .env 里已经通过现场验收的 Joycrew/Harness/Provider 开关和凭据。
  const preflightEnv={
    ...process.env,
    JOYCREW_ENABLED:'0',
    HARNESS_ENABLED:'0',
    AI_PROVIDER_ENABLED:'0'
  };
  const preflightArgs=previousServiceLoaded?['--allow-configured-port-in-use']:[];
  const preflight=await runNode('scripts/p0-host-preflight.mjs',preflightArgs,{env:preflightEnv});
  if(preflight.code!==0)throw new Error('真实主机 P0 未通过，未安装常驻服务。');

  if(flag('--prepare-only')){
    await writeReport({schemaVersion:2,status:'prepared',deploymentMode,runtimeSettingsPreserved:preserveRuntime,runtimeRecovery,previousServicePreservedDuringPreflight:previousServiceLoaded,finishedAt:new Date().toISOString(),productVersion:PRODUCT_VERSION,commit:repository.commit,workspaceRoot,dataDir,port,envBackup:envRecord.backupPath});
    succeeded=true;
    console.log('真实主机 P0 已通过；按 --prepare-only 要求未替换常驻服务。');
  }else{
    // LaunchAgent install 自己负责 bootout、端口释放、plist 备份和失败回滚。
    // 这里不提前停止旧服务，避免 P0 或安装前错误造成不必要停机。
    await serviceCommand('install',preserveRuntime?['--preserve-runtime']:[]);
    await serviceCommand('status');
    const url=baseUrl(port);
    if(!flag('--no-open'))await execResult('open',[url],{timeout:10_000});
    await writeReport({schemaVersion:2,status:'installed',deploymentMode,runtimeSettingsPreserved:preserveRuntime,runtimeRecovery,previousServicePreservedDuringPreflight:previousServiceLoaded,finishedAt:new Date().toISOString(),product:PRODUCT_DISPLAY_NAME,productVersion:PRODUCT_VERSION,commit:repository.commit,workspaceRoot,dataDir,port,url,envBackup:envRecord.backupPath,service:label});
    succeeded=true;
    console.log(`\n${PRODUCT_DISPLAY_NAME} v${PRODUCT_VERSION} 已在真实 Mac 上启动。`);
    console.log(`Git 提交：${repository.commit.slice(0,12)}`);
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
  await writeReport({schemaVersion:2,status:'failed',deploymentMode,runtimeRecovery,previousServicePreservedDuringPreflight:previousServiceLoaded,finishedAt:new Date().toISOString(),error:String(error.message||error),envRestored:Boolean(envRecord)}).catch(()=>undefined);
  process.exitCode=1;
}finally{
  if(!succeeded&&envRecord?.backupPath)console.error(`原配置备份仍保留：${envRecord.backupPath}`);
}
