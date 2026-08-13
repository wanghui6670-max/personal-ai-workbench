import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JsonStore } from '../src/store.mjs';

const projectRoot=path.resolve('.');

function emptyState(overrides={}){
  return {
    schemaVersion:1,inbox:[],inboxAcks:[],todos:[],todayPlan:[],todayPlanDate:null,projects:[],confirmations:[],notes:[],activities:[],morningSessions:[],
    ...overrides
  };
}

function runRestore(input,dataDir){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['scripts/restore.mjs',input],{
      cwd:projectRoot,
      env:{...process.env,DATA_DIR:dataDir},
      stdio:['ignore','pipe','pipe']
    });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

test('invalid restore inputs fail before creating data or backup files',async(t)=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-restore-invalid-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const invalidBackups=[
    {state:emptyState({schemaVersion:2})},
    {state:emptyState({todos:[{id:'td_no_due',done:false}]})},
    {state:emptyState({projects:[{id:'p_no_end'}]})},
    {state:emptyState({todayPlan:['td_forged']})},
    {state:emptyState({inbox:[null]})},
    {state:emptyState({todos:[{id:'td_duplicate',dueDate:'2026-08-20'},{id:'td_duplicate',dueDate:'2026-08-21'}]})},
    {state:emptyState({todos:[{id:'td_dangling',dueDate:'2026-08-20',projectId:'p_missing'}]})},
    {state:emptyState({inbox:[{id:'in_\" autofocus onfocus=\"alert(1)',text:'恶意 ID'}]})},
    {state:emptyState({projects:[{id:'p_percent',endDate:'2026-09-01',progress:{percent:'0\" data-action=\"delete'}}]})},
    {state:emptyState({projects:[{id:'p_folder',endDate:'2026-09-01',businessId:'biz_ok',folder:'../escape'}]}),config:{workspaceRoot:'./workspace',businesses:[{id:'biz_ok',name:'现有业务',folder:'01_现有业务'}]}},
    {state:emptyState({morningSessions:[{id:'ms_bad',messages:{role:'assistant',text:'bad'}}]})},
    {
      state:emptyState({projects:[{id:'p_bad_business',endDate:'2026-09-01',businessId:'biz_missing'}]}),
      config:{workspaceRoot:'./workspace',businesses:[{id:'biz_ok',name:'现有业务',folder:'01_现有业务'}]}
    }
  ];

  for(const [index,backup] of invalidBackups.entries()){
    const input=path.join(root,`invalid-${index}.json`);
    const dataDir=path.join(root,`data-${index}`);
    await fsp.writeFile(input,JSON.stringify(backup),'utf8');
    const result=await runRestore(input,dataDir);
    assert.notEqual(result.code,0,result.stdout);
    await assert.rejects(fsp.access(dataDir),error=>error.code==='ENOENT');
  }
});

test('dangerous config business IDs fail before any restore side effect',async(t)=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-restore-config-id-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'dangerous-config.json');
  const dataDir=path.join(root,'data');
  await fsp.writeFile(input,JSON.stringify({
    state:emptyState(),
    config:{workspaceRoot:'./workspace',businesses:[{id:'biz_\" onclick=\"alert',name:'危险业务',folder:'01_危险业务'}]}
  }),'utf8');

  const result=await runRestore(input,dataDir);
  assert.notEqual(result.code,0,result.stdout);
  assert.match(result.stderr,/businesses\[0\]\.id 必须是 .*安全 ID/);
  await assert.rejects(fsp.access(dataDir),error=>error.code==='ENOENT');
});

test('legacy state without schemaVersion or newer optional arrays remains restorable',async(t)=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-restore-legacy-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'data');
  const input=path.join(root,'legacy.json');
  const legacyState={
    todos:[{id:'td_legacy',title:'旧待办',dueDate:'2026-08-20',done:false}],
    projects:[{id:'p_legacy',name:'旧项目',endDate:'2026-09-01'}],
    todayPlan:[]
  };
  await fsp.writeFile(input,JSON.stringify(legacyState),'utf8');

  const result=await runRestore(input,dataDir);
  assert.equal(result.code,0,result.stderr);
  const restored=await new JsonStore(dataDir).readState();
  assert.equal(restored.schemaVersion,1);
  assert.deepEqual(restored.todos,legacyState.todos);
  assert.deepEqual(restored.projects,legacyState.projects);
  assert.deepEqual(restored.inbox,[]);
  assert.deepEqual(restored.inboxAcks,[]);
  assert.deepEqual(restored.activities,[]);
});

test('valid backup restores state and config as one round trip',async(t)=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-restore-valid-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'data');
  const store=new JsonStore(dataDir);
  await store.ensure();
  const expectedState=emptyState({
    todos:[{id:'td_keep',title:'保留待办',dueDate:'2026-08-20',done:false}],
    todayPlan:['td_keep'],
    todayPlanDate:'2026-08-12',
    projects:[{id:'p_keep',name:'保留项目',endDate:'2026-09-01'}]
  });
  const expectedConfig={...(await store.readConfig()),workspaceRoot:'./restored-workspace'};
  await store.writeState(expectedState);
  await store.writeConfig(expectedConfig);
  const backup=await store.backupNow();
  await store.writeState(emptyState());
  await store.writeConfig({...expectedConfig,workspaceRoot:'./changed-workspace'});

  const result=await runRestore(backup,dataDir);
  assert.equal(result.code,0,result.stderr);
  assert.match(result.stdout,/恢复完成/);
  assert.deepEqual(await store.readState(),expectedState);
  assert.deepEqual(await store.readConfig(),expectedConfig);
});
