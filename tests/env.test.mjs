import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkbenchEnv, parseWorkbenchEnv, WORKBENCH_ENV_KEYS } from '../src/env.mjs';

const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function exists(target){return fsp.access(target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});}

function cleanChildEnv(overrides={}){
  const env={...process.env};
  for(const key of WORKBENCH_ENV_KEYS)delete env[key];
  return{...env,...overrides};
}

function runNode(script,{cwd,env}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script],{cwd,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
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

async function waitFor(url,timeout=8000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    try{const response=await fetch(url);if(response.ok)return response;}catch{}
    await new Promise(resolve=>setTimeout(resolve,75));
  }
  throw new Error('server did not start from .env PORT/HOST');
}

async function copyRuntime(target){
  await Promise.all([
    fsp.cp(path.join(projectRoot,'src'),path.join(target,'src'),{recursive:true}),
    fsp.cp(path.join(projectRoot,'scripts'),path.join(target,'scripts'),{recursive:true}),
    fsp.cp(path.join(projectRoot,'public'),path.join(target,'public'),{recursive:true}),
    fsp.copyFile(path.join(projectRoot,'package.json'),path.join(target,'package.json'))
  ]);
}

async function runNodeWithArgs(script,args,{cwd,env}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{cwd,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
}

test('dotenv parser accepts declared basic values and ignores unsafe or undeclared assignments',()=>{
  const parsed=parseWorkbenchEnv([
    'PORT=4173',
    'HOST="127.0.0.1"',
    'TRUSTED_ORIGINS=https://workbench.example.com',
    'WORKBENCH_SYNC_RATE_LIMIT=12',
    'WORKBENCH_SCAN_MAX_DEPTH=9',
    "WORKBENCH_PASSWORD='spaces stay here'",
    'SESSION_SECRET=',
    'OPENAI_MODEL="gpt-test\\nmodel" # comment',
    'CAPTURE_TOKEN=$(touch /tmp/never)',
    'OPENAI_API_KEY=`touch /tmp/never-either`',
    'PATH=/untrusted/bin',
    'BROKEN LINE'
  ].join('\n'));

  assert.deepEqual(parsed.values,{
    PORT:'4173',
    HOST:'127.0.0.1',
    TRUSTED_ORIGINS:'https://workbench.example.com',
    WORKBENCH_SYNC_RATE_LIMIT:'12',
    WORKBENCH_SCAN_MAX_DEPTH:'9',
    WORKBENCH_PASSWORD:'spaces stay here',
    SESSION_SECRET:'',
    OPENAI_MODEL:'gpt-test\nmodel'
  });
  assert.deepEqual(parsed.ignored.map(item=>[item.key,item.reason]),[
    ['CAPTURE_TOKEN','unsafe'],
    ['OPENAI_API_KEY','unsafe'],
    ['PATH','undeclared'],
    [null,'invalid']
  ]);
});

test('real environment values, including an empty string, take priority over .env',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-env-priority-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  await fsp.writeFile(path.join(root,'.env'),'PORT=4173\nHOST=127.0.0.1\nSESSION_SECRET=from-file\n','utf8');
  const env={PORT:'6000',SESSION_SECRET:''};

  const result=await loadWorkbenchEnv({root,env});

  assert.equal(env.PORT,'6000');
  assert.equal(env.SESSION_SECRET,'');
  assert.equal(env.HOST,'127.0.0.1');
  assert.deepEqual(result.loaded,['HOST']);
});

