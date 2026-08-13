import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { deriveState,morningChat,setToday,syncAllProjects,syncProject,updateProject } from '../src/domain.mjs';
import { ensureProjectDir,projectPath } from '../src/projects.mjs';
import { stripNarrativeProgress } from '../src/project-record-policy.mjs';

function project(overrides={}){
  return {
    id:'p_invariant',businessId:'biz_client',name:'业务不变量项目',intro:'验证显式同步边界',folder:'业务不变量项目',
    createdAt:'2026-08-12',startDate:'2026-08-12',endDate:'2099-08-30',git:'',feishu:'',completed:false,archived:false,
    progress:{percent:0,status:'未启动',summary:'尚未同步',resume:'尚未同步',blocker:'暂无明确卡点。',lastActivity:null,confidence:.9,syncedAt:null},
    ...overrides
  };
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-invariants-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app');
  const store=new JsonStore(path.join(appRoot,'data'));
  await store.ensure();
  return {root,appRoot,store,config:await store.readConfig()};
}

function withoutOpenAi(t){
  const previous=process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(()=>{
    if(previous===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previous;
  });
}

function installMockAi(t,decisionForRequest,{analysis={}}={}){
  const previousFetch=globalThis.fetch;
  const previousKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key-not-a-real-secret';
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);
    const evidenceIds=request.text.format.schema.properties.analysis.properties.evidence.items.properties.id.enum;
    const decision=typeof decisionForRequest==='function'?decisionForRequest(request):decisionForRequest;
    const envelope={
      analysis:{
        evidence:[{id:evidenceIds[0],observation:'测试所用的已登记证据'}],
        conflicts:[],gaps:[],...analysis
      },
      decision
    };
    return{ok:true,status:200,json:async()=>({output_text:JSON.stringify(envelope)})};
  };
  t.after(()=>{
    globalThis.fetch=previousFetch;
    if(previousKey===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previousKey;
  });
}

function deferred(){
  let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
  return{promise,resolve,reject};
}

function installGatedProgressAi(t,decision){
  const entered=deferred(),release=deferred();
  const previousFetch=globalThis.fetch;
  const previousKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key-not-a-real-secret';
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);
    const evidenceId=request.text.format.schema.properties.analysis.properties.evidence.items.properties.id.enum[0];
    entered.resolve();
    await release.promise;
    return{ok:true,status:200,json:async()=>({output_text:JSON.stringify({
      analysis:{evidence:[{id:evidenceId,observation:'延迟测试所用的已登记证据'}],conflicts:[],gaps:[]},
      decision
    })})};
  };
  t.after(()=>{
    release.resolve();
    globalThis.fetch=previousFetch;
    if(previousKey===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previousKey;
  });
  return{entered:entered.promise,release:()=>release.resolve()};
}

function fakeProjectRecordClient(records=[]){
  const writes=[];
  return {
    writes,
    appendAnalysis:async(url,text)=>{writes.push({kind:'analysis',url,text});return{revisionId:writes.length,item:{blockId:`analysis_${writes.length}`}};},
    appendSummary:async(url,text)=>{writes.push({kind:'summary',url,text});return{revisionId:writes.length,item:{blockId:`summary_${writes.length}`}};},
    fetch:async()=>({revisionId:writes.length,items:records})
  };
}

test('real file changes do not alter persisted progress before explicit sync',async t=>{
  withoutOpenAi(t);
  const {appRoot,store,config}=await fixture(t);
  const p=project();
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  const baseline=structuredClone((await store.readState()).projects[0].progress);

  await fsp.writeFile(path.join(dir,'02_工作过程','真实工作痕迹.md'),'已发生文件变化，但用户尚未点击同步。','utf8');

  const beforeSync=await store.readState();
  assert.deepEqual(beforeSync.projects[0].progress,baseline);
  const derived=deriveState(appRoot,beforeSync,config,false);
  assert.equal(derived.projects[0].progress.percent,baseline.percent);
  assert.equal(derived.projects[0].progress.status,baseline.status);

  await syncProject({appRoot,store,projectId:p.id});
  const afterSync=(await store.readState()).projects[0].progress;
  assert.notDeepEqual(afterSync,baseline);
  assert.equal(afterSync.status,'进行中');
  assert.ok(afterSync.percent>0);
  assert.equal('summary' in afterSync,false);
});

