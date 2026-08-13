import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonStore } from '../src/store.mjs';
import { createProject,assignProjectBusiness } from '../src/domain.mjs';
import { analyzeProject,ensureProjectDir,projectPath } from '../src/projects.mjs';

const execFileAsync=promisify(execFile);
delete process.env.WORKSPACE_ROOT;
process.env.OPENAI_API_KEY='';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-project-files-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app'),data=path.join(appRoot,'data'),workspace=path.join(appRoot,'workspace');
  await fsp.mkdir(workspace,{recursive:true});
  const store=new JsonStore(data);await store.ensure();
  return{root,appRoot,data,workspace,store,config:await store.readConfig()};
}

function project(overrides={}){
  return{
    id:'p_safe',businessId:'biz_client',name:'客户项目',intro:'第一版介绍',folder:'客户项目',
    createdAt:'2026-08-12',startDate:'2026-08-12',endDate:'2026-08-30',git:'',feishu:'',completed:false,archived:false,
    progress:{percent:0,status:'未启动',summary:'尚未同步',resume:'尚未同步',blocker:'暂无明确卡点',syncedAt:null},
    ...overrides
  };
}

test('existing PROJECT.md user content is preserved while only its managed block changes',async t=>{
  const {appRoot,config,workspace}=await fixture(t);const p=project();
  const dir=projectPath(appRoot,config,p);await fsp.mkdir(dir,{recursive:true});
  const userText='# 用户自己的项目说明\n\n这里是不可丢失的正文。\n';
  await fsp.writeFile(path.join(dir,'PROJECT.md'),userText,'utf8');

  await ensureProjectDir(appRoot,config,p);
  const first=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
  assert.ok(first.startsWith(userText));
  assert.equal(first.match(/personal-ai-workbench:managed:start/g)?.length,1);

  await ensureProjectDir(appRoot,config,{...p,intro:'第二版介绍',progress:{...p.progress,percent:42,status:'进行中'}});
  const second=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
  assert.ok(second.startsWith(userText));
  assert.match(second,/项目介绍：第二版介绍/);
  assert.match(second,/百分比：42%/);
  assert.doesNotMatch(second,/项目介绍：第一版介绍/);
  assert.equal(second.match(/personal-ai-workbench:managed:start/g)?.length,1);
  assert.equal(path.relative(workspace,dir).startsWith('..'),false);
});

test('concurrent same-name projects receive isolated folders',async t=>{
  const {appRoot,store,workspace}=await fixture(t);
  await store.updateState(state=>{state.inbox.push(
    {id:'in_first',text:'客户订餐小程序',source:'test',createdAt:'2026-08-12T00:00:00.000Z'},
    {id:'in_second',text:'客户订餐小程序',source:'test',createdAt:'2026-08-12T00:00:00.000Z'}
  );});
  const args={appRoot,store,description:'客户订餐小程序',endDate:'2026-08-30',businessId:'biz_client'};
  const [first,second]=await Promise.all([createProject({...args,sourceInboxId:'in_first'}),createProject({...args,sourceInboxId:'in_second'})]);
  assert.notEqual(first.project.folder,second.project.folder);
  const dirs=[first.project,second.project].map(p=>path.join(workspace,'03_客户项目',p.folder));
  assert.notEqual(dirs[0],dirs[1]);
  for(const dir of dirs)assert.equal((await fsp.stat(path.join(dir,'PROJECT.md'))).isFile(),true);
});

test('project creation replays the same inbox request and rejects changed parameters',async t=>{
  const {appRoot,store}=await fixture(t);
  await store.updateState(state=>{state.inbox.push({id:'in_replay',text:'可重放项目',source:'test',createdAt:'2026-08-12T00:00:00.000Z'});});
  const args={appRoot,store,description:'可重放项目',endDate:'2026-08-30',businessId:'biz_client',sourceInboxId:'in_replay'};
  const first=await createProject(args);
  const replay=await createProject(args);

  assert.equal(first.replay,false);
  assert.equal(replay.replay,true);
  assert.equal(replay.project.id,first.project.id);
  assert.equal((await store.readState()).projects.length,1);
  await assert.rejects(createProject({...args,endDate:'2026-08-31'}),error=>error.statusCode===409);
  await assert.rejects(createProject({...args,description:'已篡改的描述'}),error=>error.statusCode===409);
  assert.equal((await store.readState()).projects.length,1);
});

