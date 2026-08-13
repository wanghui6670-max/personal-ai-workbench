import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.');

test('domain-core explicitly exposes safe workbench and hash-only inbox functions',async()=>{
  const core=await fsp.readFile(path.join(root,'src','domain-core.mjs'),'utf8');
  assert.match(core,/from '\.\/workbench-core\.mjs'/);
  assert.match(core,/export \{ syncFeishuInbox, addInbox \} from '\.\/inbox-domain\.mjs'/);
  assert.doesNotMatch(core,/export \* from/);
  assert.doesNotMatch(core,/function syncProject|function createProject|function updateProject|writeProjectMd|prepareProjectDir|analyzeProject/);
});

test('workbench-core contains no project creation, classification, update or sync implementation',async()=>{
  const core=await fsp.readFile(path.join(root,'src','workbench-core.mjs'),'utf8');
  assert.doesNotMatch(core,/export async function (?:createProject|assignProjectBusiness|updateProject|syncProject|syncAllProjects)/);
  assert.doesNotMatch(core,/writeProjectMd|prepareProjectDir|prepareNewProjectDir|analyzeProject/);
});

test('production inbox surface uses content hashes and never persists ack plaintext',async()=>{
  const inbox=await fsp.readFile(path.join(root,'src','inbox-domain.mjs'),'utf8');
  assert.match(inbox,/inboxContentHash/);
  assert.match(inbox,/inboxAckMatches/);
  assert.doesNotMatch(inbox,/inboxAcks\.push\(\{blockId:[^}]*text:/);
});