test('morning conversation preserves todayPlan exactly',async t=>{
  withoutOpenAi(t);
  const {store}=await fixture(t);
  const todo={id:'td_today',title:'用户已决定事项',context:'保持今日安排不变',dueDate:'2099-08-20',projectId:null,done:false,createdAt:new Date().toISOString()};
  await store.updateState(state=>{state.todos.push(todo);});
  await setToday({store,todoId:todo.id,add:true});
  const before=structuredClone((await store.readState()).todayPlan);
  const result=await morningChat({store,message:'帮我过一下今天',sessionId:null});
  assert.equal(typeof result.reply,'string');
  assert.deepEqual((await store.readState()).todayPlan,before);
});

test('successful AI morning judgment still preserves todayPlan and its date exactly',async t=>{
  const {store}=await fixture(t);
  const todo={id:'td_ai_today',title:'用户已明确加入今日',context:'AI 只能讨论，不能改动今日计划',dueDate:'2099-08-20',projectId:null,done:false,createdAt:new Date().toISOString()};
  await store.updateState(state=>{state.todos.push(todo);});
  await setToday({store,todoId:todo.id,add:true});
  const before=structuredClone(await store.readState());
  const replyMarker='AI_MORNING_DECISION_WAS_USED';
  installMockAi(t,{reply:replyMarker,mentionedIds:[todo.id]});
  const result=await morningChat({store,message:'帮我过一下今天',sessionId:null});
  const after=await store.readState();
  assert.equal(result.reply,replyMarker);
  assert.deepEqual(after.todayPlan,before.todayPlan);
  assert.equal(after.todayPlanDate,before.todayPlanDate);
});

test('AI project analysis persists narrative only to the bound Feishu project document',async t=>{
  const {appRoot,store,config}=await fixture(t);
  const p=project({id:'p_analysis_audit',name:'分析隔离项目',folder:'分析隔离项目',feishu:'https://example.feishu.cn/wiki/project'});
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  const analysisSentinel='ANALYSIS_SENTINEL_DO_NOT_PERSIST';
  const decisionMarker='AI_DECISION_MARKER_FEISHU_ONLY';
  installMockAi(t,{
    percent:37,summary:decisionMarker,resume:'继续读取已确认的项目证据。',blocker:'暂无明确卡点。',status:'进行中',confidence:.86
  },{analysis:{conflicts:[analysisSentinel]}});
  const remote=fakeProjectRecordClient();

  await syncProject({appRoot,store,projectId:p.id,projectRecordClient:remote});
  const state=await store.readState();
  const rawState=await fsp.readFile(store.stateFile,'utf8');
  const projectMd=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');

  assert.equal(state.projects[0].progress.percent,37);
  assert.equal(state.projects[0].progress.status,'进行中');
  assert.equal('summary' in state.projects[0].progress,false);
  assert.equal(remote.writes.length,1);
  assert.match(remote.writes[0].text,new RegExp(decisionMarker));
  assert.doesNotMatch(JSON.stringify(state),new RegExp(decisionMarker));
  assert.doesNotMatch(rawState,new RegExp(decisionMarker));
  assert.doesNotMatch(projectMd,new RegExp(decisionMarker));
  assert.doesNotMatch(JSON.stringify(state),new RegExp(analysisSentinel));
  assert.match(projectMd,/分析与总结真源：飞书云文档/);
});

