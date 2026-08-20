#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadWorkbenchEnv } from '../src/env.mjs';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';
import { compareSnapshots, evaluateHostDoctorReport, parseDoctorJsonReport, pathFingerprint, snapshotTree, validateHostBinding } from '../src/host-p0.mjs';

const execFileAsync=promisify(execFile);
const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await loadWorkbenchEnv({root:appRoot});
const startedAt=new Date().toISOString();
let server=null;
let failure=null;

function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]||null:null;}
function flag(name){return process.argv.includes(name);}
function limited(value,max=6000){const text=String(value||'');return text.length<=max?text:`${text.slice(0,max-1)}…`;}
function relativeInside(parent,target){const relative=path.relative(parent,target);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));}

const allowConfiguredPortInUse=flag('--allow-configured-port-in-use');
const configuredDataDir=String(process.env.DATA_DIR||'').trim();
const configuredWorkspaceRoot=String(process.env.WORKSPACE_ROOT||'').trim();
const dataDir=configuredDataDir&&path.isAbsolute(configuredDataDir)?path.resolve(configuredDataDir):null;
const workspaceRoot=configuredWorkspaceRoot&&path.isAbsolute(configuredWorkspaceRoot)?path.resolve(configuredWorkspaceRoot):null;
const reportPath=path.resolve(arg('--report')||(dataDir?path.join(dataDir,'p0','host-readiness.json'):path.join(os.tmpdir(),'personal-ai-workbench-host-p0-failed.json')));
const report={
  schemaVersion:1,
  product:PRODUCT_DISPLAY_NAME,
  productVersion:PRODUCT_VERSION,
  profile:'real_host_local_first_joycrew_disabled',
  startedAt,
  finishedAt:null,
  status:'running',
  commit:null,
  branch:null,
  binding:null,
  scope:{joycrewEnabled:false,externalWrites:false,realCliReadChecks:false,productionCutover:false,configuredPortMayBeInUse:allowConfiguredPortInUse},
  checks:[],
  backup:null,
  snapshots:null,
  smoke:null,
  error:null
};

function pass(name,details={}){report.checks.push({name,status:'passed',details});console.log(`✓ ${name}`);}
function failReport(error){failure=error;report.status='failed';report.error={message:String(error?.message||error),code:typeof error?.code==='string'?error.code:null};report.checks.push({name:'真实主机 P0',status:'failed',details:{message:report.error.message}});console.error(`✗ 真实主机 P0: ${report.error.message}`);}

function freePort(){return new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();probe.close(error=>error?reject(error):resolve(address.port));});});}
function portInUse(host,port){return new Promise(resolve=>{const socket=net.connect({host,port});const finish=value=>{socket.destroy();resolve(value);};socket.setTimeout(500);socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false));});}

function runNode(script,args,env,{timeoutMs=120_000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{cwd:appRoot,env,stdio:['ignore','pipe','pipe']});
    let stdout='';let stderr='';let timedOut=false;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout=limited(stdout+chunk,30_000);});
    child.stderr.on('data',chunk=>{stderr=limited(stderr+chunk,30_000);});
    child.once('error',reject);
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,timedOut});});
  });
}

function startServer(env){
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:appRoot,env,stdio:['ignore','pipe','pipe']});
  const logs={stdout:'',stderr:''};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{logs.stdout=limited(logs.stdout+chunk);});
  child.stderr.on('data',chunk=>{logs.stderr=limited(logs.stderr+chunk);});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  return{child,logs,exited};
}

async function stopServer(instance){
  if(!instance||instance.child.exitCode!==null)return;
  instance.child.kill('SIGTERM');
  await Promise.race([instance.exited,new Promise(resolve=>setTimeout(resolve,3000))]);
  if(instance.child.exitCode===null){instance.child.kill('SIGKILL');await instance.exited;}
}

async function waitForHealth(base,instance,timeoutMs=15_000){
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    if(instance.child.exitCode!==null)throw new Error(`测试进程提前退出：${limited(instance.logs.stderr||instance.logs.stdout,1200)}`);
    try{const response=await fetch(`${base}/api/health`);if(response.status===200)return{response,body:await response.json()};}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`测试端口未就绪：${limited(instance.logs.stderr,1200)}`);
}

