import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectSessionStore} from '../src/harness-core/project-session-store.mjs';

async function tempDataDir(t){
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-project-session-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  return dir;
}

function session(overrides={}){
  return{
    version:1,
    id:'project:prj_1',
    type:'project',
    projectId:'prj_1',
    status:'open',
    authorityRefs:[
      {authority:'workbench',kind:'project',refId:'prj_1'},
      {authority:'local_workspace',kind:'project',refId:'prj_1'},
      {authority:'git',kind:'project',refId:'prj_1'},
      {authority:'feishu_project_record',kind:'project',refId:'prj_1'}
    ],
    cursor:{
      lastActivity:'2026-08-17T10:00:00.000Z',
      syncedAt:'2026-08-17T10:05:00.000Z',
      feishuRevisionId:'rev-1',
      feishuRecordBlockId:'block-1',
      feishuRecordedAt:'2026-08-17T10:05:00.000Z',
      feishuOperationId:'op-1'
    },
    executionRefs:['ex_1'],
    createdAt:'2026-08-17T10:00:00.000Z',
    updatedAt:'2026-08-17T10:05:00.000Z',
    ...overrides
  };
}

test('Project Session store is private and persists reference/cursor metadata only',async t=>{
  const dataDir=await tempDataDir(t);
  const store=new ProjectSessionStore({dataDir});
  await store.ensure();
  const harnessDir=path.join(dataDir,'harness');
  const sessionsDir=path.join(harnessDir,'sessions');
  assert.equal((await fsp.stat(harnessDir)).mode&0o777,0o700);
  assert.equal((await fsp.stat(sessionsDir)).mode&0o777,0o700);

  await store.write(session());
  const restored=await store.read('project:prj_1');
  assert.deepEqual(restored,session());
  const files=await fsp.readdir(sessionsDir);
  assert.equal(files.length,1);
  assert.equal((await fsp.stat(path.join(sessionsDir,files[0]))).mode&0o777,0o600);
});

test('Project Session store rejects narrative/body fields at every persistence boundary',async t=>{
  const dataDir=await tempDataDir(t);
  const forbidden=[
    ['summary','项目总结正文'],
    ['resume','恢复摘要正文'],
    ['blocker','卡点正文'],
    ['workingMemory','隐式长期记忆'],
    ['feishuText','飞书正文'],
    ['gitHistory',['commit message']]
  ];
  for(const [field,value] of forbidden){
    const store=new ProjectSessionStore({dataDir});
    await assert.rejects(()=>store.write(session({[field]:value})),error=>error?.code==='PROJECT_SESSION_UNSAFE_FIELD');
  }

  const store=new ProjectSessionStore({dataDir});
  await assert.rejects(()=>store.write(session({
    cursor:{...session().cursor,summary:'不允许把摘要塞进 cursor'}
  })),error=>error?.code==='PROJECT_SESSION_UNSAFE_FIELD');
  await assert.rejects(()=>store.write(session({
    authorityRefs:[{authority:'feishu_project_record',kind:'project',refId:'prj_1',text:'飞书正文'}]
  })),error=>error?.code==='PROJECT_SESSION_UNSAFE_FIELD');
});

test('Project Session store serializes mutable updates without losing concurrent execution refs',async t=>{
  const dataDir=await tempDataDir(t);
  const store=new ProjectSessionStore({dataDir});
  await store.write(session({executionRefs:[]}));

  await Promise.all([
    store.update('project:prj_1',current=>({...current,executionRefs:[...current.executionRefs,'ex_a'],updatedAt:'2026-08-17T10:06:00.000Z'})),
    store.update('project:prj_1',current=>({...current,executionRefs:[...current.executionRefs,'ex_b'],updatedAt:'2026-08-17T10:07:00.000Z'}))
  ]);

  const restored=await store.read('project:prj_1');
  assert.deepEqual(new Set(restored.executionRefs),new Set(['ex_a','ex_b']));
});

test('Project Session store rejects symlinked Harness/session directories',async t=>{
  const dataDir=await tempDataDir(t);
  const target=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-project-session-target-'));
  t.after(()=>fsp.rm(target,{recursive:true,force:true}));
  await fsp.symlink(target,path.join(dataDir,'harness'));
  const store=new ProjectSessionStore({dataDir});
  await assert.rejects(()=>store.ensure(),/Project Session 目录不是安全目录/);
});
