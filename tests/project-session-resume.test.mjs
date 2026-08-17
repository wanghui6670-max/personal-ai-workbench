import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, createSessionManager } from '../src/harness-core/index.mjs';

test('live authority wins over checkpoint',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harness-resume-'));
  const store=createSessionStore({file:path.join(dir,'sessions.json')});
  const manager=createSessionManager({
    store,
    projectLookup:async()=>({id:'p1',name:'Workbench',git:'git@x',feishu:'https://feishu.example/doc'}),
    authorities:{
      async readGit(){return {head:'BBB'};},
      async readFeishu(project){return {documentUrl:project.feishu};}
    }
  });
  const session=await manager.openProject({projectId:'p1',goal:'继续'});
  await manager.checkpoint(session.id,{note:'停在 A',facts:{gitHead:'AAA'}});
  const context=await manager.hydrate(session.id);
  assert.equal(context.authority,'live');
  assert.equal(context.live.git.head,'BBB');
  assert.equal(context.conflicts.some(item=>item.path==='gitHead'&&item.checkpoint==='AAA'&&item.live==='BBB'),true);
  assert.equal(JSON.stringify(context).includes('飞书项目正文'),false);
});
