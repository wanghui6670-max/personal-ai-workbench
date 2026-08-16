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

test('MCP exposes GetNote v2 pipeline, explicit timezone, optional Feishu sink, and retires Feishu inbox source',async t=>{
  const {registry}=await fixture(t);
  const tools=registry.list();
  const names=tools.map(tool=>tool.name);
  assert.equal(names.includes('external_task_integration_read'),true);
  assert.equal(names.includes('external_task_integration_update'),true);
  assert.equal(names.includes('external_tasks_sync'),true);
  assert.equal(names.includes('daily_summary_publish'),true);
  assert.equal(names.includes('feishu_inbox_sync'),false);

  const update=tools.find(tool=>tool.name==='external_task_integration_update');
  assert.ok(update);
  assert.equal(update.inputSchema.properties.timeZone.type,'string');
  assert.equal(update.inputSchema.properties.journalDocumentUrl.type,'string');
  assert.match(update.description,/可选飞书日记 sink/);

  const sync=tools.find(tool=>tool.name==='external_tasks_sync');
  assert.match(sync.description,/先原子提交 Workbench/);
  assert.match(sync.description,/旧笔记/);
  assert.match(sync.description,/不自动加入 Today/);

  const current=await registry.call('external_task_integration_read',{});
  assert.equal(current.result.enabled,false);
  assert.equal(current.result.provider,'getnote_cli');
  assert.equal(current.result.timeZone,'Asia/Shanghai');

  await assert.rejects(
    registry.call('external_task_integration_update',{enabled:false,noteLimit:100,timeZone:'Asia/Shanghai'}),
    error=>error.code==='MCP_CONFIRMATION_REQUIRED'
  );
});

test('confirmed MCP update accepts timezone without requiring Feishu journal URL',async t=>{
  const {registry}=await fixture(t);
  const updated=await registry.call('external_task_integration_update',{
    enabled:false,noteLimit:120,timeZone:'Asia/Shanghai',journalDocumentUrl:'',calendarEnabled:false,calendarName:'工作台'
  },{confirmed:true});
  assert.equal(updated.result.noteLimit,120);
  assert.equal(updated.result.timeZone,'Asia/Shanghai');
  assert.equal(updated.result.journalDocumentUrl,'');
  assert.equal(updated.result.calendarEnabled,false);
});

test('local planner maps explicit GetNote sync and daily summary commands without auto-executing',async t=>{
  const {registry}=await fixture(t);
  const sync=await registry.plan('同步得到大脑待办');
  assert.equal(sync.toolName,'external_tasks_sync');
  assert.equal(sync.confirmationRequired,true);
  assert.match(sync.reason,/先提交 Workbench/);

  const alias=await registry.plan('从 Get笔记 拉取会议待办');
  assert.equal(alias.toolName,'external_tasks_sync');

  const settings=await registry.plan('设置得到大脑任务时区');
  assert.equal(settings.toolName,'panel_navigate');
  assert.match(settings.reason,/任务时区/);

  const summary=await registry.plan('把今日总结沉淀到飞书日记');
  assert.equal(summary.toolName,'daily_summary_publish');
  assert.equal(summary.confirmationRequired,true);

  const legacy=await registry.plan('同步飞书收件箱');
  assert.equal(legacy.kind,'clarification');
  assert.match(legacy.message,/待办事实来源是得到大脑只读管线/);
});