async function git(args){return (await execFileAsync('git',args,{cwd:appRoot,timeout:10_000,maxBuffer:2*1024*1024})).stdout.trim();}
function outputPath(stdout){return String(stdout||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).at(-1)||'';}
async function sha256File(file){return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');}
function reportSafeEnv(){
  const values=['CAPTURE_TOKEN','SESSION_SECRET','WORKBENCH_PASSWORD','OPENAI_API_KEY','AI_PROVIDER_API_KEY','AI_PROVIDER_GROK_API_KEY','HARNESS_PROVIDER_API_KEY','JOYCREW_TRUSTED_PROXY_TOKEN','JOYCREW_SESSION_TOKEN'];
  return values.map(key=>process.env[key]).filter(value=>typeof value==='string'&&value.length>=8);
}

try{
  assert.ok(Number(process.versions.node.split('.')[0])>=24,'真实主机 P0 需要 Node 24+。');
  const binding=validateHostBinding({
    appRoot,
    dataDir:process.env.DATA_DIR,
    workspaceRoot:process.env.WORKSPACE_ROOT,
    host:process.env.HOST||'127.0.0.1',
    port:process.env.PORT||'4173',
    joycrewEnabled:process.env.JOYCREW_ENABLED||'0'
  });
  if(!relativeInside(binding.dataDir,reportPath))throw new Error('P0 报告必须保存在 DATA_DIR 内，避免误提交到 Git。');
  await fsp.mkdir(binding.dataDir,{recursive:true,mode:0o700});
  await fsp.access(binding.workspaceRoot);
  const [realApp,realData,realWorkspace]=await Promise.all([fsp.realpath(binding.appRoot),fsp.realpath(binding.dataDir),fsp.realpath(binding.workspaceRoot)]);
  report.binding={
    appRootFingerprint:pathFingerprint(realApp),
    dataDirFingerprint:pathFingerprint(realData),
    workspaceRootFingerprint:pathFingerprint(realWorkspace),
    host:binding.host,
    port:binding.port,
    platform:process.platform,
    arch:process.arch
  };
  pass('部署绑定',{host:binding.host,port:binding.port,data:path.basename(realData),workspace:path.basename(realWorkspace)});

  report.commit=await git(['rev-parse','HEAD']);
  report.branch=await git(['branch','--show-current']);
  if(report.branch!=='main'&&!flag('--allow-non-main'))throw new Error(`真实主机 P0 必须从 main 运行；当前分支是 ${report.branch||'detached'}。`);
  const trackedChanges=await git(['status','--porcelain','--untracked-files=no']);
  if(trackedChanges)throw new Error('仓库存在已跟踪文件修改，请先提交、还原或另建干净检出。');
  let matchesOriginMain=null;
  try{const originMain=await git(['rev-parse','refs/remotes/origin/main']);matchesOriginMain=originMain===report.commit;if(!matchesOriginMain)throw new Error('本地 main 与 origin/main 不一致，请先 git fetch origin && git pull --ff-only。');}
  catch(error){if(/不一致/.test(error.message))throw error;}
  pass('代码基线',{branch:report.branch||'detached',commit:report.commit.slice(0,12),trackedTreeClean:true,matchesOriginMain});

  const configuredPortBusy=await portInUse(binding.host,binding.port);
  if(configuredPortBusy&&!allowConfiguredPortInUse)throw new Error(`配置端口 ${binding.host}:${binding.port} 正在使用。请先停止旧工作台，再执行真实主机 P0。`);
  pass(configuredPortBusy?'现有服务保留运行':'旧进程已停止',{configuredPortFree:!configuredPortBusy,existingServiceAllowed:configuredPortBusy&&allowConfiguredPortInUse});

  const doctorEnv={...process.env,JOYCREW_ENABLED:'0'};
  const doctor=await runNode('scripts/doctor.mjs',['--json'],doctorEnv,{timeoutMs:180_000});
  assert.equal(doctor.timedOut,false,'doctor 超时。');
  assert.equal(doctor.code,0,doctor.stderr||doctor.stdout);
  const doctorEvidence=evaluateHostDoctorReport(parseDoctorJsonReport(doctor.stdout));
  assert.equal(doctorEvidence.ok,true,`doctor JSON required checks 失败：${doctorEvidence.failedRequiredCheckIds.join(',')||'unknown'}`);
  report.scope.realCliReadChecks=doctorEvidence.realCliReadChecks;
  pass('真实主机 doctor',{
    schemaVersion:1,
    getnoteRuntime:doctorEvidence.getnoteRuntime,
    larkCli:doctorEvidence.larkCli,
    joycrewDisabled:true
  });

  const backup=await runNode('scripts/backup.mjs',[],doctorEnv,{timeoutMs:120_000});
  assert.equal(backup.timedOut,false,'backup v2 超时。');
  assert.equal(backup.code,0,backup.stderr||backup.stdout);
  const backupPath=path.resolve(outputPath(backup.stdout));
  if(!relativeInside(binding.dataDir,backupPath))throw new Error('backup v2 输出不在 DATA_DIR 内。');
  const backupBytes=await fsp.readFile(backupPath);
  const backupJson=JSON.parse(backupBytes.toString('utf8'));
  assert.equal(backupJson.backupVersion,2,'必须生成 backup v2。');
  assert.ok(backupJson.state&&backupJson.config&&Array.isArray(backupJson.captureReceipts)&&Array.isArray(backupJson.projectRecordReceipts),'backup v2 字段不完整。');
  for(const secret of reportSafeEnv())assert.equal(backupBytes.includes(Buffer.from(secret)),false,'backup 中发现运行凭据值。');
  report.backup={relativePath:path.relative(binding.dataDir,backupPath).split(path.sep).join('/'),bytes:backupBytes.length,sha256:await sha256File(backupPath)};
  pass('真实数据 backup v2',{relativePath:report.backup.relativePath,bytes:report.backup.bytes,sha256:report.backup.sha256});

  const ignorePrefixes=[path.relative(binding.dataDir,path.dirname(reportPath)).split(path.sep).join('/')].filter(value=>value&&value!=='.');
  const workspaceSnapshotOptions={hashFiles:false,maxDepth:2,ignoreNames:['.git','node_modules','.next','dist','build','coverage','.venv','venv']};
  const before={
    data:await snapshotTree(binding.dataDir,{hashFiles:true,ignorePrefixes}),
    workspace:await snapshotTree(binding.workspaceRoot,workspaceSnapshotOptions)
  };
  pass('启动前目录快照',{dataEntries:before.data.entryCount,workspaceEntries:before.workspace.entryCount,workspaceMaxDepth:workspaceSnapshotOptions.maxDepth});

  const smokePort=arg('--smoke-port')?Number(arg('--smoke-port')):await freePort();
  if(!Number.isInteger(smokePort)||smokePort<1||smokePort>65535)throw new Error('--smoke-port 无效。');
  if(await portInUse('127.0.0.1',smokePort))throw new Error(`测试端口 ${smokePort} 已被占用。`);
  const smokeEnv={
    ...process.env,
    HOST:'127.0.0.1',PORT:String(smokePort),JOYCREW_ENABLED:'0',HARNESS_ENABLED:'0',
    AI_PROVIDER_ENABLED:'0',OPENAI_API_KEY:'',WORKBENCH_PASSWORD:'',SESSION_SECRET:'',
    TRUSTED_ORIGINS:'',COOKIE_SECURE:'0',CAPTURE_TOKEN:'',ALLOW_INSECURE_PUBLIC:'0'
  };
  server=startServer(smokeEnv);
  const base=`http://127.0.0.1:${smokePort}`;
  const health=await waitForHealth(base,server);
  assert.equal(health.body.ok,true);assert.equal(health.body.version,PRODUCT_VERSION);assert.equal(health.body.joycrew?.enabled,false);
  const [index,asset,state,joycrew]=await Promise.all([
    fetch(`${base}/`),fetch(`${base}/joycrew-integration.js`),fetch(`${base}/api/state`),fetch(`${base}/api/joycrew/status`)
  ]);
  const [indexText,assetText,stateBody,joycrewBody]=await Promise.all([index.text(),asset.text(),state.json(),joycrew.json()]);
  assert.equal(index.status,200);assert.equal(asset.status,200);assert.equal(state.status,200);assert.equal(joycrew.status,200);
  assert.match(indexText,/joycrew-integration\.js/);assert.match(assetText,/业务执行/);assert.ok(stateBody.config);assert.equal(joycrewBody.joycrew?.enabled,false);
  await stopServer(server);server=null;
  report.smoke={port:smokePort,health:true,stateRead:true,unifiedAsset:true,joycrewDisabled:true};
  pass('测试端口只读启动',{port:smokePort,version:health.body.version});

  const after={
    data:await snapshotTree(binding.dataDir,{hashFiles:true,ignorePrefixes}),
    workspace:await snapshotTree(binding.workspaceRoot,workspaceSnapshotOptions)
  };
  const dataComparison=compareSnapshots(before.data,after.data);
  const workspaceComparison=compareSnapshots(before.workspace,after.workspace);
  assert.equal(dataComparison.equal,true,'测试启动改变了 DATA_DIR。');
  assert.equal(workspaceComparison.equal,true,'测试启动改变了 WORKSPACE_ROOT 的浅层哨兵快照。');
  report.snapshots={policy:{workspaceMaxDepth:workspaceSnapshotOptions.maxDepth},before,after,dataComparison,workspaceComparison};
  pass('只读启动无目录漂移',{dataUnchanged:true,workspaceSentinelUnchanged:true,workspaceMaxDepth:workspaceSnapshotOptions.maxDepth});

  report.status='passed';
}catch(error){failReport(error);}
finally{
  await stopServer(server).catch(()=>undefined);
  report.finishedAt=new Date().toISOString();
  await fsp.mkdir(path.dirname(reportPath),{recursive:true});
  await fsp.writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',mode:0o600});
}

console.log(`真实主机 P0 报告：${reportPath}`);
if(report.status==='passed'&&process.platform==='darwin')console.log(`下一步：npm run service:macos -- install --report "${reportPath}"`);
if(failure)process.exitCode=1;
