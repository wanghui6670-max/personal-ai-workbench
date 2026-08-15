#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadWorkbenchEnv } from '../src/env.mjs';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';
import { buildMacosLaunchAgentPlist, validateHostBinding, validateHostReadinessReport } from '../src/host-p0.mjs';

const execFileAsync=promisify(execFile);
const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await loadWorkbenchEnv({root:appRoot});
const command=process.argv[2]||'status';
const label='com.dongjue.personal-ai-workbench';
const uid=process.getuid?.();
const home=os.homedir();
const launchAgentsDir=path.join(home,'Library','LaunchAgents');
const plistPath=path.join(launchAgentsDir,`${label}.plist`);
const logDir=path.join(home,'Library','Logs','PersonalAIWorkbench');
const stdoutPath=path.join(logDir,'workbench.log');
const stderrPath=path.join(logDir,'workbench.error.log');

function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]||null:null;}
function flag(name){return process.argv.includes(name);}
function domain(){return `gui/${uid}`;}
function target(){return `${domain()}/${label}`;}
function baseUrl(host,port){return `http://${host.includes(':')?`[${host}]`:host}:${port}`;}
function timestamp(){return new Date().toISOString().replace(/[:.]/g,'-');}

async function execResult(file,args,{timeout=20_000}={}){
  try{const result=await execFileAsync(file,args,{timeout,maxBuffer:2*1024*1024});return{code:0,stdout:result.stdout,stderr:result.stderr};}
  catch(error){return{code:Number.isInteger(error.code)?error.code:1,stdout:error.stdout||'',stderr:error.stderr||error.message||''};}
}

