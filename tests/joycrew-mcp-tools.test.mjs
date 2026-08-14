import test from 'node:test';
import assert from 'node:assert/strict';
import { createJoycrewTools, planJoycrewMessage } from '../src/mcp/joycrew-tools.mjs';

function tools(){
  const client={
    probe:async()=>({available:true}),overview:async()=>({bootstrap:{projects:[]}}),projects:async()=>({projects:[]}),project:async id=>({project:{id}}),
    customers:async()=>({customers:[]}),tasks:async filters=>({tasks:[],filters}),approvals:async()=>({approvals:[]}),deliverables:async()=>({deliverables:[]})
  };
  const actions={list:()=>[],prepare:(type,payload,meta)=>({id:'jact_preview',type,payload,source:meta.source,status:'pending'})};
  return createJoycrewTools({client,actions});
}

test('Joycrew tools expose read and preview-only mutation surface',async()=>{
  const all=tools();
  assert.ok(all.length>=10);
  assert.ok(all.every(tool=>tool.readOnly===true&&tool.requiresConfirmation===false));
  const prepare=all.find(tool=>tool.name==='joycrew_run_prepare');
  const result=await prepare.execute({}, {projectId:'p',task:'分析项目',employeeId:'e',sources:[{kind:'records',sourceId:'s',entity:'Project',filters:[]}]});
  assert.equal(result.action.type,'run.create');
  assert.equal(result.navigation.view,'operations');
  assert.match(result.message,/未确认前/);
});

test('deterministic Joycrew planner maps common read intents only',()=>{
  assert.equal(planJoycrewMessage({message:'查看 Joycrew 状态'}).toolName,'joycrew_status_read');
  assert.equal(planJoycrewMessage({message:'打开业务执行'}).toolName,'joycrew_workspace_open');
  assert.equal(planJoycrewMessage({message:'帮我随便执行一个员工'}),null);
});
