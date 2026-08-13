import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { machineProgress, narrativeFromProgress } from '../src/project-record-policy.mjs';
import { projectIdentityBlock } from '../src/project-identity.mjs';
import { createFeishuProjectRecordClient, parseFeishuProjectRecordsXml } from '../src/feishu.mjs';
import { readProjectRecords, appendProjectSummary } from '../src/domain.mjs';
import { validateState } from '../src/validation.mjs';

function projectDoc(records=[], { withSection=true }={}){
  const section=withSection?`<h1 id="records">项目分析与总结</h1>${records.map((record,index)=>`<p id="r_${index}">${record}</p>`).join('')}`:'';
  return `<title id="doc">项目文档</title><h1 id="intro">项目介绍</h1><p id="intro_p">介绍正文</p>${section}<h1 id="other">其他</h1>`;
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-project-record-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  await store.updateState(state=>{
    state.projects.push({
      id:'p_test',businessId:'biz_ai',name:'测试项目',intro:'测试介绍',createdAt:'2026-08-13',startDate:'2026-08-13',endDate:'2026-08-31',
      folder:'test-project',git:'',feishu:'https://example.feishu.cn/wiki/project',completed:false,archived:false,
      progress:{percent:42,status:'进行中',summary:'这段分析不应持久化',resume:'这段恢复摘要不应持久化',blocker:'客户待确认',lastActivity:'2026-08-13T01:00:00.000Z',syncedAt:'2026-08-13T02:00:00.000Z',confidence:.8}
    });
  });
  return store;
}

test('machine progress retains operational state but strips narrative text',()=>{
  const progress=machineProgress({percent:61,status:'进行中',summary:'详细分析',resume:'恢复摘要',blocker:'存在卡点',lastActivity:'2026-08-13T01:00:00Z',syncedAt:'2026-08-13T02:00:00Z',confidence:.7},{revisionId:9,item:{blockId:'blk_9'},recordedAt:'2026-08-13T02:00:00Z',operationId:'pa_test'});
  assert.deepEqual(progress,{
    percent:61,status:'进行中',hasBlocker:true,lastActivity:'2026-08-13T01:00:00Z',syncedAt:'2026-08-13T02:00:00Z',confidence:.7,
    feishuRevisionId:'9',feishuRecordBlockId:'blk_9',feishuRecordedAt:'2026-08-13T02:00:00Z',feishuOperationId:'pa_test'
  });
  assert.equal('summary' in progress,false);
  assert.equal('resume' in progress,false);
  assert.equal('blocker' in progress,false);
});

test('machine progress preserves an explicit null syncedAt during legacy migration',()=>{
  const progress=machineProgress({percent:0,status:'未启动',lastActivity:null,syncedAt:null,confidence:.9});
  assert.equal(progress.syncedAt,null);
  assert.equal(progress.lastActivity,null);
});

test('machine progress validator rejects local narrative fields',()=>{
  const state={
    schemaVersion:1,inbox:[],inboxAcks:[],todos:[],todayPlan:[],todayPlanDate:null,confirmations:[],notes:[],activities:[],morningSessions:[],
    projects:[{id:'p_validate',businessId:null,name:'校验项目',intro:'',createdAt:'2026-08-13',startDate:'2026-08-13',endDate:'2026-08-31',folder:'',git:'',feishu:'',completed:false,archived:false,progress:{percent:1,status:'进行中',summary:'不得留在本地'}}]
  };
  assert.throws(()=>validateState(state),/项目分析正文必须只保存在飞书项目文档/);
});

test('JsonStore migration removes legacy narrative fields from project progress',async t=>{
  const store=await fixture(t);
  const state=await store.readState();
  const progress=state.projects[0].progress;
  assert.equal(progress.percent,42);
  assert.equal(progress.status,'进行中');
  assert.equal(progress.hasBlocker,true);
  assert.equal('summary' in progress,false);
  assert.equal('resume' in progress,false);
  assert.equal('blocker' in progress,false);
});

test('PROJECT.md managed block is identity-only and points narrative to Feishu',()=>{
  const block=projectIdentityBlock({id:'p_test',name:'测试项目',intro:'介绍',startDate:'2026-08-13',endDate:'2026-08-31',git:'https://github.com/example/repo',feishu:'https://example.feishu.cn/wiki/project'},'动觉 AI');
  assert.match(block,/分析与总结真源：飞书云文档/);
  assert.match(block,/飞书项目文档：https:\/\/example\.feishu\.cn\/wiki\/project/);
  assert.doesNotMatch(block,/进度说明|当前卡点|上下文恢复|最近同步/);
});