test('doctor and server load safe .env values without executing command substitutions',async t=>{
  const sandbox=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-env-entrypoints-'));
  t.after(()=>fsp.rm(sandbox,{recursive:true,force:true}));
  await copyRuntime(sandbox);
  const port=await freePort();
  const dataDir=path.join(sandbox,'runtime data');
  const workspaceRoot=path.join(sandbox,'runtime workspace');
  const dollarMarker=path.join(sandbox,'dollar-command-ran');
  const backtickMarker=path.join(sandbox,'backtick-command-ran');
  await fsp.writeFile(path.join(sandbox,'.env'),[
    `PORT=${port}`,
    'HOST="127.0.0.1"',
    `DATA_DIR='${dataDir}'`,
    `WORKSPACE_ROOT='${workspaceRoot}'`,
    'WORKBENCH_PASSWORD=',
    'SESSION_SECRET=',
    `CAPTURE_TOKEN=$(touch "${dollarMarker}")`,
    `OPENAI_MODEL=\`touch "${backtickMarker}"\``,
    'PATH=/untrusted/bin'
  ].join('\n'),'utf8');

  const env=cleanChildEnv();
  const doctor=await runNode(path.join('scripts','doctor.mjs'),{cwd:sandbox,env});
  assert.equal(doctor.code,0,doctor.stderr||doctor.stdout);
  assert.equal(await exists(dataDir),true,'doctor should accept DATA_DIR from .env');
  assert.equal(await exists(workspaceRoot),true,'doctor should accept WORKSPACE_ROOT from .env');
  assert.equal(await exists(dollarMarker),false,'$() must never execute');
  assert.equal(await exists(backtickMarker),false,'backticks must never execute');

  const child=spawn(process.execPath,[path.join('src','server.mjs')],{cwd:sandbox,env,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  try{await waitFor(`http://127.0.0.1:${port}/api/health`);}
  catch(error){child.kill('SIGTERM');throw new Error(`${error.message}\n${stderr}`);}
  child.kill('SIGTERM');
  await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  assert.equal(await exists(dollarMarker),false,'server must not execute $()');
  assert.equal(await exists(backtickMarker),false,'server must not execute backticks');
});

test('platform launchers delegate env loading to Node instead of parsing with a shell',async()=>{
  const [macLauncher,windowsLauncher]=await Promise.all([
    fsp.readFile(path.join(projectRoot,'start.command'),'utf8'),
    fsp.readFile(path.join(projectRoot,'start.bat'),'utf8')
  ]);
  assert.doesNotMatch(macLauncher,/\bsource\b|\bset\s+-a\b/);
  assert.doesNotMatch(windowsLauncher,/\bfor\s+\/f\b/i);
  assert.match(macLauncher,/npm run doctor/);
  assert.match(windowsLauncher,/npm run doctor/i);
});

test('Luna xhigh is the documented default and doctor reports configuration without a network claim',async t=>{
  const example=await fsp.readFile(path.join(projectRoot,'.env.example'),'utf8');
  assert.match(example,/^OPENAI_MODEL=gpt-5\.6-luna$/m);

  const sandbox=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-env-luna-doctor-'));
  t.after(()=>fsp.rm(sandbox,{recursive:true,force:true}));
  await copyRuntime(sandbox);
  const dataDir=path.join(sandbox,'data');
  const workspaceRoot=path.join(sandbox,'workspace');
  await fsp.writeFile(path.join(sandbox,'.env'),[
    `DATA_DIR='${dataDir}'`,
    `WORKSPACE_ROOT='${workspaceRoot}'`,
    'OPENAI_API_KEY=test-key-not-a-real-secret',
    'OPENAI_MODEL=gpt-5.6-luna',
    'WORKBENCH_PASSWORD='
  ].join('\n'),'utf8');

  const doctor=await runNode(path.join('scripts','doctor.mjs'),{cwd:sandbox,env:cleanChildEnv()});
  assert.equal(doctor.code,0,doctor.stderr||doctor.stdout);
  assert.match(doctor.stdout,/AI 判断配置: 已配置：gpt-5\.6-luna \/ 极高（xhigh）；未联网验证/);
  assert.doesNotMatch(doctor.stdout,/连接成功|调用成功|模型可达/);

  const doctorSource=await fsp.readFile(path.join(sandbox,'scripts','doctor.mjs'),'utf8');
  assert.doesNotMatch(doctorSource,/\bfetch\s*\(|https?:\/\//,'doctor must not contact OpenAI or another network endpoint');
});

test('the safe dotenv parser accepts the two-model provider fields',()=>{
  const parsed=parseWorkbenchEnv([
    'AI_PROVIDER_MODEL=gpt-5.6-luna',
    'AI_PROVIDER_API_KEY=primary-key',
    'AI_PROVIDER_GROK_MODEL=grok-4.6',
    'AI_PROVIDER_GROK_API_KEY=secondary-key',
    'AI_PROVIDER_ACTIVE_MODEL=grok-4.6'
  ].join('\n'));
  assert.deepEqual(parsed.values,{
    AI_PROVIDER_MODEL:'gpt-5.6-luna',
    AI_PROVIDER_API_KEY:'primary-key',
    AI_PROVIDER_GROK_MODEL:'grok-4.6',
    AI_PROVIDER_GROK_API_KEY:'secondary-key',
    AI_PROVIDER_ACTIVE_MODEL:'grok-4.6'
  });
});

test('backup and restore honor DATA_DIR from the safe project .env',async t=>{
  const sandbox=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-env-backup-restore-'));
  t.after(()=>fsp.rm(sandbox,{recursive:true,force:true}));
  await copyRuntime(sandbox);
  const dataDir=path.join(sandbox,'custom data');
  await fsp.writeFile(path.join(sandbox,'.env'),`DATA_DIR='${dataDir}'\n`,'utf8');
  const env=cleanChildEnv();

  const backup=await runNodeWithArgs(path.join('scripts','backup.mjs'),[],{cwd:sandbox,env});
  assert.equal(backup.code,0,backup.stderr||backup.stdout);
  const backupPath=backup.stdout.trim();
  assert.equal(path.dirname(backupPath),path.join(dataDir,'backups'));
  assert.equal(await exists(backupPath),true);

  const stateFile=path.join(dataDir,'state.json');
  const state=JSON.parse(await fsp.readFile(stateFile,'utf8'));
  state.inbox.push({id:'in_env_restore',text:'restore marker',source:'test',createdAt:'2026-08-12T00:00:00.000Z'});
  const input=path.join(sandbox,'restore-input.json');
  await fsp.writeFile(input,JSON.stringify({state}),'utf8');
  const restore=await runNodeWithArgs(path.join('scripts','restore.mjs'),[input],{cwd:sandbox,env});
  assert.equal(restore.code,0,restore.stderr||restore.stdout);
  const restored=JSON.parse(await fsp.readFile(stateFile,'utf8'));
  assert.equal(restored.inbox.some(item=>item.id==='in_env_restore'),true);
  assert.equal(await exists(path.join(sandbox,'data')),false,'default data directory must not be touched');
});