test('concurrent retries of one inbox source create at most one project',async t=>{
  const {appRoot,store}=await fixture(t);
  await store.updateState(state=>{state.inbox.push({id:'in_concurrent_replay',text:'并发重放项目',source:'test',createdAt:'2026-08-12T00:00:00.000Z'});});
  const args={appRoot,store,description:'并发重放项目',endDate:'2026-08-30',businessId:'biz_client',sourceInboxId:'in_concurrent_replay'};
  const results=await Promise.all([createProject(args),createProject(args)]);

  assert.equal(new Set(results.map(result=>result.project.id)).size,1);
  assert.equal(results.filter(result=>result.replay).length,1);
  assert.equal((await store.readState()).projects.length,1);
});

test('failed state commit rolls back only the newly prepared project directory',async t=>{
  const {appRoot,store,workspace}=await fixture(t);
  const businessDir=path.join(workspace,'03_客户项目');
  await fsp.mkdir(businessDir,{recursive:true});
  const existingFile=path.join(businessDir,'用户已有文件.txt');
  await fsp.writeFile(existingFile,'不可删除\n','utf8');
  await store.updateState(state=>{state.inbox.push({id:'in_failed_commit',text:'提交失败项目',source:'test',createdAt:'2026-08-12T00:00:00.000Z'});});
  const before=await store.readState(),originalAtomicWrite=store._atomicWrite.bind(store);
  let injected=false;
  store._atomicWrite=async(file,data)=>{
    if(!injected&&file===store.stateFile){injected=true;throw new Error('simulated state commit failure');}
    return originalAtomicWrite(file,data);
  };

  await assert.rejects(createProject({appRoot,store,description:'提交失败项目',endDate:'2026-08-30',businessId:'biz_client',sourceInboxId:'in_failed_commit'}),/simulated state commit failure/);
  assert.deepEqual(await store.readState(),before);
  assert.equal(await fsp.readFile(existingFile,'utf8'),'不可删除\n');
  assert.deepEqual((await fsp.readdir(businessDir)).sort(),['用户已有文件.txt']);
});

test('failed classification commit leaves no orphan and retry reuses the expected folder',async t=>{
  const {appRoot,store,workspace}=await fixture(t);
  const pending=project({id:'p_classification_rollback',businessId:null,folder:'待归类项目'});
  await store.updateState(state=>{state.projects.push(pending);});
  const businessDir=path.join(workspace,'03_客户项目');
  await fsp.mkdir(businessDir,{recursive:true});
  const existingFile=path.join(businessDir,'用户已有文件.txt');
  await fsp.writeFile(existingFile,'不可删除\n','utf8');
  const before=await store.readState(),originalAtomicWrite=store._atomicWrite.bind(store);
  let injected=false;
  store._atomicWrite=async(file,data)=>{
    if(!injected&&file===store.stateFile){injected=true;throw new Error('simulated classification state failure');}
    return originalAtomicWrite(file,data);
  };

  await assert.rejects(assignProjectBusiness({appRoot,store,projectId:pending.id,businessId:'biz_client'}),/simulated classification state failure/);
  assert.deepEqual(await store.readState(),before);
  assert.equal(await fsp.readFile(existingFile,'utf8'),'不可删除\n');
  assert.deepEqual((await fsp.readdir(businessDir)).sort(),['用户已有文件.txt']);

  const classified=await assignProjectBusiness({appRoot,store,projectId:pending.id,businessId:'biz_client'});
  assert.equal(classified.folder,'客户项目');
  assert.equal((await fsp.stat(path.join(businessDir,'客户项目','PROJECT.md'))).isFile(),true);
  assert.equal(await fsp.readFile(existingFile,'utf8'),'不可删除\n');
});

