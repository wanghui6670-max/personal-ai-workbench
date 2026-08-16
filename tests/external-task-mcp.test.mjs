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

test('MCP exposes Feishu inbox and GetNote self-media content, not legacy GetNote task tools',async t=>{
  const {registry}=await fixture(t);
  const tools=registry.list();
  const names=tools.map(tool=>tool.name);

  assert.equal(names.includes('feishu_inbox_sync'),true,'Feishu inbox is the primary personal intake surface');
  assert.equal(names.includes('getnote_content_status'),true);
  assert.equal(names.includes('getnote_content_sync'),true);

  for(const retired of ['external_task_integration_read','external_task_integration_update','external_tasks_sync','daily_summary_publish']){
    assert.equal(names.includes(retired),false,`${retired} must stay out of the interactive AI/MCP surface`);
  }

  const feishu=tools.find(tool=>tool.name==='feishu_inbox_sync');
  assert.equal(feishu.requiresConfirmation,true);
  const content=tools.find(tool=>tool.name==='getnote_content_sync');
  assert.equal(content.requiresConfirmation,true);
  assert.match(content.description,/不会创建待办/);
  assert.match(content.description,/不会加入 Today/);

  await assert.rejects(
    registry.call('getnote_content_sync',{limit:50}),
    error=>error.code==='MCP_CONFIRMATION_REQUIRED'
  );
  await assert.rejects(
    registry.call('external_tasks_sync',{}, {confirmed:true}),
    error=>error.code==='MCP_TOOL_NOT_FOUND'
  );
});

test('local planner makes Feishu primary and routes GetNote only to self-media content',async t=>{
  const {registry}=await fixture(t);

  const feishu=await registry.plan('同步飞书收件箱');
  assert.equal(feishu.toolName,'feishu_inbox_sync');
  assert.equal(feishu.confirmationRequired,true);
  assert.match(feishu.reason,/飞书收件箱/);

  const content=await registry.plan('同步得到大脑内容到自媒体，最近 20 篇');
  assert.equal(content.toolName,'getnote_content_sync');
  assert.equal(content.args.limit,20);
  assert.equal(content.confirmationRequired,true);
  assert.match(content.reason,/自媒体/);

  const status=await registry.plan('查看得到大脑内容同步到哪里');
  assert.equal(status.toolName,'getnote_content_status');
  assert.equal(status.confirmationRequired,false);

  const retired=await registry.plan('同步得到大脑待办');
  assert.equal(retired.kind,'clarification');
  assert.equal(retired.toolName,null);
  assert.match(retired.message,/只用于“自媒体”内容采集/);
  assert.match(retired.message,/飞书收件箱/);
});
