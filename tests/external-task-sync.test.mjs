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
    {id:'td-old',title:'旧的得到大脑任务',context:'',dueDate:'2026-08-12',done:false,projectId:null,createdAt:'2026-08-10T00:00:00Z',source:'getnote_cli',externalId:'done-1',sourceNoteId:'old-note',sourceNoteTitle:'复盘会',sourceNoteCreatedAt:'2026-06-01T00:00:00Z'}
  ],
  todayPlan:['td-wrong','td-old'],todayPlanDate:'2026-08-14',projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]
};}
function baseConfig(){return{workspaceRoot:'./workspace',port:4173,businesses:[{id:'b',name:'业务',folder:'01_业务'}],settings:{recentDays:3,dueSoonDays:3,externalTaskPipeline:{enabled:true,provider:'dida_cli',cliFlavor:'dida365'}},dataSource:{provider:'feishu_doc',documentUrl:'https://example.feishu.cn/wiki/legacy'}};}
class FakeStore{
  constructor(root){this.dataDir=root;this.state=baseState();this.config=baseConfig();this.order=[];}
  async readState(){return structuredClone(this.state);}
  async readConfig(){return structuredClone(this.config);}
  async updateState(mutator){this.order.push('state');return mutator(this.state);}
  async updateConfig(mutator){this.order.push('config');return mutator(this.config);}
}

function taskSource(active){
  return{
    provider:'getnote_cli',noteCount:3,recentNoteCount:2,trackedNoteCount:1,todoCount:3,fetchedAt:'2026-08-14T00:00:00Z',completedAvailable:true,completedWarning:null,
    active,
    completed:[{externalId:'done-1',title:'旧的得到大脑任务',done:true,completedAt:'2026-08-14T08:00:00Z',sourceNoteId:'old-note',sourceNoteTitle:'复盘会',sourceTodoId:'todo-done',identityKind:'source_id'}]
  };
}

const activeTasks=[
  {externalId:'active-1',title:'2026-08-20 提交方案',content:'',dueDate:'2026-08-20',dueAt:'2026-08-20',startAt:null,allDay:true,timeZone:'Asia/Shanghai',updatedAt:'2026-08-14T00:00:00Z',done:false,tags:[],sourceNoteId:'n1',sourceNoteTitle:'产品周会',sourceNoteCreatedAt:'2026-08-10T00:00:00Z',sourceNoteUrl:'https://www.biji.com/note/n1',sourceTodoId:'todo-active',identityKind:'source_id',todoSource:'summary'},
  {externalId:'undated-1',title:'确认下一版预算',content:'',dueDate:null,dueAt:null,startAt:null,allDay:true,timeZone:'Asia/Shanghai',updatedAt:'2026-08-14T00:00:00Z',done:false,tags:[],sourceNoteId:'n2',sourceNoteTitle:'预算会',sourceNoteCreatedAt:'2026-08-11T00:00:00Z',sourceNoteUrl:'https://www.biji.com/note/n2',sourceTodoId:'todo-undated',identityKind:'source_id',todoSource:'summary'}
];

test('GetNote core commits to Workbench before Feishu/ICS sinks and never auto-adds Today',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-external-sync-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new FakeStore(root);
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,timeZone:'Asia/Shanghai',journalDocumentUrl:'https://example.feishu.cn/wiki/journal',calendarEnabled:true,calendarName:'工作台'}});
  assert.equal(store.config.dataSource,null,'legacy Feishu inbox source is disabled');
  assert.equal(store.state.todos.some(todo=>todo.source==='dida_cli'),false,'wrong Dida imports are removed after confirmed correction');
  store.order=[];
  const source=taskSource(activeTasks);
  const taskClient={fetch:async config=>{store.order.push('source');assert.equal(config.timeZone,'Asia/Shanghai');assert.deepEqual(config.trackedNotes.map(note=>note.noteId),['old-note']);return source;}};
  const journalClient={appendTasks:async()=>{store.order.push('feishu');return{item:{blockId:'journal-block'},replayed:false};}};
  const calendarWriter=async()=>{store.order.push('calendar');return{enabled:true,path:path.join(root,'calendar.ics'),eventCount:1,writtenAt:'2026-08-14T01:00:00Z'};};
  const result=await syncExternalTasks({store,taskClient,journalClient,calendarWriter});
  assert.deepEqual(store.order.slice(0,4),['source','state','feishu','calendar']);
  assert.equal(result.committed,true);
  assert.equal(result.recentNoteCount,2);
  assert.equal(result.trackedNoteCount,1);
  assert.equal(store.state.todos.some(todo=>todo.externalId==='active-1'&&!todo.done&&todo.source==='getnote_cli'),true);
  assert.equal(store.state.inbox.some(item=>item.externalTaskId==='undated-1'&&item.sourceNoteId==='n2'),true);
  assert.equal(store.state.todos.find(todo=>todo.externalId==='done-1').done,true);
  assert.deepEqual(store.state.todayPlan,[],'only explicit source completion removes the old Today task');
  assert.equal(store.state.todayPlan.includes(store.state.todos.find(todo=>todo.externalId==='active-1').id),false);
});