test('same-business retry never deletes a pre-existing project directory on state failure',async t=>{
  const {appRoot,store,workspace}=await fixture(t);
  const classified=project({id:'p_existing_classification',businessId:'biz_client',folder:'已有项目'});
  await store.updateState(state=>{state.projects.push(classified);});
  const dir=path.join(workspace,'03_客户项目',classified.folder);
  await fsp.mkdir(dir,{recursive:true});
  const existingFile=path.join(dir,'用户原文.txt');
  await fsp.writeFile(existingFile,'保留我\n','utf8');
  const before=await store.readState(),originalAtomicWrite=store._atomicWrite.bind(store);
  let injected=false;
  store._atomicWrite=async(file,data)=>{
    if(!injected&&file===store.stateFile){injected=true;throw new Error('simulated same-business state failure');}
    return originalAtomicWrite(file,data);
  };

  await assert.rejects(assignProjectBusiness({appRoot,store,projectId:classified.id,businessId:'biz_client'}),/simulated same-business state failure/);
  assert.deepEqual(await store.readState(),before);
  assert.equal(await fsp.readFile(existingFile,'utf8'),'保留我\n');
  assert.equal((await fsp.stat(dir)).isDirectory(),true);
  assert.deepEqual((await fsp.readdir(dir)).sort(),['用户原文.txt']);

  await assignProjectBusiness({appRoot,store,projectId:classified.id,businessId:'biz_client'});
  assert.equal((await fsp.stat(path.join(dir,'PROJECT.md'))).isFile(),true);
  assert.equal(await fsp.readFile(existingFile,'utf8'),'保留我\n');
});

test('classification rejects a project-directory symlink and leaves state and external files unchanged',async t=>{
  const {appRoot,store,workspace,root}=await fixture(t);
  const pending=project({id:'p_pending',businessId:null,folder:'客户项目'});
  await store.updateState(state=>{state.projects.push(pending);});
  const before=await store.readState();
  const outside=path.join(root,'outside');await fsp.mkdir(outside);
  const external=path.join(outside,'PROJECT.md');await fsp.writeFile(external,'外部原文\n','utf8');
  const business=path.join(workspace,'03_客户项目');await fsp.mkdir(business,{recursive:true});
  await fsp.symlink(outside,path.join(business,pending.folder));

  await assert.rejects(assignProjectBusiness({appRoot,store,projectId:pending.id,businessId:'biz_client'}),/符号链接/);
  assert.deepEqual(await store.readState(),before);
  assert.equal(await fsp.readFile(external,'utf8'),'外部原文\n');
});

test('PROJECT.md symlinks and hard links are rejected without changing external content',async t=>{
  const {appRoot,config,root}=await fixture(t);const outside=path.join(root,'outside.md');
  await fsp.writeFile(outside,'外部原文\n','utf8');

  for(const kind of ['symlink','hardlink']){
    const p=project({id:`p_${kind}`,folder:`项目-${kind}`}),dir=projectPath(appRoot,config,p);
    await fsp.mkdir(dir,{recursive:true});
    const target=path.join(dir,'PROJECT.md');
    if(kind==='symlink')await fsp.symlink(outside,target);else await fsp.link(outside,target);
    await assert.rejects(ensureProjectDir(appRoot,config,p),new RegExp(kind==='symlink'?'符号链接':'硬链接'));
    assert.equal(await fsp.readFile(outside,'utf8'),'外部原文\n');
  }
});

test('git analysis disables repository fsmonitor and strips HTTP remote secrets',async t=>{
  try{await execFileAsync('git',['--version']);}catch{t.skip('git is unavailable');return;}
  const {appRoot,config,root}=await fixture(t),p=project({id:'p_git',folder:'Git项目'});
  const dir=await ensureProjectDir(appRoot,config,p),trace=path.join(root,'fsmonitor-ran');
  await execFileAsync('git',['init',dir]);
  const hook=path.join(root,'fsmonitor.sh');
  await fsp.writeFile(hook,`#!/bin/sh\ntouch "${trace}"\nexit 0\n`,'utf8');await fsp.chmod(hook,0o700);
  await execFileAsync('git',['-C',dir,'config','core.fsmonitor',hook]);
  await execFileAsync('git',['-C',dir,'remote','add','origin','https://alice:secret@example.invalid/repo.git?token=hidden#fragment']);

  const analysis=await analyzeProject(appRoot,config,p);
  await assert.rejects(fsp.access(trace),error=>error.code==='ENOENT');
  assert.equal(analysis.gitRemote,'https://example.invalid/repo.git');
  assert.doesNotMatch(analysis.gitRemote,/alice|secret|token|hidden|fragment/);
});
