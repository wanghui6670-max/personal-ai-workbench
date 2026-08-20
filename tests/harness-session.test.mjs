import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, createSessionManager } from '../src/harness-core/index.mjs';

test('creates a project session and refuses other types',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harness-sess-'));
  const store=createSessionStore({file:path.join(dir,'sessions.json')});
  const manager=createSessionManager({
    store,
    projectLookup:async id=>id==='p1'?{id:'p1',name:'Workbench',git:'git@x',feishu:'https://feishu.example/doc'}:null,
    authorities:{
      async readGit(project){return {head:'aaa',remote:project.git};},
      async readFeishu(project){return {documentUrl:project.feishu,updatedAt:'2026-08-17'};}
    }
  });
  const session=await manager.openProject({projectId:'p1',goal:'继续 Harness'});
  assert.equal(session.type,'project');
  assert.equal(session.projectId,'p1');
  assert.equal(typeof session.id,'string');
  await assert.rejects(
    ()=>manager.open({type:'customer',projectId:'p1'}),
    error=>error.code==='HARNESS_SESSION_TYPE_UNSUPPORTED'
  );
});

test('concurrent openProject calls share one persisted session per project',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harness-sess-race-'));
  const store=createSessionStore({file:path.join(dir,'sessions.json')});
  const manager=createSessionManager({store});
  const sessions=await Promise.all(
    Array.from({length:12},()=>manager.openProject({projectId:'p1',goal:'继续 Harness'}))
  );
  assert.equal(new Set(sessions.map(session=>session.id)).size,1);
  assert.equal(store.list().length,1);
  assert.equal(store.list()[0].projectId,'p1');
});
