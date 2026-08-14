import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncExternalTasks, publishDailySummary, updateExternalTaskIntegration } from '../src/task-sync-domain.mjs';

function baseState(){return{
  schemaVersion:1,inbox:[{id:'in-wrong',text:'误导入',source:'dida_cli',createdAt:'2026-08-10T00:00:00Z'}],inboxAcks:[],
  todos:[
    {id:'td-wrong',title:'误接入滴答任务',context:'',dueDate:'2026-08-12',done:false,projectId:null,createdAt:'2026-08-10T00:00:00Z',source:'dida_cli',externalId:'wrong-1'},
    {id:'td-old',title:'旧的得到大脑任务',context:'',dueDate:'2026-08-12',done:false,projectId:null,createdAt:'2026-08-10T00:00:00Z',source:'getnote_cli',externalId:'done-1'}
  ],
  todayPlan:['td-wrong','td-old'],todayPlanDate:'2026-08-14',projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]
};}
function baseConfig(){return{workspaceRoot:'./workspace',port:4173,businesses:[{id:'b',name:'业务',folder:'01_业务'}],settings:{recentDays:3,dueSoonDays:3,externalTaskPipeline:{enabled:true,provider:'dida_cli',cliFlavor:'dida365'}},dataSource:{provider:'feishu_doc',documentUrl:'https://example.feishu.cn/wiki/legacy'}};}
class FakeStore{
  constructor(root){this.dataDir=root;this.state=baseState();this.config=baseConfig();}
  async readState(){return structuredClone(this.state);}
  async readConfig(){return structuredClone(this.config);}
  async updateState(mutator){return mutator(this.state);}
  async updateConfig(mutator){return mutator(this.config);}
}

function taskSource(active){
  return{
    provider:'getnote_cli',noteCount:2,todoCount:3,fetchedAt:'2026-08-14T00:00:00Z',completedAvailable:true,completedWarning:null,
    active,
    completed:[{externalId:'done-1',title:'旧的得到大脑任务',done:true,completedAt:'2026-08-14T08:00:00Z',sourceNoteTitle:'复盘会'}]
  };
}

const activeTasks=[
  {externalId:'active-1',title:'2026-08-20 提交方案',content:'',dueDate:'2026-08-20',dueAt:'2026-08-20',startAt:null,updatedAt:'2026-08-14T00:00:00Z',done:false,tags:[],sourceNoteId:'n1',sourceNoteTitle:'产品周会',sourceNoteUrl:'https://www.biji.com/note/n1',todoSource:'summary'},
  {externalId:'undated-1',title:'确认下一版预算',content:'',dueDate:null,dueAt:null,startAt:null,updatedAt:'2026-08-14T00:00:00Z',done:false,tags:[],sourceNoteId:'n2',sourceNoteTitle:'预算会',sourceNoteUrl:'https://www.biji.com/note/n2',todoSource:'summary'}
];

test('GetNote sync is source -> Feishu readback -> local calendar -> state, without auto-scheduling Today',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-external-sync-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new FakeStore(root);
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,journalDocumentUrl:'https://example.feishu.cn/wiki/journal',calendarEnabled:true,calendarName:'工作台'}});
  assert.equal(store.config.dataSource,null,'legacy Feishu inbox source is disabled');
  assert.equal(store.state.todos.some(todo=>todo.source==='dida_cli'),false,'wrong Dida imports are removed after confirmed correction');
  assert.equal(store.state.inbox.some(item=>item.source==='dida_cli'),false);
  const order=[];
  const source=taskSource(activeTasks);
  const taskClient={fetch:async()=>{order.push('source');return source;}};
  const journalClient={appendTasks:async()=>{order.push('feishu');return{item:{blockId:'journal-block'},replayed:false};}};
  const calendarWriter=async()=>{order.push('calendar');return{enabled:true,path:path.join(root,'calendar.ics'),eventCount:1,writtenAt:'2026-08-14T01:00:00Z'};};
  const result=await syncExternalTasks({store,taskClient,journalClient,calendarWriter});
  assert.deepEqual(order,['source','feishu','calendar']);
  assert.equal(result.noteCount,2);
  assert.equal(result.todoCount,3);
  assert.equal(store.state.todos.some(todo=>todo.externalId==='active-1'&&!todo.done&&todo.source==='getnote_cli'),true);
  assert.equal(store.state.inbox.some(item=>item.externalTaskId==='undated-1'&&item.sourceNoteId==='n2'),true);
  assert.equal(store.state.todos.find(todo=>todo.externalId==='done-1').done,true);
  assert.deepEqual(store.state.todayPlan,[]);
  assert.equal(store.state.todayPlan.includes(store.state.todos.find(todo=>todo.externalId==='active-1').id),false);
});

test('task snapshot operationId follows persisted text, not CLI order or hidden timestamps',async()=>{
  const store=new FakeStore('/tmp/fake-order');
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,journalDocumentUrl:'https://example.feishu.cn/wiki/journal',calendarEnabled:false}});
  const operations=[];
  const texts=[];
  let changed=false;
  const taskClient={fetch:async()=>{
    const tasks=(changed?[...activeTasks].reverse():activeTasks).map(task=>({...task,updatedAt:changed?'2026-08-14T05:00:00Z':task.updatedAt}));
    return taskSource(tasks);
  }};
  const journalClient={appendTasks:async(url,text,options)=>{
    operations.push(options.operationId);texts.push(text);
    return{item:{blockId:`b-${operations.length}`},replayed:operations.length>1};
  }};
  await syncExternalTasks({store,taskClient,journalClient});
  changed=true;
  await syncExternalTasks({store,taskClient,journalClient});
  assert.equal(operations.length,2);
  assert.equal(texts[0],texts[1]);
  assert.equal(operations[0],operations[1]);
});

test('daily summary writes narrative to Feishu, keeps only an audit event locally, and safely replays',async()=>{
  const store=new FakeStore('/tmp/fake-summary');
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,journalDocumentUrl:'https://example.feishu.cn/wiki/journal'}});
  const seen=new Map();
  const captured=[];
  const journalClient={appendSummary:async(url,text,options)=>{
    captured.push({text,operationId:options.operationId});
    const replayed=seen.has(options.operationId);
    seen.set(options.operationId,true);
    return{item:{blockId:'summary-block'},replayed};
  }};
  const first=await publishDailySummary({store,date:'2026-08-14',notes:'今天确认了供应商。',journalClient});
  const second=await publishDailySummary({store,date:'2026-08-14',notes:'今天确认了供应商。',journalClient});
  assert.equal(first.blockId,'summary-block');
  assert.equal(second.replayed,true);
  assert.equal(first.operationId,second.operationId);
  assert.equal(captured[0].text,captured[1].text);
  assert.match(captured[0].text,/今天确认了供应商/);
  assert.equal(store.state.activities.filter(activity=>activity.type==='daily_summary_published').length,2);
  assert.equal(store.state.activities.some(activity=>/供应商/.test(activity.text)),false);
});
