import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectSessionStore} from '../src/harness-core/project-session-store.mjs';

async function tempDataDir(t){
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-hydration-cursor-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  return dir;
}

test('Project Session cursor accepts workspace activity and Git HEAD machine pointers only',async t=>{
  const dataDir=await tempDataDir(t);
  const store=new ProjectSessionStore({dataDir});
  const record={
    version:1,
    id:'project:prj_1',
    type:'project',
    projectId:'prj_1',
    status:'open',
    authorityRefs:[
      {authority:'workbench',kind:'project',refId:'prj_1'},
      {authority:'local_workspace',kind:'project',refId:'prj_1'},
      {authority:'git',kind:'project',refId:'prj_1'}
    ],
    cursor:{
      lastActivity:null,
      syncedAt:null,
      feishuRevisionId:null,
      feishuRecordBlockId:null,
      feishuRecordedAt:null,
      feishuOperationId:null,
      workspaceLastActivity:'2026-08-17T12:00:00.000Z',
      gitHead:'0123456789abcdef0123456789abcdef01234567'
    },
    executionRefs:[],
    createdAt:'2026-08-17T12:00:00.000Z',
    updatedAt:'2026-08-17T12:00:00.000Z'
  };

  await store.write(record);
  const restored=await store.read(record.id);
  assert.equal(restored.cursor.workspaceLastActivity,'2026-08-17T12:00:00.000Z');
  assert.equal(restored.cursor.gitHead,'0123456789abcdef0123456789abcdef01234567');
});

test('Hydration cursor still rejects narrative or content-bearing pseudo-cursors',async t=>{
  const dataDir=await tempDataDir(t);
  const store=new ProjectSessionStore({dataDir});
  const base={
    version:1,id:'project:prj_1',type:'project',projectId:'prj_1',status:'open',
    authorityRefs:[{authority:'workbench',kind:'project',refId:'prj_1'}],
    cursor:{
      lastActivity:null,syncedAt:null,feishuRevisionId:null,feishuRecordBlockId:null,
      feishuRecordedAt:null,feishuOperationId:null,workspaceLastActivity:null,gitHead:null
    },
    executionRefs:[],createdAt:'2026-08-17T12:00:00.000Z',updatedAt:'2026-08-17T12:00:00.000Z'
  };

  for(const [field,value] of [
    ['gitHistory','commit messages'],
    ['workspaceFiles',['secret.md']],
    ['feishuText','项目正文'],
    ['summary','恢复摘要']
  ]){
    await assert.rejects(()=>store.write({...base,cursor:{...base.cursor,[field]:value}}),error=>error?.code==='PROJECT_SESSION_UNSAFE_FIELD');
  }
});
