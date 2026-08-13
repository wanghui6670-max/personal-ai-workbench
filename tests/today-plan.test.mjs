import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deriveState, setToday } from '../src/domain.mjs';
import { JsonStore } from '../src/store.mjs';
import { todayIso } from '../src/utils.mjs';

function todo(id,title=id){
  return {id,title,dueDate:'2099-08-20',done:false,projectId:null,createdAt:'2026-08-12T00:00:00.000Z'};
}

function state(overrides={}){
  return {
    schemaVersion:1,inbox:[],todos:[],todayPlan:[],todayPlanDate:null,projects:[],confirmations:[],notes:[],activities:[],morningSessions:[],
    ...overrides
  };
}

function previousDate(){
  const date=new Date();
  date.setDate(date.getDate()-1);
  return todayIso(date);
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-today-plan-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app');
  const store=new JsonStore(path.join(appRoot,'data'));
  await store.ensure();
  return {appRoot,store,config:await store.readConfig()};
}

test('derived state hides a persisted plan from a different natural day',async t=>{
  const {appRoot,store,config}=await fixture(t);
  const oldDate=previousDate();
  await store.writeState(state({todos:[todo('td_old')],todayPlan:['td_old'],todayPlanDate:oldDate}));

  const persisted=await store.readState();
  const derived=deriveState(appRoot,persisted,config,false);

  assert.deepEqual(persisted.todayPlan,['td_old'],'derivation must not mutate persisted history');
  assert.equal(persisted.todayPlanDate,oldDate);
  assert.deepEqual(derived.todayPlan,[]);
  assert.deepEqual(derived.todayTodos,[]);
  assert.equal(derived.stats.today,0);
});

test('explicit add on a new day replaces stale choices and records the current date',async t=>{
  const {store}=await fixture(t);
  await store.writeState(state({
    todos:[todo('td_old'),todo('td_new')],
    todayPlan:['td_old'],
    todayPlanDate:previousDate()
  }));

  const result=await setToday({store,todoId:'td_new',add:true});
  const persisted=await store.readState();

  assert.deepEqual(result,['td_new']);
  assert.deepEqual(persisted.todayPlan,['td_new']);
  assert.equal(persisted.todayPlanDate,todayIso());
});

test('explicit remove on a new day does not carry any stale choices forward',async t=>{
  const {store}=await fixture(t);
  await store.writeState(state({
    todos:[todo('td_old'),todo('td_remove')],
    todayPlan:['td_old','td_remove'],
    todayPlanDate:previousDate()
  }));

  const result=await setToday({store,todoId:'td_remove',add:false});
  const persisted=await store.readState();

  assert.deepEqual(result,[]);
  assert.deepEqual(persisted.todayPlan,[]);
  assert.equal(persisted.todayPlanDate,todayIso());
});

test('same-day add and remove retain the other explicitly selected todos',async t=>{
  const {store}=await fixture(t);
  await store.writeState(state({todos:[todo('td_first'),todo('td_second')]}));

  await setToday({store,todoId:'td_first',add:true});
  await setToday({store,todoId:'td_second',add:true});
  const result=await setToday({store,todoId:'td_first',add:false});

  assert.deepEqual(result,['td_second']);
  assert.deepEqual((await store.readState()).todayPlan,['td_second']);
});

test('persistence rejects a non-empty today plan without a valid date',async t=>{
  const {store}=await fixture(t);
  const base={todos:[todo('td_dated')],todayPlan:['td_dated']};
  const missingDate=state(base);
  delete missingDate.todayPlanDate;

  await assert.rejects(
    store.writeState(missingDate),
    /todayPlan 非空时 todayPlanDate 必须是合法的 YYYY-MM-DD 日期/
  );
  await assert.rejects(
    store.writeState(state({...base,todayPlanDate:null})),
    /todayPlan 非空时 todayPlanDate 必须是合法的 YYYY-MM-DD 日期/
  );
  await assert.rejects(
    store.writeState(state({...base,todayPlanDate:'2026-02-30'})),
    /todayPlan 非空时 todayPlanDate 必须是合法的 YYYY-MM-DD 日期/
  );
  assert.deepEqual((await store.readState()).todayPlan,[]);
});

test('legacy undated todayPlan migrates conservatively and is persisted as empty',async t=>{
  const {store}=await fixture(t);
  const legacy=state({todos:[todo('td_legacy')],todayPlan:['td_legacy']});
  delete legacy.todayPlanDate;
  await fsp.writeFile(store.stateFile,JSON.stringify(legacy,null,2),{encoding:'utf8',mode:0o600});

  await store.ensure();
  const persisted=JSON.parse(await fsp.readFile(store.stateFile,'utf8'));

  assert.equal(persisted.todos.some(item=>item.id==='td_legacy'),true);
  assert.deepEqual(persisted.todayPlan,[],'an unknown historic date must never be treated as today');
  assert.equal(persisted.todayPlanDate,null);
  assert.deepEqual(await store.readState(),persisted);
});