test('AI cannot mark a project completed without the user completion flag',async t=>{
  const {appRoot,store,config}=await fixture(t);
  const p=project({id:'p_ai_completion_guard',name:'完成权限项目',folder:'完成权限项目',completed:false});
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  installMockAi(t,{percent:100,summary:'模型擅自判断完成',resume:'模型擅自判断完成',blocker:'暂无明确卡点。',status:'已完成',confidence:.99});

  await syncProject({appRoot,store,projectId:p.id});
  const saved=(await store.readState()).projects[0];
  const projectMd=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
  assert.equal(saved.completed,false);
  assert.notEqual(saved.progress.status,'已完成');
  assert.ok(saved.progress.percent<=99);
  assert.doesNotMatch(projectMd,/当前进度|百分比：100%|模型擅自判断完成/);
});

test('stale Luna analysis cannot overwrite a user completion made while sync is running',{timeout:5000},async t=>{
  const {appRoot,store,config}=await fixture(t);
  const prior={percent:34,status:'进行中',summary:'同步前的人工可见进度',resume:'保持原上下文',blocker:'暂无明确卡点。',lastActivity:'2026-08-11T08:00:00.000Z',confidence:.8,syncedAt:'2026-08-11T09:00:00.000Z'};
  const machinePrior=stripNarrativeProgress(prior);
  const p=project({id:'p_sync_then_complete',name:'同步期间完成项目',folder:'同步期间完成项目',progress:prior});
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  const staleMarker='STALE_AI_PROGRESS_MUST_NOT_PERSIST';
  const gate=installGatedProgressAi(t,{percent:63,summary:staleMarker,resume:staleMarker,blocker:'暂无明确卡点。',status:'进行中',confidence:.91});

  const pending=syncProject({appRoot,store,projectId:p.id});
  await gate.entered;
  await updateProject({appRoot,store,projectId:p.id,patch:{completed:true}});
  gate.release();

  await assert.rejects(pending,error=>error?.statusCode===409&&error?.code==='PROJECT_SYNC_STALE');
  const state=await store.readState();
  const saved=state.projects.find(item=>item.id===p.id);
  const projectMd=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
  assert.equal(saved.completed,true);
  assert.equal(saved.progress.percent,100);
  assert.equal(saved.progress.status,'已完成');
  assert.deepEqual(saved.progressBeforeCompletion,machinePrior);
  assert.equal(state.activities.some(item=>item.type==='project_synced'&&item.projectId===p.id),false);
  assert.doesNotMatch(JSON.stringify(state),new RegExp(staleMarker));
  assert.doesNotMatch(projectMd,new RegExp(staleMarker));
  assert.match(projectMd,/分析与总结真源：飞书云文档/);
});

test('stale Luna analysis cannot undo a user reopening made while sync is running',{timeout:5000},async t=>{
  const {appRoot,store,config}=await fixture(t);
  const prior={percent:42,status:'进行中',summary:'重开后必须恢复的进度',resume:'继续原来的工作',blocker:'等待确认一个边界。',lastActivity:'2026-08-11T08:00:00.000Z',confidence:.76,syncedAt:'2026-08-11T09:00:00.000Z'};
  const machinePrior=stripNarrativeProgress(prior);
  const p=project({id:'p_sync_then_reopen',name:'同步期间重开项目',folder:'同步期间重开项目',progress:prior});
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  await updateProject({appRoot,store,projectId:p.id,patch:{completed:true}});
  const staleMarker='STALE_COMPLETED_AI_MUST_NOT_PERSIST';
  const gate=installGatedProgressAi(t,{percent:100,summary:staleMarker,resume:staleMarker,blocker:'暂无明确卡点。',status:'已完成',confidence:.99});

  const pending=syncProject({appRoot,store,projectId:p.id});
  await gate.entered;
  await updateProject({appRoot,store,projectId:p.id,patch:{completed:false}});
  gate.release();

  await assert.rejects(pending,error=>error?.statusCode===409&&error?.code==='PROJECT_SYNC_STALE');
  const state=await store.readState();
  const saved=state.projects.find(item=>item.id===p.id);
  const projectMd=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
  assert.equal(saved.completed,false);
  assert.deepEqual(saved.progress,machinePrior);
  assert.equal(Object.hasOwn(saved,'progressBeforeCompletion'),false);
  assert.equal(state.activities.some(item=>item.type==='project_synced'&&item.projectId===p.id),false);
  assert.doesNotMatch(JSON.stringify(state),new RegExp(staleMarker));
  assert.doesNotMatch(projectMd,new RegExp(staleMarker));
});

