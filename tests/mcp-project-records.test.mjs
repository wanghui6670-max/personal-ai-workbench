import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { createWorkbenchRegistry } from '../src/mcp/registry.mjs';
import { planProjectRecordMessage } from '../src/mcp/project-record-tools.mjs';

async function setup(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-mcp-records-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  await store.updateState(state=>{
    state.projects.push({
      id:'p_records',businessId:'biz_ai',name:'飞书记录项目',intro:'测试项目记录工具',folder:'feishu-records',
      createdAt:'2026-08-13',startDate:'2026-08-13',endDate:'2026-08-31',git:'',feishu:'https://example.feishu.cn/wiki/project',completed:false,archived:false,
      progress:{percent:20,status:'进行中',lastActivity:null,syncedAt:null,confidence:.8}
    });
  });
  return {root,store};
}

test('MCP registry exposes Feishu project record tools with correct confirmation boundary',async t=>{
  const {root,store}=await setup(t);
  const registry=createWorkbenchRegistry({appRoot:root,store});
  const tools=registry.list();
  const read=tools.find(tool=>tool.name==='project_records_read');
  const append=tools.find(tool=>tool.name==='project_summary_append');
  assert.equal(read?.readOnly,true);
  assert.equal(read?.requiresConfirmation,false);
  assert.equal(append?.requiresConfirmation,true);
  await assert.rejects(
    registry.call('project_summary_append',{projectId:'p_records',text:'阶段总结'}),
    error=>error.code==='MCP_CONFIRMATION_REQUIRED'
  );
});

test('local deterministic planner maps explicit project-record read intent',()=>{
  const state={projects:[{id:'p_records',name:'飞书记录项目'}]};
  const plan=planProjectRecordMessage({message:'查看飞书记录项目的分析和总结',state});
  assert.equal(plan.toolName,'project_records_read');
  assert.deepEqual(plan.args,{projectId:'p_records'});
});

test('local deterministic planner maps explicit summary append and keeps confirmation to registry',()=>{
  const state={projects:[{id:'p_records',name:'飞书记录项目'}]};
  const plan=planProjectRecordMessage({message:'给飞书记录项目追加阶段总结：已经完成需求确认，进入实现。',state});
  assert.equal(plan.toolName,'project_summary_append');
  assert.equal(plan.args.projectId,'p_records');
  assert.equal(plan.args.text,'已经完成需求确认，进入实现。');
});
