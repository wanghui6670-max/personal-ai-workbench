import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setToday } from '../src/domain.mjs';
import { createWorkbenchRegistry } from '../src/mcp/registry.mjs';
import { JsonStore } from '../src/store.mjs';

const completed={id:'td_done',title:'提交已经完成的报告',dueDate:'2099-08-20',done:true,projectId:null,createdAt:'2026-08-13T00:00:00.000Z'};
const baseState=()=>({schemaVersion:1,inbox:[],inboxAcks:[],todos:[completed],todayPlan:[],todayPlanDate:null,projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]});

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-completed-today-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  await store.writeState(baseState());
  return {root,store};
}

test('domain rejects a completed todo without mutating today state',async t=>{
  const {store}=await fixture(t);
  await assert.rejects(setToday({store,todoId:completed.id,add:true}),error=>error.statusCode===409&&error.code==='TODO_ALREADY_COMPLETED');
  const state=await store.readState();
  assert.deepEqual(state.todayPlan,[]);
  assert.equal(state.todayPlanDate,null);
  assert.equal(state.activities.length,0);
});

test('AI/MCP planning does not preview a completed todo for today',async t=>{
  const {root,store}=await fixture(t);
  const previousKey=process.env.OPENAI_API_KEY;
  const previousProvider=process.env.AI_PROVIDER_ENABLED;
  delete process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER_ENABLED='0';
  try{
    const registry=createWorkbenchRegistry({appRoot:root,store});
    const plan=await registry.plan('把提交已经完成的报告加入今日');
    assert.equal(plan.kind,'clarification');
    assert.equal(plan.toolName??null,null);
    assert.match(plan.message,/已经完成.*不能加入今日/);
    await assert.rejects(registry.call('todo_today',{todoId:completed.id,add:true},{confirmed:true}),error=>error.statusCode===409&&error.code==='TODO_ALREADY_COMPLETED');
  }finally{
    if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;
    if(previousProvider===undefined)delete process.env.AI_PROVIDER_ENABLED;else process.env.AI_PROVIDER_ENABLED=previousProvider;
  }
});
