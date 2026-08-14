#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';
import { WORKBENCH_ENV_KEYS } from '../src/env.mjs';

const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startedAt=new Date().toISOString();
const reportPath=path.resolve(argumentValue('--report')||path.join(projectRoot,'p0-deployment-acceptance.json'));
const checks=[];
const report={
  schemaVersion:1,
  product:PRODUCT_DISPLAY_NAME,
  productVersion:PRODUCT_VERSION,
  acceptanceProfile:'p0_isolated_host_joycrew_disabled',
  startedAt,
  finishedAt:null,
  status:'running',
  commit:process.env.GITHUB_SHA||null,
  runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},
  scope:{realCredentialsUsed:false,joycrewEnabled:false,externalWrites:false,productionDeployment:false},
  checks,
  summary:{},
  error:null
};

let tempRoot=null;
let server=null;
let failed=null;

function argumentValue(name){
  const index=process.argv.indexOf(name);
  return index>=0&&typeof process.argv[index+1]==='string'?process.argv[index+1]:null;
}

function record(name,details={}){
  checks.push({name,status:'passed',details});
  console.log(`✓ ${name}`);
}

function bounded(text,max=6000){
  const value=String(text||'');
  return value.length<=max?value:`${value.slice(0,max-1)}…`;
}

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

function isolatedEnv({root,dataDir,workspaceRoot,port,captureToken}){
  const env=Object.create(null);
  for(const key of ['PATH','LANG','LC_ALL','TMPDIR','TMP','TEMP','SystemRoot','COMSPEC','PATHEXT','CI','GITHUB_SHA','GITHUB_RUN_ID']){
    if(typeof process.env[key]==='string')env[key]=process.env[key];
  }
  for(const key of WORKBENCH_ENV_KEYS)env[key]='';
  Object.assign(env,{
    NODE_ENV:'test',
    HOME:path.join(root,'home'),
    USERPROFILE:path.join(root,'home'),
    HOST:'127.0.0.1',
    PORT:String(port),
    DATA_DIR:dataDir,
    WORKSPACE_ROOT:workspaceRoot,
    WORKBENCH_PASSWORD:'',
    SESSION_SECRET:'',
    TRUSTED_ORIGINS:'',
    COOKIE_SECURE:'0',
    CAPTURE_TOKEN:captureToken,
    OPENAI_API_KEY:'',
    AI_PROVIDER_ENABLED:'0',
    HARNESS_ENABLED:'0',
    JOYCREW_ENABLED:'0',
    ALLOW_INSECURE_PUBLIC:'0',
    WORKBENCH_RATE_LIMIT_WINDOW_MS:'60000',
    WORKBENCH_RATE_LIMIT_MAX_CLIENTS:'1000',
    WORKBENCH_CAPTURE_RATE_LIMIT:'60',
    WORKBENCH_SYNC_RATE_LIMIT:'12',
    WORKBENCH_MORNING_RATE_LIMIT:'20',
    WORKBENCH_HARNESS_RATE_LIMIT:'20',
    WORKBENCH_JOYCREW_RATE_LIMIT:'30',
    WORKBENCH_SCAN_MAX_FILES:'600',
    WORKBENCH_SCAN_MAX_DIRECTORIES:'400',
    WORKBENCH_SCAN_MAX_DEPTH:'12',
    WORKBENCH_SCAN_MAX_DURATION_MS:'5000'
  });
  return env;
}

function runNode(script,args,env,{timeoutMs=45_000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{
      cwd:projectRoot,
      env,
      stdio:['ignore','pipe','pipe']
    });
    let stdout='';let stderr='';let timedOut=false;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout=bounded(stdout+chunk,30_000);});
    child.stderr.on('data',chunk=>{stderr=bounded(stderr+chunk,30_000);});
    child.once('error',reject);
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      resolve({code,signal,stdout,stderr,timedOut});
    });
  });
}

function startServer(env){
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:projectRoot,
    env,
    stdio:['ignore','pipe','pipe']
  });
  const logs={stdout:'',stderr:''};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{logs.stdout=bounded(logs.stdout+chunk);});
  child.stderr.on('data',chunk=>{logs.stderr=bounded(logs.stderr+chunk);});
  const exited=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  return{child,logs,exited};
}

async function stopServer(instance){
  if(!instance||instance.child.exitCode!==null)return;
  instance.child.kill('SIGTERM');
  await Promise.race([
    instance.exited,
    new Promise(resolve=>setTimeout(resolve,2500))
  ]);
  if(instance.child.exitCode===null){
    instance.child.kill('SIGKILL');
    await instance.exited;
  }
}

