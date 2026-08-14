import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { createWorkbenchRegistry } from '../src/mcp/registry.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-external-mcp-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return{root,store,registry:createWorkbenchRegistry({appRoot:root,store})};
}

test('MCP exposes the GetNote pipeline and retires Feishu as an inbox source',async t=>{
  const {registry}=await fixture(t);
  const names=registry.list().map(tool=>tool.name);
  assert.equal(names.includes('external_task_integration_read'),true);
  assert.equal(names.includes('external_task_integration_update'),true);
  assert.equal(names.includes('external_tasks_sync'),true);
  assert.equal(names.includes('daily_summary_publish'),true);
  assert.equal(names.includes('feishu_inbox_sync'),false);
  const current=await registry.call('external_task_integration_read',{});
  assert.equal(current.result.enabled,false);
  assert.equal(current.result.provider,'getnote_cli');
  await assert.rejects(
    registry.call('external_task_integration_update',{enabled:false,noteLimit:100}),
    error=>error.code==='MCP_CONFIRMATION_REQUIRED'
  );
});

test('local planner maps explicit GetNote sync and daily summary commands without auto-executing',async t=>{
  const {registry}=await fixture(t);
  const sync=await registry.plan('同步得到大脑待办');
  assert.equal(sync.toolName,'external_tasks_sync');
  assert.equal(sync.confirmationRequired,true);
  const alias=await registry.plan('从 Get笔记 拉取会议待办');
  assert.equal(alias.toolName,'external_tasks_sync');
  const summary=await registry.plan('把今日总结沉淀到飞书日记');
  assert.equal(summary.toolName,'daily_summary_publish');
  assert.equal(summary.confirmationRequired,true);
  const legacy=await registry.plan('同步飞书收件箱');
  assert.equal(legacy.kind,'clarification');
  assert.match(legacy.message,/待办来源是得到大脑 CLI/);
});
