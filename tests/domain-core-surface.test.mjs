import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.');

test('domain-core is only a compatibility shim to the safe workbench core',async()=>{
  const core=await fsp.readFile(path.join(root,'src','domain-core.mjs'),'utf8');
  assert.match(core,/export \* from '\.\/workbench-core\.mjs'/);
  assert.doesNotMatch(core,/function syncProject|function createProject|function updateProject|writeProjectMd|prepareProjectDir|analyzeProject/);
});

test('workbench-core contains no project creation, classification, update or sync implementation',async()=>{
  const core=await fsp.readFile(path.join(root,'src','workbench-core.mjs'),'utf8');
  assert.doesNotMatch(core,/export async function (?:createProject|assignProjectBusiness|updateProject|syncProject|syncAllProjects)/);
  assert.doesNotMatch(core,/writeProjectMd|prepareProjectDir|prepareNewProjectDir|analyzeProject/);
});
