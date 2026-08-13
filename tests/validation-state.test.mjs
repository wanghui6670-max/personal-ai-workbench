import test from 'node:test';
import assert from 'node:assert/strict';
import { validateState, validateStateConfigReferences, validateStateInput } from '../src/validation.mjs';

function emptyState(overrides={}){
  return {
    schemaVersion:1,inbox:[],todos:[],todayPlan:[],todayPlanDate:null,projects:[],confirmations:[],notes:[],activities:[],morningSessions:[],
    ...overrides
  };
}

function entity(field,id){
  if(field==='todos')return{id,dueDate:'2026-08-20'};
  if(field==='projects')return{id,endDate:'2026-09-01'};
  return{id};
}

test('state validation rejects unknown schema versions while accepting a missing legacy version at input',()=>{
  assert.throws(()=>validateStateInput(emptyState({schemaVersion:2}),{restore:true}),/不支持 schemaVersion 2/);
  assert.doesNotThrow(()=>validateStateInput({todos:[],projects:[]},{restore:true}));
});

test('state entity arrays contain objects with unique non-empty IDs',()=>{
  for(const field of ['inbox','todos','projects','confirmations','notes','morningSessions']){
    assert.throws(()=>validateState(emptyState({[field]:[entity(field,'same'),entity(field,'same')]})),new RegExp(`${field}\\[1\\]\\.id 不能重复`));
    assert.throws(()=>validateState(emptyState({[field]:[entity(field,' ')]})),new RegExp(`${field}\\[0\\]\\.id 必须是非空字符串`));
  }
  for(const field of ['inbox','todos','projects','confirmations','notes','activities','morningSessions']){
    assert.throws(()=>validateState(emptyState({[field]:[null]})),new RegExp(`${field}\\[0\\] 必须是对象`));
  }
});

test('all persisted and reference IDs use the bounded safe grammar',()=>{
  const dangerousIds=['in_\" onclick=\"alert(1)','../escape','-leading','a'.repeat(129),'safe.id'];
  for(const id of dangerousIds){
    assert.throws(()=>validateState(emptyState({inbox:[{id}]})),/安全 ID/);
  }
  assert.doesNotThrow(()=>validateState(emptyState({inbox:[{id:'in_m3k_test-01'}]})));
  assert.throws(()=>validateState(emptyState({
    projects:[{id:'p_ok',endDate:'2026-09-01',sourceInboxId:'../escape'}]
  })),/sourceInboxId 必须是 .*安全 ID/);
  assert.throws(()=>validateState(emptyState({
    projects:[{id:'p_ok',endDate:'2026-09-01'}],
    activities:[{projectId:'p_ok\" data-action=\"delete'}]
  })),/activities\[0\]\.projectId 必须是 .*安全 ID/);
});

test('restored display entities reject attribute injection and wrong primitive types',()=>{
  assert.throws(()=>validateState(emptyState({
    projects:[{id:'p_progress',endDate:'2026-09-01',progress:{percent:'0\" data-action=\"delete'}}]
  })),/progress\.percent 必须是 0-100 的整数/);
  assert.throws(()=>validateState(emptyState({
    projects:[{id:'p_progress',endDate:'2026-09-01',progress:{percent:101}}]
  })),/progress\.percent 必须是 0-100 的整数/);
  assert.throws(()=>validateState(emptyState({
    projects:[{id:'p_folder',endDate:'2026-09-01',businessId:'biz_ok',folder:'../escape'}]
  })),/folder 必须是单层目录名/);
  assert.throws(()=>validateState(emptyState({todos:[{id:'td_bad',dueDate:'2026-08-20',done:'false'}]})),/done 必须是布尔值/);
  assert.throws(()=>validateState(emptyState({morningSessions:[{id:'ms_bad',messages:'not-an-array'}]})),/messages 必须是数组/);
  assert.doesNotThrow(()=>validateState(emptyState({
    projects:[{id:'p_legacy',endDate:'2026-09-01',progress:{percent:42,status:'进行中'}}],
    todos:[{id:'td_legacy',dueDate:'2026-08-20'}],
    morningSessions:[{id:'ms_legacy'}]
  })));
});

test('state validation enforces project and source ID types and todo project references',()=>{
  assert.throws(()=>validateState(emptyState({
    todos:[{id:'td_dangling',dueDate:'2026-08-20',projectId:'p_missing'}]
  })),/projectId 引用了不存在的项目/);
  assert.throws(()=>validateState(emptyState({
    projects:[{id:'p_bad_source',endDate:'2026-09-01',sourceInboxId:null}]
  })),/sourceInboxId 必须是非空字符串/);
  assert.throws(()=>validateState(emptyState({
    projects:[{id:'p_bad_business',endDate:'2026-09-01',businessId:42}]
  })),/businessId 必须是非空字符串/);
  assert.doesNotThrow(()=>validateState(emptyState({
    projects:[{id:'p_ok',endDate:'2026-09-01'}],
    todos:[{id:'td_ok',dueDate:'2026-08-20',projectId:'p_ok'},{id:'td_legacy',dueDate:'2026-08-21'}]
  })));
});

test('paired restore validation rejects projects assigned to absent businesses',()=>{
  const config={businesses:[{id:'biz_ok',name:'现有业务',folder:'01_现有业务'}]};
  assert.throws(()=>validateStateConfigReferences(emptyState({
    projects:[{id:'p_bad',endDate:'2026-09-01',businessId:'biz_missing'}]
  }),config),/businessId 引用了不存在的业务板块/);
  assert.doesNotThrow(()=>validateStateConfigReferences(emptyState({
    projects:[
      {id:'p_ok',endDate:'2026-09-01',businessId:'biz_ok'},
      {id:'p_unclassified',endDate:'2026-09-02',businessId:null},
      {id:'p_legacy',endDate:'2026-09-03'}
    ]
  }),config));
  assert.throws(()=>validateStateConfigReferences(emptyState(),{
    businesses:[{id:'biz_\" onclick=\"alert',name:'危险业务',folder:'01_危险业务'}]
  }),/businesses\[0\]\.id 必须是 .*安全 ID/);
});
