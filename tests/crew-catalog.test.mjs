import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCrewCatalog } from '../src/crew-catalog.mjs';

test('crew catalog 返回员工与技能目录结构', async () => {
  const catalog = createCrewCatalog();
  const data = await catalog.catalog();
  assert.ok(data.scannedAt, 'scannedAt 存在');
  assert.ok(Array.isArray(data.agents), 'agents 是数组');
  assert.ok(Array.isArray(data.skills), 'skills 是数组');
  assert.ok(data.counts.agents >= 0, 'counts.agents 存在');
  assert.ok(data.counts.totalSkills >= 0, 'counts.totalSkills 存在');
  assert.ok(data.harness && typeof data.harness.web === 'object', 'harness.web 存在');
  // 员工字段
  for (const agent of data.agents) {
    assert.ok(agent.name && typeof agent.name === 'string', '员工 name');
    assert.ok(typeof agent.path === 'string', '员工 path');
  }
  // 技能字段
  for (const skill of data.skills) {
    assert.ok(['codex', 'hermes', 'harness'].includes(skill.source), `skill.source=${skill.source}`);
    assert.ok(skill.name, 'skill name');
    assert.ok(skill.path, 'skill path');
  }
});

test('crew catalog 缓存生效', async () => {
  const catalog = createCrewCatalog();
  const first = await catalog.catalog();
  const second = await catalog.catalog();
  assert.equal(first.scannedAt, second.scannedAt, '60s 内命中缓存');
});

test('crew catalog 只扫描注入的 home 并使用注入的底座探测',async t=>{
  const homeDir=await fsp.mkdtemp(path.join(os.tmpdir(),'crew-catalog-home-'));
  t.after(()=>fsp.rm(homeDir,{recursive:true,force:true}));
  const agentDir=path.join(homeDir,'.codex','agents');
  const skillDir=path.join(homeDir,'.codex','skills','fixture-skill');
  await fsp.mkdir(agentDir,{recursive:true});
  await fsp.mkdir(skillDir,{recursive:true});
  await fsp.writeFile(path.join(agentDir,'fixture.toml'),[
    'name = "Fixture Agent"',
    'description = "只存在于测试 HOME"',
    'sandbox_mode = "read-only"'
  ].join('\n'));
  await fsp.writeFile(path.join(agentDir,'demo;printf injected.toml'),[
    'name = "Unsafe Agent"',
    'description = "文件名不能进入 Shell 命令"',
    'sandbox_mode = "read-only"'
  ].join('\n'));
  await fsp.writeFile(path.join(skillDir,'SKILL.md'),[
    '---',
    'name: fixture-skill',
    'description: 只存在于测试 HOME',
    '---'
  ].join('\n'));

  const catalog=createCrewCatalog({
    homeDir,
    probe:async()=>false,
    harnessVersion:'test-version'
  });
  const data=await catalog.catalog();
  assert.deepEqual(data.agents.map(agent=>agent.id),['fixture']);
  assert.deepEqual(data.skills.map(skill=>skill.id),['codex:fixture-skill']);
  assert.equal(data.harness.web.alive,false);
  assert.equal(data.harness.version,'test-version');
});
