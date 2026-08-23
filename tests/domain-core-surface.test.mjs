import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.');

test('domain.mjs imports directly from workbench-core, external-task-routing, today-domain and inbox-domain',async()=>{
  const domain=await fsp.readFile(path.join(root,'src','domain.mjs'),'utf8');
  assert.match(domain,/from '\.\/workbench-core\.mjs'/);
  assert.match(domain,/from '\.\/external-task-routing\.mjs'/);
  assert.match(domain,/from '\.\/today-domain\.mjs'/);
  assert.match(domain,/from '\.\/inbox-domain\.mjs'/);
  assert.doesNotMatch(domain,/from '\.\/domain-core\.mjs'/);
  assert.doesNotMatch(domain,/export \* from/);
});

test('workbench-core contains no project creation, classification, update or sync implementation',async()=>{
  const core=await fsp.readFile(path.join(root,'src','workbench-core.mjs'),'utf8');
  assert.doesNotMatch(core,/export async function (?:createProject|assignProjectBusiness|updateProject|syncProject|syncAllProjects)/);
  assert.doesNotMatch(core,/writeProjectMd|prepareProjectDir|prepareNewProjectDir|analyzeProject/);
});

test('production inbox surface keeps hash-only permanent acknowledgements while allowing one explicit todo migration bypass',async()=>{
  const inbox=await fsp.readFile(path.join(root,'src','inbox-domain.mjs'),'utf8');
  assert.match(inbox,/inboxContentHash/);
  assert.match(inbox,/const priorAck=ackByBlock\.get\(remote\.blockId\)/);
  assert.match(inbox,/const migrationReimport=legacyTodoReimportIds\.has\(remote\.blockId\)/);
  assert.match(inbox,/if\(priorAck&&!migrationReimport\)\{/);
  assert.match(inbox,/seenSkipped\+=1/);
  assert.match(inbox,/The ACK itself is never deleted or rewritten/);
  assert.doesNotMatch(inbox,/inboxAckMatches/);
  assert.doesNotMatch(inbox,/state\.inboxAcks=state\.inboxAcks\.filter/);
  assert.doesNotMatch(inbox,/inboxAcks\.push\(\{blockId:[^}]*text:/);
});