async function waitForHealth(base,instance,timeoutMs=12_000){
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    if(instance.child.exitCode!==null){
      throw new Error(`工作台提前退出。stdout=${bounded(instance.logs.stdout,1500)} stderr=${bounded(instance.logs.stderr,1500)}`);
    }
    try{
      const response=await fetch(`${base}/api/health`);
      if(response.status===200)return{response,body:await response.json()};
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`工作台未在 ${timeoutMs}ms 内就绪。stderr=${bounded(instance.logs.stderr,1500)}`);
}

async function requestJson(base,pathname,{method='GET',body,headers={}}={}){
  const response=await fetch(`${base}${pathname}`,{
    method,
    headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const payload=await response.json().catch(()=>({}));
  return{response,body:payload};
}

function lastOutputLine(stdout){
  return String(stdout||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).at(-1)||'';
}

function inside(parent,target){
  const relative=path.relative(parent,target);
  return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);
}

try{
  assert.ok(Number(process.versions.node.split('.')[0])>=24,'P0 验收需要 Node 24+');
  tempRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'personal-ai-workbench-p0-'));
  const dataDir=path.join(tempRoot,'data');
  const workspaceRoot=path.join(tempRoot,'workspace');
  await Promise.all([
    fsp.mkdir(path.join(tempRoot,'home'),{recursive:true}),
    fsp.mkdir(workspaceRoot,{recursive:true})
  ]);
  const port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  const captureToken=`p0-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const env=isolatedEnv({root:tempRoot,dataDir,workspaceRoot,port,captureToken});

  const doctorBefore=await runNode('scripts/doctor.mjs',[],env);
  assert.equal(doctorBefore.timedOut,false,'部署前 doctor 超时');
  assert.equal(doctorBefore.code,0,doctorBefore.stderr||doctorBefore.stdout);
  record('部署前 doctor',{externalPipeline:'disabled',joycrew:'disabled'});

  server=startServer(env);
  let health=await waitForHealth(base,server);
  assert.equal(health.body.ok,true);
  assert.equal(health.body.version,PRODUCT_VERSION);
  assert.equal(health.body.joycrew?.enabled,false);
  record('长期进程启动与 readiness',{version:health.body.version,bind:'loopback'});

  const [indexResponse,assetResponse]=await Promise.all([
    fetch(`${base}/`),
    fetch(`${base}/joycrew-integration.js`)
  ]);
  const [indexHtml,assetText]=await Promise.all([indexResponse.text(),assetResponse.text()]);
  assert.equal(indexResponse.status,200);
  assert.equal(assetResponse.status,200);
  assert.match(indexHtml,/joycrew-integration\.js/);
  assert.match(assetText,/业务执行/);
  record('统一产品静态入口',{businessExecutionAsset:true});

  const joycrewStatus=await requestJson(base,'/api/joycrew/status');
  assert.equal(joycrewStatus.response.status,200);
  assert.equal(joycrewStatus.body.joycrew?.enabled,false);
  record('Joycrew 关闭时故障隔离',{personalWorkbenchAvailable:true,networkCallRequired:false});

  const captureId=`p0-capture-${crypto.randomUUID()}`;
  const captureText=`P0 Capture 基线 ${crypto.randomUUID()}`;
  const captureHeaders={authorization:`Bearer ${captureToken}`};
  const firstCapture=await requestJson(base,'/api/capture',{method:'POST',headers:captureHeaders,body:{captureId,text:captureText}});
  assert.equal(firstCapture.response.status,201);
  assert.equal(firstCapture.body.replayed,false);
  const replayCapture=await requestJson(base,'/api/capture',{method:'POST',headers:captureHeaders,body:{captureId,text:captureText}});
  assert.equal(replayCapture.response.status,200);
  assert.equal(replayCapture.body.replayed,true);
  assert.equal(replayCapture.body.item?.id,firstCapture.body.item?.id);
  record('iPhone Capture 幂等入口',{firstStatus:201,replayStatus:200});

  const baselineText=`P0 手工收件箱基线 ${crypto.randomUUID()}`;
  const baseline=await requestJson(base,'/api/inbox',{method:'POST',body:{text:baselineText}});
  assert.equal(baseline.response.status,201);
  let state=await requestJson(base,'/api/state');
  assert.equal(state.response.status,200);
  assert.ok(state.body.inbox.some(item=>item.id===firstCapture.body.item.id));
  assert.ok(state.body.inbox.some(item=>item.id===baseline.body.item.id));

  const backupRun=await runNode('scripts/backup.mjs',[],env);
  assert.equal(backupRun.timedOut,false,'backup v2 超时');
  assert.equal(backupRun.code,0,backupRun.stderr||backupRun.stdout);
  const backupPath=path.resolve(lastOutputLine(backupRun.stdout));
  assert.equal(inside(path.join(dataDir,'backups'),backupPath),true,`备份路径不在隔离 data/backups：${backupPath}`);
  const backup=JSON.parse(await fsp.readFile(backupPath,'utf8'));
  assert.equal(backup.backupVersion,2);
  assert.ok(backup.state&&typeof backup.state==='object');
  assert.ok(backup.config&&typeof backup.config==='object');
  assert.ok(Array.isArray(backup.captureReceipts));
  assert.ok(Array.isArray(backup.projectRecordReceipts));
  assert.equal(JSON.stringify(backup).includes(captureToken),false,'backup 不得包含 Capture Token');
  record('backup v2 完整性',{captureReceipts:backup.captureReceipts.length,projectRecordReceipts:backup.projectRecordReceipts.length});

  const mutationText=`P0 恢复后必须消失 ${crypto.randomUUID()}`;
  const mutation=await requestJson(base,'/api/inbox',{method:'POST',body:{text:mutationText}});
  assert.equal(mutation.response.status,201);
  state=await requestJson(base,'/api/state');
  assert.ok(state.body.inbox.some(item=>item.id===mutation.body.item.id));

  await stopServer(server);server=null;
  const restoreRun=await runNode('scripts/restore.mjs',[backupPath],env);
  assert.equal(restoreRun.timedOut,false,'restore 超时');
  assert.equal(restoreRun.code,0,restoreRun.stderr||restoreRun.stdout);
  assert.match(restoreRun.stdout,/恢复完成/);
  record('停止服务后的恢复与恢复前安全备份',{restoreSucceeded:true});

  const doctorAfter=await runNode('scripts/doctor.mjs',[],env);
  assert.equal(doctorAfter.timedOut,false,'恢复后 doctor 超时');
  assert.equal(doctorAfter.code,0,doctorAfter.stderr||doctorAfter.stdout);
  record('恢复后 doctor',{status:'ready'});

  server=startServer(env);
  health=await waitForHealth(base,server);
  assert.equal(health.body.version,PRODUCT_VERSION);
  state=await requestJson(base,'/api/state');
  assert.equal(state.response.status,200);
  assert.ok(state.body.inbox.some(item=>item.id===firstCapture.body.item.id),'Capture 基线未恢复');
  assert.ok(state.body.inbox.some(item=>item.id===baseline.body.item.id),'手工收件箱基线未恢复');
  assert.equal(state.body.inbox.some(item=>item.id===mutation.body.item.id),false,'备份后的变更不应残留');
  record('状态回滚读回',{baselineRestored:true,postBackupMutationRemoved:true});

  const restoredReplay=await requestJson(base,'/api/capture',{method:'POST',headers:captureHeaders,body:{captureId,text:captureText}});
  assert.equal(restoredReplay.response.status,200);
  assert.equal(restoredReplay.body.replayed,true);
  assert.equal(restoredReplay.body.item?.id,firstCapture.body.item.id);
  record('Capture 收据随 backup v2 恢复',{replayPreserved:true});

  report.summary={
    isolatedDataDirectory:true,
    isolatedWorkspace:true,
    backupVersion:backup.backupVersion,
    baselineInboxItems:2,
    restoredInboxItemsVerified:2,
    joycrewDisabledFailIsolation:true,
    reportArtifact:path.basename(reportPath)
  };
  report.status='passed';
}catch(error){
  failed=error;
  report.status='failed';
  report.error={message:String(error?.message||error),code:typeof error?.code==='string'?error.code:null};
  checks.push({name:'P0 deployment acceptance',status:'failed',details:{message:report.error.message}});
  console.error(`✗ P0 deployment acceptance: ${report.error.message}`);
}finally{
  await stopServer(server).catch(()=>undefined);
  report.finishedAt=new Date().toISOString();
  if(server){
    report.serverLogs={stdout:bounded(server.logs.stdout,2500),stderr:bounded(server.logs.stderr,2500)};
  }
  await fsp.mkdir(path.dirname(reportPath),{recursive:true});
  await fsp.writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',mode:0o600});
  if(tempRoot&&process.env.P0_KEEP_TEMP!=='1')await fsp.rm(tempRoot,{recursive:true,force:true});
}

console.log(`P0 report: ${reportPath}`);
if(failed)process.exitCode=1;