test('batch sync reports a stale project without creating a sync-failed confirmation',{timeout:5000},async t=>{
  const {appRoot,store,config}=await fixture(t);
  const prior={percent:28,status:'进行中',summary:'批量同步前的人工可见进度',resume:'继续现有工作',blocker:'暂无明确卡点。',lastActivity:'2026-08-11T08:00:00.000Z',confidence:.8,syncedAt:'2026-08-11T09:00:00.000Z'};
  const p=project({id:'p_batch_sync_stale',name:'批量同步过期项目',folder:'批量同步过期项目',progress:prior});
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  const staleMarker='BATCH_STALE_AI_MUST_NOT_PERSIST';
  const gate=installGatedProgressAi(t,{percent:68,summary:staleMarker,resume:staleMarker,blocker:'暂无明确卡点。',status:'进行中',confidence:.92});

  const pending=syncAllProjects({appRoot,store});
  await gate.entered;
  await updateProject({appRoot,store,projectId:p.id,patch:{completed:true}});
  gate.release();

  const results=await pending;
  const state=await store.readState();
  const saved=state.projects.find(item=>item.id===p.id);
  const projectMd=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
  assert.deepEqual(results,[{id:p.id,ok:false,stale:true,code:'PROJECT_SYNC_STALE'}]);
  assert.equal(saved.completed,true);
  assert.equal(saved.progress.percent,100);
  assert.equal(state.confirmations.some(item=>item.type==='sync_failed'&&item.projectId===p.id),false);
  assert.equal(state.activities.some(item=>item.type==='project_synced'&&item.projectId===p.id),false);
  assert.doesNotMatch(JSON.stringify(state),new RegExp(staleMarker));
  assert.doesNotMatch(projectMd,new RegExp(staleMarker));
});

test('ordinary low-confidence AI progress creates a visible confirmation',async t=>{
  const {appRoot,store,config}=await fixture(t);
  const p=project({id:'p_low_confidence',name:'低置信度项目',folder:'低置信度项目'});
  await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  const previousFetch=globalThis.fetch;
  const previousKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key-not-a-real-secret';
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);
    const evidenceId=request.text.format.schema.properties.analysis.properties.evidence.items.properties.id.enum[0];
    return{ok:true,status:200,json:async()=>({output_text:JSON.stringify({
      analysis:{evidence:[{id:evidenceId,observation:'证据有限'}],conflicts:[],gaps:[]},
      decision:{percent:12,summary:'证据不足',resume:'需要用户核对',blocker:'无法可靠判断',status:'进行中',confidence:.3}
    })})};
  };
  t.after(()=>{
    globalThis.fetch=previousFetch;
    if(previousKey===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previousKey;
  });

  const analysis=await syncProject({appRoot,store,projectId:p.id});
  const state=await store.readState();
  assert.equal(analysis.scan.complete,true);
  assert.equal(state.projects[0].progress.confidence,.3);
  assert.equal(state.projects[0].progress.hasBlocker,true);
  assert.equal(state.confirmations.some(item=>item.type==='progress_unclear'&&item.projectId===p.id),true);
});

