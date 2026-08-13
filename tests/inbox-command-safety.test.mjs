import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/store.mjs';
import {processInbox} from '../src/domain.mjs';

const emptyState=overrides=>({schemaVersion:1,inbox:[],todos:[],todayPlan:[],todayPlanDate:null,projects:[],confirmations:[],notes:[],activities:[],morningSessions:[],...overrides});
const project=(id,name)=>({id,businessId:null,name,intro:'',createdAt:'2026-08-12',startDate:'2026-08-12',endDate:'2026-12-31',folder:'',git:'',feishu:'',completed:false,archived:false,progress:{}});

async function fixture(t,{projects=[]}={}){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-inbox-command-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));await store.ensure();
  await store.writeState(emptyState({inbox:[{id:'in_source',text:'原始素材',source:'manual',createdAt:'2026-08-12T00:00:00.000Z'}],projects}));
  return store;
}

test('negated or conflicting inbox commands fail closed without consuming the source',async t=>{
  for(const command of ['不要删除，保存为备忘','不要删除，放到客户项目作为项目记录','不要变成备忘，做独立待办，截止2026年8月20日','删除，同时做成独立待办，截止2026年8月20日']){
    await t.test(command,async t=>{
      const store=await fixture(t,{projects:[project('p_client','客户项目')]});
      let result=await processInbox({store,itemId:'in_source',command});
      assert.equal(result.needsFollowup,true);
      result=await processInbox({store,itemId:'in_source',command});
      assert.equal(result.needsFollowup,true);
      const state=await store.readState();
      assert.equal(state.inbox.length,1);assert.equal(state.todos.length,0);assert.equal(state.notes.length,0);assert.equal(state.activities.length,0);
      assert.equal(state.confirmations.filter(item=>item.type==='inbox_intent_unclear'&&item.inboxId==='in_source').length,1,'重复追问只能留下一个可见待确认');
    });
  }
});

test('an unrecognized final action creates one visible follow-up confirmation',async t=>{
  const store=await fixture(t,{projects:[project('p_client','客户项目')]});
  for(let attempt=0;attempt<2;attempt++){
    const result=await processInbox({store,itemId:'in_source',command:'帮我看一下怎么处理'});
    assert.equal(result.needsFollowup,true);
  }
  const state=await store.readState();
  assert.equal(state.inbox.length,1);assert.equal(state.todos.length,0);assert.equal(state.notes.length,0);
  assert.equal(state.confirmations.filter(item=>item.type==='inbox_intent_unclear'&&item.inboxId==='in_source').length,1);
});

test('a project memo stays in the named project instead of becoming a global memo',async t=>{
  const store=await fixture(t,{projects:[project('p_client','客户项目')]});
  const result=await processInbox({store,itemId:'in_source',command:'放到客户项目作为备忘'});
  assert.equal(result.message,'已归入「客户项目」作为项目记录。');
  const state=await store.readState();
  assert.equal(state.inbox.length,0);assert.equal(state.notes.length,1);assert.equal(state.notes[0].projectId,'p_client');
});

test('a unique four-character project prefix still requires explicit project selection',async t=>{
  const store=await fixture(t,{projects:[project('p_client','客户小程序重构'),project('p_other','其他事项')]});
  const command='放到客户小程序另外事项作为项目记录';
  let result=await processInbox({store,itemId:'in_source',command});
  assert.equal(result.needsProjectSelection,true);assert.deepEqual(result.projectCandidates.map(item=>item.id),['p_client']);
  result=await processInbox({store,itemId:'in_source',command});
  assert.equal(result.needsProjectSelection,true);
  let state=await store.readState();assert.equal(state.inbox.length,1);assert.equal(state.notes.length,0);
  assert.equal(state.confirmations.filter(item=>item.type==='inbox_project_ambiguous'&&item.inboxId==='in_source').length,1);
  await assert.rejects(processInbox({store,itemId:'in_source',command,targetProjectId:'p_other'}),error=>error.statusCode===409&&/不匹配/.test(error.message));
  state=await store.readState();assert.equal(state.inbox.length,1);assert.equal(state.notes.length,0);
  result=await processInbox({store,itemId:'in_source',command,targetProjectId:'p_client'});
  assert.equal(result.message,'已归入「客户小程序重构」作为项目记录。');
  state=await store.readState();assert.equal(state.inbox.length,0);assert.equal(state.notes[0].projectId,'p_client');assert.equal(state.confirmations.some(item=>item.inboxId==='in_source'),false);
});