test('Feishu project parser reads only fixed project record section and prefixes',()=>{
  const xml=projectDoc([
    '[WORKBENCH_ANALYSIS] [WORKBENCH_OP:pa_one] 分析一',
    '[WORKBENCH_SUMMARY] 总结一',
    '普通项目正文不得进入记录'
  ]).replace('</h1><p id="intro_p">介绍正文</p>','</h1><p id="intro_p">[WORKBENCH_ANALYSIS] 其他章节不得读取</p>');
  const parsed=parseFeishuProjectRecordsXml(xml);
  assert.equal(parsed.sectionFound,true);
  assert.equal(parsed.headingBlockId,'records');
  assert.deepEqual(parsed.items.map(item=>[item.kind,item.operationId,item.text]),[['analysis','pa_one','分析一'],['summary',null,'总结一']]);
});

test('Feishu project record client creates fixed section and confirms append by operation id',async()=>{
  const calls=[];
  let stage=0;
  const fakeExec=async(command,args)=>{
    calls.push({command,args});
    if(args.includes('+fetch')){
      const content=stage===0
        ?projectDoc([],{withSection:false})
        :stage===1
          ?projectDoc([])
          :projectDoc(['[WORKBENCH_ANALYSIS] [WORKBENCH_OP:pa_test] 新分析']);
      return {stdout:JSON.stringify({data:{document:{content,revision_id:stage+1,document_id:'doc'}}})};
    }
    stage+=1;
    return {stdout:JSON.stringify({ok:true})};
  };
  const client=createFeishuProjectRecordClient({exec:fakeExec});
  const result=await client.appendAnalysis('https://example.feishu.cn/wiki/project','新分析',{operationId:'pa_test'});
  assert.equal(result.item.kind,'analysis');
  assert.equal(result.item.operationId,'pa_test');
  assert.equal(result.item.text,'新分析');
  assert.equal(result.item.blockId,'r_0');
  assert.equal(calls.filter(call=>call.args.includes('+update')).length,2);
});

test('same operation id replays the existing Feishu record without another write',async()=>{
  const calls=[];
  const fakeExec=async(command,args)=>{
    calls.push({command,args});
    if(args.includes('+fetch')){
      return {stdout:JSON.stringify({data:{document:{content:projectDoc(['[WORKBENCH_SUMMARY] [WORKBENCH_OP:ps_same] 已存在总结']),revision_id:9,document_id:'doc'}}})};
    }
    throw new Error('replay must not write');
  };
  const client=createFeishuProjectRecordClient({exec:fakeExec});
  const result=await client.appendSummary('https://example.feishu.cn/wiki/project','已存在总结',{operationId:'ps_same'});
  assert.equal(result.replayed,true);
  assert.equal(result.item.blockId,'r_0');
  assert.equal(calls.filter(call=>call.args.includes('+update')).length,0);
});

test('project summary is written to Feishu, updates pointer, and local activity does not duplicate text',async t=>{
  const store=await fixture(t);
  const calls=[];
  const client={
    appendSummary:async(url,text,{operationId})=>{calls.push({url,text,operationId});return{revisionId:12,item:{blockId:'sum_12',operationId}};},
    fetch:async()=>({revisionId:12,items:[{blockId:'a1',kind:'analysis',operationId:null,text:'远端分析'}]})
  };
  const secretSummary='这是只应存在飞书的阶段总结正文';
  const saved=await appendProjectSummary({store,projectId:'p_test',text:secretSummary,projectRecordClient:client});
  assert.equal(saved.saved,true);
  assert.equal(calls[0].text,secretSummary);
  const state=await store.readState();
  assert.equal(JSON.stringify(state).includes(secretSummary),false);
  assert.equal(state.projects[0].progress.feishuRecordBlockId,'sum_12');
  assert.equal(state.projects[0].progress.feishuOperationId,saved.operationId);
  assert.ok(state.activities.some(activity=>activity.type==='project_summary_saved'));

  const records=await readProjectRecords({store,projectId:'p_test',projectRecordClient:client});
  assert.deepEqual(records.records,[{blockId:'a1',kind:'analysis',operationId:null,text:'远端分析'}]);
});

test('narrative formatter contains human-readable analysis only for remote write payload',()=>{
  const text=narrativeFromProgress({name:'测试项目'},{percent:70,status:'进行中',summary:'分析正文',blocker:'卡点正文',resume:'恢复正文',lastActivity:'2026-08-13T01:00:00Z'},{recordedAt:'2026-08-13T02:00:00Z'});
  assert.match(text,/分析：分析正文/);
  assert.match(text,/卡点：卡点正文/);
  assert.match(text,/恢复摘要：恢复正文/);
});