test('Feishu and calendar failures are reported as sink errors after Workbench commit',async()=>{
  const store=new FakeStore('/tmp/fake-sink-failure');
  store.state=baseState();store.config=baseConfig();
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,timeZone:'Asia/Shanghai',journalDocumentUrl:'https://example.feishu.cn/wiki/journal',calendarEnabled:true}});
  const taskClient={fetch:async()=>taskSource(activeTasks)};
  const result=await syncExternalTasks({
    store,taskClient,
    journalClient:{appendTasks:async()=>{throw new Error('Feishu offline');}},
    calendarWriter:async()=>{throw new Error('disk unavailable');}
  });
  assert.equal(result.committed,true);
  assert.equal(result.journal.status,'error');
  assert.match(result.journal.error,/Feishu offline/);
  assert.equal(result.calendar.status,'error');
  assert.match(result.calendar.error,/disk unavailable/);
  assert.equal(store.state.todos.some(todo=>todo.externalId==='active-1'),true,'core state survives sink failures');
  assert.equal(store.config.settings.externalTaskPipeline.lastSyncStatus,'ok_with_sink_errors');
  assert.equal(store.state.activities.some(item=>item.type==='external_task_sink_failed'),true);
});

test('GetNote sync can be enabled without Feishu journal; daily summary still requires it',async()=>{
  const store=new FakeStore('/tmp/fake-no-journal');
  store.state=baseState();store.config=baseConfig();
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,timeZone:'Asia/Shanghai',journalDocumentUrl:'',calendarEnabled:false}});
  const result=await syncExternalTasks({store,taskClient:{fetch:async()=>taskSource(activeTasks)}});
  assert.equal(result.journal.status,'not_configured');
  assert.equal(result.calendar.status,'disabled');
  assert.equal(result.committed,true);
  await assert.rejects(publishDailySummary({store,date:'2026-08-14'}),error=>error?.code==='FEISHU_DAILY_JOURNAL_NOT_CONFIGURED');
});

test('task snapshot operationId follows persisted text, not source order or hidden timestamps',async()=>{
  const store=new FakeStore('/tmp/fake-order');
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,timeZone:'Asia/Shanghai',journalDocumentUrl:'https://example.feishu.cn/wiki/journal',calendarEnabled:false}});
  const operations=[];const texts=[];let changed=false;
  const taskClient={fetch:async()=>{
    const tasks=(changed?[...activeTasks].reverse():activeTasks).map(task=>({...task,updatedAt:changed?'2026-08-14T05:00:00Z':task.updatedAt}));
    return taskSource(tasks);
  }};
  const journalClient={appendTasks:async(url,text,options)=>{operations.push(options.operationId);texts.push(text);return{item:{blockId:`b-${operations.length}`},replayed:operations.length>1};}};
  await syncExternalTasks({store,taskClient,journalClient});changed=true;await syncExternalTasks({store,taskClient,journalClient});
  assert.equal(operations.length,2);assert.equal(texts[0],texts[1]);assert.equal(operations[0],operations[1]);
});

test('daily summary writes narrative to Feishu, keeps only an audit event locally, and safely replays',async()=>{
  const store=new FakeStore('/tmp/fake-summary');
  await updateExternalTaskIntegration({store,patch:{enabled:true,noteLimit:100,timeZone:'Asia/Shanghai',journalDocumentUrl:'https://example.feishu.cn/wiki/journal'}});
  const seen=new Map();const captured=[];
  const journalClient={appendSummary:async(url,text,options)=>{
    captured.push({text,operationId:options.operationId});const replayed=seen.has(options.operationId);seen.set(options.operationId,true);
    return{item:{blockId:'summary-block'},replayed};
  }};
  const first=await publishDailySummary({store,date:'2026-08-14',notes:'今天确认了供应商。',journalClient});
  const second=await publishDailySummary({store,date:'2026-08-14',notes:'今天确认了供应商。',journalClient});
  assert.equal(first.blockId,'summary-block');assert.equal(second.replayed,true);assert.equal(first.operationId,second.operationId);
  assert.equal(captured[0].text,captured[1].text);assert.match(captured[0].text,/今天确认了供应商/);
  assert.equal(store.state.activities.filter(activity=>activity.type==='daily_summary_published').length,2);
  assert.equal(store.state.activities.some(activity=>/供应商/.test(activity.text)),false);
});
