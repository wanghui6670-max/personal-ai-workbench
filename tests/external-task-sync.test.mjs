import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncExternalTasks, publishDailySummary, updateExternalTaskIntegration } from '../src/task-sync-domain.mjs';

function baseState(){return{schemaVersion:1,inbox:[],inboxAcks:[],todos:[{id:'td-old',title:'旧任务',context:'',dueDate:'2026-08-12',done:false,projectId:null,createdAt:'2026-08-10T00:00:00Z',source:'dida_cli',externalId:'done-1'}],todayPlan:['td-old'],todayPlanDate:'2026-08-14',projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]};}
function baseConfig(){return{workspaceRoot:'./workspace',port:4173,businesses:[{id:'b',name:'业务',folder:'01_业务'}],settings:{recentDays:3,dueSoonDays:3},dataSource:{provider:'feishu_doc',documentUrl:'https://example.feishu.cn/wiki/legacy'}};}
class FakeStore{
  constructor(root){this.dataDir=root;this.state=baseState();this.config=baseConfig();}
  async readState(){return structuredClone(this.state);}
  async readConfig(){return structuredClone(this.config);}
  async updateState(mutator){return mutator(this.state);}
  async updateConfig(mutator){return mutator(this.config);}
}

test('external task sync is source -> Feishu readback -> local calendar -> state, without auto-scheduling Today',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-external-sync-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new FakeStore(root);
  await updateExternalTaskIntegration({store,patch:{enabled:true,cliFlavor:'ticktick',journalDocumentUrl:'https://example.feishu.cn/wiki/journal',calendarEnabled:true,calendarName:'工作台'}});
  assert.equal(store.config.dataSource,null,'legacy Feishu inbox source is disabled');
  const order=[];
  const source={
    cliFlavor:'ticktick',fetchedAt:'2026-08-14T00:00:00Z',completedAvailable:true,completedWarning:null,
    active:[
      {externalId:'active-1',title:'正式待办',content:'来自滴答',dueDate:'2026-08-20',dueAt:'2026-08-20',startAt:null,done:false,tags:[]},
      {externalId:'undated-1',title:'没有截止日期',content:'需要用户决定',dueDate:null,dueAt:null,startAt:null,done:false,tags:[]}
    ],
    completed:[{externalId:'done-1',title:'旧任务',done:true,completedAt:'2026-08-14T08:00:00Z'}]
  };
  const taskClient={fetch:async()=>{order.push('source');return source;}};
  const journalClient={appendTasks:async()=>{order.push('feishu');return{item:{blockId:'journal-block'},replayed:false};}};
  const calendarWriter=async()=>{order.push('calendar');return{enabled:true,path:path.join(root,'calendar.ics'),eventCount:1,writtenAt:'2026-08-14T01:00:00Z'};};
  const result=await syncExternalTasks({store,taskClient,journalClient,calendarWriter});
  assert.deepEqual(order,['source','feishu','calendar']);
  assert.equal(result.activeCount,2);
  assert.equal(store.state.todos.some(todo=>todo.externalId==='active-1'&&!todo.done),true);
  assert.equal(store.state.inbox.some(item=>item.externalTaskId==='undated-1'),true);
  assert.equal(store.state.todos.find(todo=>todo.externalId==='done-1').done,true);
  assert.deepEqual(store.state.todayPlan,[]);
  assert.equal(store.state.todayPlan.includes(store.state.todos.find(todo=>todo.externalId==='active-1').id),false);
});

test('daily summary writes narrative to Feishu and keeps only an audit event locally',async()=>{
  const store=new FakeStore('/tmp/fake');
  await updateExternalTaskIntegration({store,patch:{enabled:true,journalDocumentUrl:'https://example.feishu.cn/wiki/journal'}});
  let captured='';
  const result=await publishDailySummary({store,date:'2026-08-14',notes:'今天确认了供应商。',journalClient:{appendSummary:async(url,text)=>{captured=text;return{item:{blockId:'summary-block'},replayed:false};}}});
  assert.equal(result.blockId,'summary-block');
  assert.match(captured,/今天确认了供应商/);
  assert.equal(store.state.activities[0].type,'daily_summary_published');
  assert.doesNotMatch(store.state.activities[0].text,/供应商/);
});
