import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectSessionStore} from '../src/harness-core/project-session-store.mjs';
import {ProjectSessionManager} from '../src/harness-core/project-session-manager.mjs';

async function fixture(t){
  const dataDir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-project-session-manager-'));
  t.after(()=>fsp.rm(dataDir,{recursive:true,force:true}));
  const state={projects:[{
    id:'prj_1',name:'Personal AI Workbench',businessId:'biz_ai',folder:'Personal-AI-Workbench',
    endDate:'2026-09-30',createdAt:'2026-08-11T00:00:00.000Z',archived:false,completed:false,
    git:'https://example.invalid/repo.git',feishu:'https://example.feishu.cn/docx/example',
    progress:{
      percent:40,status:'进行中',hasBlocker:true,
      lastActivity:'2026-08-17T10:00:00.000Z',syncedAt:'2026-08-17T10:05:00.000Z',
      feishuRevisionId:'rev-1',feishuRecordBlockId:'block-1',feishuRecordedAt:'2026-08-17T10:05:00.000Z',feishuOperationId:'op-1'
    }
  }]};
  const workbenchStore={readState:async()=>structuredClone(state)};
  const sessionStore=new ProjectSessionStore({dataDir});
  let tick=0;
  const manager=new ProjectSessionManager({
    workbenchStore,
    sessionStore,
    clock:()=>`2026-08-17T11:00:0${tick++}.000Z`
  });
  return{state,sessionStore,manager};
}

test('opening the same project resumes one stable Session without advancing its checkpoint cursor',async t=>{
  const f=await fixture(t);
  const first=await f.manager.openProject('prj_1');
  assert.equal(first.id,'project:prj_1');
  assert.equal(first.projectId,'prj_1');
  assert.equal(first.type,'project');
  assert.equal(first.status,'open');
  assert.deepEqual(first.authorityRefs,[
    {authority:'workbench',kind:'project',refId:'prj_1'},
    {authority:'local_workspace',kind:'project',refId:'prj_1'},
    {authority:'git',kind:'project',refId:'prj_1'},
    {authority:'feishu_project_record',kind:'project',refId:'prj_1'}
  ]);
  assert.deepEqual(first.cursor,{
    lastActivity:'2026-08-17T10:00:00.000Z',
    syncedAt:'2026-08-17T10:05:00.000Z',
    feishuRevisionId:'rev-1',
    feishuRecordBlockId:'block-1',
    feishuRecordedAt:'2026-08-17T10:05:00.000Z',
    feishuOperationId:'op-1'
  });
  assert.equal(Object.hasOwn(first,'name'),false);
  assert.equal(Object.hasOwn(first,'summary'),false);
  assert.equal(Object.hasOwn(first,'blocker'),false);
  assert.equal(Object.hasOwn(first,'workingMemory'),false);

  f.state.projects[0].progress.lastActivity='2026-08-17T12:00:00.000Z';
  f.state.projects[0].progress.feishuRevisionId='rev-2';
  const second=await f.manager.openProject('prj_1');
  assert.equal(second.id,first.id);
  assert.equal(second.createdAt,first.createdAt);
  assert.equal(second.cursor.lastActivity,'2026-08-17T10:00:00.000Z');
  assert.equal(second.cursor.feishuRevisionId,'rev-1');

  const checkpointed=await f.manager.checkpoint(second.id,{
    lastActivity:'2026-08-17T12:00:00.000Z',
    feishuRevisionId:'rev-2'
  });
  assert.equal(checkpointed.cursor.lastActivity,'2026-08-17T12:00:00.000Z');
  assert.equal(checkpointed.cursor.feishuRevisionId,'rev-2');
  assert.equal(checkpointed.cursor.syncedAt,'2026-08-17T10:05:00.000Z');
});

test('Project Session preserves Execution refs and checkpoint cursor across ordinary opens',async t=>{
  const f=await fixture(t);
  const opened=await f.manager.openProject('prj_1');
  await f.manager.attachExecution(opened.id,'ex_1');
  await f.manager.attachExecution(opened.id,'ex_1');
  await f.manager.attachExecution(opened.id,'ex_2');
  f.state.projects[0].progress.syncedAt='2026-08-17T12:30:00.000Z';

  const resumed=await f.manager.openProject('prj_1');
  assert.deepEqual(resumed.executionRefs,['ex_1','ex_2']);
  assert.equal(resumed.cursor.syncedAt,'2026-08-17T10:05:00.000Z');

  const checkpointed=await f.manager.checkpoint(resumed.id,{syncedAt:'2026-08-17T12:30:00.000Z'});
  assert.equal(checkpointed.cursor.syncedAt,'2026-08-17T12:30:00.000Z');
});

test('Project Session only advertises the Feishu Authority when a valid project binding exists',async t=>{
  const f=await fixture(t);
  f.state.projects[0].feishu='';
  const session=await f.manager.openProject('prj_1');
  assert.equal(session.authorityRefs.some(ref=>ref.authority==='feishu_project_record'),false);
});

test('Project Session refuses an unknown project instead of creating detached session state',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.manager.openProject('missing'),error=>error?.code==='PROJECT_SESSION_PROJECT_NOT_FOUND');
  assert.equal(await f.sessionStore.read('project:missing'),null);
});
