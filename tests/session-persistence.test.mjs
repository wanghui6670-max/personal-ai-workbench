import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { createSessionManager } from '../platform/runtime/session-manager.mjs';
import { createJsonFileSessionStore } from '../platform/persistence/json-file-session-store.mjs';

test('session survives manager restart through persistence adapter', async () => {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-session-'));
  const file=path.join(dir,'sessions.json');
  try{
    const store1=createJsonFileSessionStore({file});
    const manager1=createSessionManager({store:store1});
    await manager1.create({id:'project:demo',scope:'project',goal:'durable work'});
    await manager1.appendEvent('project:demo',{type:'decision',data:{summary:'keep context'}});
    await manager1.checkpoint('project:demo',{summary:'checkpoint-1'});

    const store2=createJsonFileSessionStore({file});
    const manager2=createSessionManager({store:store2});
    const resumed=await manager2.resume('project:demo');
    assert.equal(resumed.goal,'durable work');
    assert.equal(resumed.events.length,1);
    assert.equal(resumed.checkpoints.length,1);
  } finally {
    await fsp.rm(dir,{recursive:true,force:true});
  }
});

test('session file store serializes concurrent updates and writes atomically', async () => {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-session-'));
  const file=path.join(dir,'sessions.json');
  try{
    const store=createJsonFileSessionStore({file});
    const manager=createSessionManager({store});
    await manager.create({id:'daily',scope:'daily',goal:'today'});
    await Promise.all(Array.from({length:10},(_,index)=>manager.appendEvent('daily',{type:'note',data:{index}})));
    const resumed=await manager.resume('daily');
    assert.equal(resumed.events.length,10);
    const parsed=JSON.parse(await fsp.readFile(file,'utf8'));
    assert.ok(parsed.sessions.daily);
  } finally {
    await fsp.rm(dir,{recursive:true,force:true});
  }
});