test('sync never recreates a missing project directory and preserves last machine progress',async t=>{
  withoutOpenAi(t);
  const {appRoot,store,config}=await fixture(t);
  const prior={percent:42,status:'进行中',summary:'已经完成需求梳理。',resume:'正在实现核心流程。',blocker:'等待一项本地资料。',lastActivity:'2026-08-11T08:00:00.000Z',confidence:.8,syncedAt:'2026-08-11T09:00:00.000Z'};
  const p=project({id:'p_missing_dir',name:'目录缺失项目',folder:'目录缺失项目',progress:prior});
  await store.updateState(state=>{state.projects.push(p);});
  const dir=projectPath(appRoot,config,p);

  const analysis=await syncProject({appRoot,store,projectId:p.id});
  const state=await store.readState();
  await assert.rejects(fsp.lstat(dir),error=>error.code==='ENOENT');
  assert.equal(analysis.progress.percent,42);
  assert.ok(analysis.progress.confidence<=.2);
  assert.equal(state.projects[0].progress.percent,42);
  assert.equal(state.projects[0].progress.hasBlocker,true);
  assert.equal('summary' in state.projects[0].progress,false);
  assert.equal(state.confirmations.some(item=>item.type==='progress_unclear'&&item.projectId===p.id),true);
});

test('completed project restores its exact prior machine progress when reopened',async t=>{
  const {appRoot,store,config}=await fixture(t);
  const prior={percent:42,status:'进行中',summary:'需求和数据结构已经完成。',resume:'继续实现同步流程。',blocker:'等待确认一个边界。',lastActivity:'2026-08-11T08:00:00.000Z',confidence:.76,syncedAt:'2026-08-11T09:00:00.000Z'};
  const machinePrior=stripNarrativeProgress(prior);
  const p=project({id:'p_completion_roundtrip',name:'完成往返项目',folder:'完成往返项目',progress:prior});
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});

  await updateProject({appRoot,store,projectId:p.id,patch:{completed:true}});
  let saved=(await store.readState()).projects[0];
  assert.equal(saved.progress.percent,100);
  assert.deepEqual(saved.progressBeforeCompletion,machinePrior);

  await updateProject({appRoot,store,projectId:p.id,patch:{completed:false}});
  saved=(await store.readState()).projects[0];
  assert.equal(saved.completed,false);
  assert.deepEqual(saved.progress,machinePrior);
  assert.equal(Object.hasOwn(saved,'progressBeforeCompletion'),false);
  const projectMd=await fsp.readFile(path.join(dir,'PROJECT.md'),'utf8');
  assert.doesNotMatch(projectMd,/需求和数据结构已经完成|继续实现同步流程|等待确认一个边界/);
  assert.match(projectMd,/分析与总结真源：飞书云文档/);
});

test('malformed PROJECT.md no longer rolls back a successful sync machine state',async t=>{
  withoutOpenAi(t);
  const {appRoot,store,config}=await fixture(t);
  const p=project({id:'p_project_md_failure',name:'写入失败项目',folder:'写入失败项目'});
  const dir=await ensureProjectDir(appRoot,config,p);
  await store.updateState(state=>{state.projects.push(p);});
  const target=path.join(dir,'PROJECT.md');
  const malformed='用户正文\n<!-- personal-ai-workbench:managed:start -->\n损坏的托管区块\n';
  await fsp.writeFile(target,malformed,'utf8');

  const result=await syncProject({appRoot,store,projectId:p.id});
  const state=await store.readState();
  assert.ok(result.machineProgress);
  assert.ok(state.activities.some(item=>item.type==='project_synced'&&item.projectId===p.id));
  assert.ok(state.confirmations.some(item=>item.type==='project_identity_update_failed'&&item.projectId===p.id));
  assert.equal(await fsp.readFile(target,'utf8'),malformed);

  const before=await store.readState();
  await assert.rejects(updateProject({appRoot,store,projectId:p.id,patch:{intro:'不应提交的新介绍'}}),/托管区块不完整/);
  assert.deepEqual(await store.readState(),before);
});