async function git(args){const result=await execResult('git',args);if(result.code!==0)throw new Error(result.stderr||'git 执行失败');return result.stdout.trim();}
async function loaded(){return (await execResult('launchctl',['print',target()])).code===0;}
async function bootout(){await execResult('launchctl',['bootout',domain(),plistPath]);}
async function bootstrap(){
  const result=await execResult('launchctl',['bootstrap',domain(),plistPath]);
  if(result.code!==0)throw new Error(`launchctl bootstrap 失败：${String(result.stderr||result.stdout).trim()}`);
  // The plist uses RunAtLoad=true, so a successful bootstrap is the start trigger.
  // A second immediate kickstart can race launchd registration on real macOS hosts.
}
function portInUse(host,port){return new Promise(resolve=>{const socket=net.connect({host,port});const finish=value=>{socket.destroy();resolve(value);};socket.setTimeout(500);socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false));});}
async function waitForPortFree(host,port,timeoutMs=5000){const started=Date.now();while(Date.now()-started<timeoutMs){if(!(await portInUse(host,port)))return true;await new Promise(resolve=>setTimeout(resolve,100));}return false;}
async function waitForHealth(binding,timeoutMs=25_000){
  const url=`${baseUrl(binding.host,binding.port)}/api/health`;const started=Date.now();
  while(Date.now()-started<timeoutMs){
    try{const response=await fetch(url,{cache:'no-store'});if(response.status===200){const body=await response.json();if(body.ok===true&&body.version===PRODUCT_VERSION)return body;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error(`LaunchAgent 已启动但 ${url} 未通过健康检查。`);
}

async function plistCommit(){
  try{
    const source=await fsp.readFile(plistPath,'utf8');
    const match=source.match(/<key>WORKBENCH_BUILD_COMMIT<\/key>\s*<string>([a-f0-9]{40})<\/string>/i);
    return match?.[1]?.toLowerCase()||null;
  }catch(error){
    if(error?.code==='ENOENT')return null;
    throw error;
  }
}

async function requirePlistCommit(expected){
  const actual=await plistCommit();
  if(actual!==expected)throw new Error(`LaunchAgent 提交不匹配：期望 ${expected.slice(0,12)}，实际 ${actual?.slice(0,12)||'missing'}。`);
  return actual;
}

async function currentBinding({requireJoycrewDisabled=false}={}){
  const binding=validateHostBinding({
    appRoot,
    dataDir:process.env.DATA_DIR,
    workspaceRoot:process.env.WORKSPACE_ROOT,
    host:process.env.HOST||'127.0.0.1',
    port:process.env.PORT||'4173',
    joycrewEnabled:process.env.JOYCREW_ENABLED||'0',
    requireJoycrewDisabled
  });
  const [realApp,realData,realWorkspace]=await Promise.all([fsp.realpath(binding.appRoot),fsp.realpath(binding.dataDir),fsp.realpath(binding.workspaceRoot)]);
  return{...binding,appRoot:realApp,dataDir:realData,workspaceRoot:realWorkspace};
}

async function validateInstallGate(binding){
  const reportPath=path.resolve(arg('--report')||path.join(binding.dataDir,'p0','host-readiness.json'));
  const relative=path.relative(binding.dataDir,reportPath);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('安装报告必须位于 DATA_DIR 内。');
  const report=JSON.parse(await fsp.readFile(reportPath,'utf8'));
  const commit=await git(['rev-parse','HEAD']);
  const branch=await git(['branch','--show-current']);
  if(branch!=='main')throw new Error(`LaunchAgent 只从 main 安装；当前分支是 ${branch||'detached'}。`);
  const changes=await git(['status','--porcelain','--untracked-files=no']);
  if(changes)throw new Error('仓库存在已跟踪文件修改，拒绝安装常驻服务。');
  validateHostReadinessReport(report,{productVersion:PRODUCT_VERSION,commit,appRoot:binding.appRoot,dataDir:binding.dataDir,workspaceRoot:binding.workspaceRoot});
  return{reportPath,commit,report};
}

async function install(){
  assert.equal(process.platform,'darwin','LaunchAgent 安装仅支持 macOS。');
  assert.ok(Number.isInteger(uid),'无法确定当前 macOS 用户 UID。');
  const preserveRuntime=flag('--preserve-runtime');
  const binding=await currentBinding({requireJoycrewDisabled:!preserveRuntime});
  const gate=await validateInstallGate(binding);
  await Promise.all([
    fsp.mkdir(launchAgentsDir,{recursive:true,mode:0o700}),
    fsp.mkdir(logDir,{recursive:true,mode:0o700})
  ]);
  const wasLoaded=await loaded();
  let previous=null;
  try{previous=await fsp.readFile(plistPath,'utf8');}catch(error){if(error?.code!=='ENOENT')throw error;}
  const backupPath=previous?`${plistPath}.backup-${timestamp()}`:null;
  if(previous)await fsp.writeFile(backupPath,previous,{encoding:'utf8',mode:0o600});
  await bootout();
  if(!(await waitForPortFree(binding.host,binding.port)))throw new Error(`端口 ${binding.host}:${binding.port} 仍被其他进程占用，拒绝覆盖。`);

  const plist=buildMacosLaunchAgentPlist({
    label,
    appRoot:binding.appRoot,
    nodePath:process.execPath,
    home,
    pathEnv:process.env.PATH||'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    stdoutPath,
    stderrPath,
    buildCommit:gate.commit
  });
  const temp=`${plistPath}.tmp-${process.pid}`;
  try{
    await fsp.writeFile(temp,plist,{encoding:'utf8',mode:0o600});
    const lint=await execResult('plutil',['-lint',temp]);
    if(lint.code!==0)throw new Error(`LaunchAgent plist 校验失败：${String(lint.stderr||lint.stdout).trim()}`);
    await fsp.rename(temp,plistPath);
    await fsp.chmod(plistPath,0o600);
    await requirePlistCommit(gate.commit);
    await bootstrap();
    const health=await waitForHealth(binding);
    await requirePlistCommit(gate.commit);
    const manifestPath=path.join(binding.dataDir,'p0','macos-service.json');
    await fsp.mkdir(path.dirname(manifestPath),{recursive:true,mode:0o700});
    await fsp.writeFile(manifestPath,`${JSON.stringify({
      schemaVersion:2,
      label,
      installedAt:new Date().toISOString(),
      productVersion:PRODUCT_VERSION,
      commit:gate.commit,
      runtimeSettingsPreserved:preserveRuntime,
      p0Report:path.relative(binding.dataDir,gate.reportPath).split(path.sep).join('/'),
      dataBackup:gate.report.backup,
      appRoot:binding.appRoot,
      nodePath:process.execPath,
      host:binding.host,
      port:binding.port,
      plistPath,
      previousPlistBackup:backupPath,
      stdoutPath,
      stderrPath
    },null,2)}\n`,{encoding:'utf8',mode:0o600});
    console.log(`${PRODUCT_DISPLAY_NAME} LaunchAgent 已安装。`);
    console.log(`服务：${target()}`);
    console.log(`地址：${baseUrl(binding.host,binding.port)}`);
    console.log(`版本：${health.version}`);
    console.log(`提交：${gate.commit.slice(0,12)}`);
    console.log(`Runtime 配置：${preserveRuntime?'保留':'首次 P0 安全模式'}`);
    console.log(`P0 报告：${gate.reportPath}`);
    console.log(`日志：${stdoutPath}`);
    console.log(`服务清单：${manifestPath}`);
    if(backupPath)console.log(`旧 plist 备份：${backupPath}`);
  }catch(error){
    await fsp.rm(temp,{force:true}).catch(()=>undefined);
    await bootout();
    if(previous){await fsp.writeFile(plistPath,previous,{encoding:'utf8',mode:0o600});if(wasLoaded)await bootstrap().catch(()=>undefined);}
    else await fsp.rm(plistPath,{force:true});
    throw error;
  }
}

async function status(){
  assert.equal(process.platform,'darwin','LaunchAgent 状态仅支持 macOS。');
  const binding=await currentBinding();
  const launch=await execResult('launchctl',['print',target()]);
  let health=null;
  try{const response=await fetch(`${baseUrl(binding.host,binding.port)}/api/health`,{cache:'no-store'});health={status:response.status,body:await response.json().catch(()=>null)};}catch{}
  let expectedCommit=null;
  try{expectedCommit=await git(['rev-parse','HEAD']);}catch{}
  const installedCommit=await plistCommit();
  const commitMatches=!expectedCommit||installedCommit===expectedCommit;
  console.log(JSON.stringify({label,loaded:launch.code===0,plistPath,expectedCommit,installedCommit,commitMatches,health,stdoutPath,stderrPath},null,2));
  if(launch.code!==0||health?.status!==200||health?.body?.ok!==true||health?.body?.version!==PRODUCT_VERSION||!commitMatches)process.exitCode=1;
}

async function start(){
  assert.equal(process.platform,'darwin','LaunchAgent 启动仅支持 macOS。');
  const binding=await currentBinding();
  await fsp.access(plistPath);
  const expectedCommit=await git(['rev-parse','HEAD']);
  await requirePlistCommit(expectedCommit);
  if(await loaded()){
    const health=await waitForHealth(binding);
    console.log(`${label} 已在运行 · v${health.version} · ${expectedCommit.slice(0,12)}`);
    return;
  }
  if(!(await waitForPortFree(binding.host,binding.port)))throw new Error(`端口 ${binding.host}:${binding.port} 被其他进程占用。`);
  await bootstrap();
  try{
    const health=await waitForHealth(binding);
    await requirePlistCommit(expectedCommit);
    console.log(`已启动 ${label} · v${health.version} · ${expectedCommit.slice(0,12)}`);
  }catch(error){
    await bootout();
    throw error;
  }
}

async function stop(){
  assert.equal(process.platform,'darwin','LaunchAgent 停止仅支持 macOS。');
  if(await loaded())await bootout();
  console.log(`已暂停 ${label}；plist、数据、工作区和日志均保留。`);
}

async function restart(){
  assert.equal(process.platform,'darwin','LaunchAgent 重启仅支持 macOS。');
  const binding=await currentBinding();
  await fsp.access(plistPath);
  const expectedCommit=await git(['rev-parse','HEAD']);
  await requirePlistCommit(expectedCommit);
  await bootout();
  if(!(await waitForPortFree(binding.host,binding.port)))throw new Error(`端口 ${binding.host}:${binding.port} 仍被其他进程占用。`);
  await bootstrap();
  const health=await waitForHealth(binding);
  await requirePlistCommit(expectedCommit);
  console.log(`已重启 ${label} · v${health.version} · ${expectedCommit.slice(0,12)}`);
}

async function uninstall(){
  assert.equal(process.platform,'darwin','LaunchAgent 卸载仅支持 macOS。');
  await bootout();
  await fsp.rm(plistPath,{force:true});
  console.log(`已卸载 ${label}；数据、工作区和日志未删除。`);
}

try{
  if(command==='install')await install();
  else if(command==='status')await status();
  else if(command==='start')await start();
  else if(command==='stop')await stop();
  else if(command==='restart')await restart();
  else if(command==='uninstall')await uninstall();
  else throw new Error('用法：npm run service:macos -- install|status|start|stop|restart|uninstall [--report <path>] [--preserve-runtime]');
}catch(error){console.error(error.message||error);process.exitCode=1;}
