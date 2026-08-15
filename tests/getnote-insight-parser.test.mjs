import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GetnoteInsightStore} from '../src/getnote-insight.mjs';
import {GETNOTE_INSIGHT_PARSER_VERSION,analyzeGetnoteNote} from '../src/getnote-insight-parser.mjs';

const content='张三：新品首发就定在9月第二周。\n李四：首批数量王辉这边再跟经销商确认一下，下周处理。\n张三：8月20日前把最终渠道预算确认下来。';
const note={noteId:'note-001',title:'新品上市周会',createdAt:'2026-08-15T09:00:00+08:00',updatedAt:'2026-08-15T10:00:00+08:00',noteUrl:'https://www.biji.com/note/note-001',noteType:'MEETING',sourceField:'audio_original',content};

function runtime(enabled=true){return{provider:'responses-compatible',profileId:'third_party_responses',adapter:'openai_responses_compatible',model:'gpt-5.6-luna',activeModel:'gpt-5.6-luna',reasoningEffort:'xhigh',structuredOutputMode:'strict_native',configured:enabled,enabled,degraded:false};}
function modelDecision(){return{
  summary:{text:'会议确认新品首发节奏，并留下配额和预算事项。',confidence:.95,evidenceKeys:['e1','e2']},
  topics:[{text:'新品上市',confidence:.98}],
  decisions:[{text:'新品首发定在9月第二周。',status:'confirmed',confidence:.96,evidenceKeys:['e1']}],
  actionCandidates:[
    {text:'确认经销商首批配额',ownerHint:'王辉',dueHint:'下周',explicitDueDate:null,confidence:.84,evidenceKeys:['e2']},
    {text:'确认最终渠道预算',ownerHint:'',dueHint:'8月20日前',explicitDueDate:'2026-08-20',confidence:.91,evidenceKeys:['e3']}
  ],
  risks:[],openQuestions:[],projectCandidates:[{name:'新品上市',confidence:.9,evidenceKeys:['e1']}],
  evidence:[
    {key:'e1',excerpt:'新品首发就定在9月第二周。',speaker:'张三'},
    {key:'e2',excerpt:'首批数量王辉这边再跟经销商确认一下，下周处理。',speaker:'李四'},
    {key:'e3',excerpt:'8月20日前把最终渠道预算确认下来。',speaker:'张三'}
  ],
  quality:{overallConfidence:.92,warnings:[]}
};}
function outcome(decision=modelDecision()){return{analysis:{evidence:[{id:'note_content',observation:'parsed from exact note content'}],conflicts:[],gaps:[]},decision,execution:{providerProfileId:'third_party_responses',provider:'responses-compatible',adapter:'openai_responses_compatible',model:'gpt-5.6-luna',degraded:false,usage:{inputTokens:100,outputTokens:50}}};}

async function tempStore(t,prefix){const root=await fsp.mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return new GetnoteInsightStore(root);}

test('GetNote parser converts local evidence keys to deterministic evidence IDs and stores only validated insight',async t=>{
  const store=await tempStore(t,'paw-getnote-parser-');
  let call;
  const result=await analyzeGetnoteNote({note,store,runtimeConfig:()=>runtime(),runStructured:async options=>{call=options;return outcome();},now:()=>new Date('2026-08-15T11:00:00Z')});
  assert.equal(result.cached,false);
  assert.equal(result.insight.parser.version,GETNOTE_INSIGHT_PARSER_VERSION);
  assert.equal(result.insight.actionCandidates.length,2);
  assert.match(result.insight.actionCandidates[0].candidateKey,/^cand_/);
  assert.match(result.insight.evidence[0].id,/^ev_/);
  assert.deepEqual(result.insight.decisions[0].evidenceIds,[result.insight.evidence[0].id]);
  assert.equal(call.workflow,'getnote_insight');
  assert.equal(call.input.includes(content),true);
  assert.equal(call.instructions.includes('不能创建 Todo'),true);
});

test('cache hit bypasses the AI provider for the same note content and model profile',async t=>{
  const store=await tempStore(t,'paw-getnote-cache-');
  let calls=0;
  const options={note,store,runtimeConfig:()=>runtime(),runStructured:async()=>{calls+=1;return outcome();},now:()=>new Date('2026-08-15T11:00:00Z')};
  const first=await analyzeGetnoteNote(options);
  const second=await analyzeGetnoteNote({...options,runStructured:async()=>{throw new Error('must not be called');}});
  assert.equal(first.cached,false);
  assert.equal(second.cached,true);
  assert.equal(calls,1);
  assert.deepEqual(second.insight,first.insight);
});

test('AI-disabled parsing fails explicitly and never fabricates an insight',async t=>{
  const store=await tempStore(t,'paw-getnote-disabled-');
  let called=false;
  await assert.rejects(analyzeGetnoteNote({note,store,runtimeConfig:()=>runtime(false),runStructured:async()=>{called=true;}}),error=>error.code==='GETNOTE_INSIGHT_AI_NOT_CONFIGURED');
  assert.equal(called,false);
});

test('evidence must be an exact substring of the selected GetNote raw content',async t=>{
  const store=await tempStore(t,'paw-getnote-evidence-');
  const invalid=modelDecision();invalid.evidence[0]={key:'e1',excerpt:'模型自己改写的一段不存在的原文。',speaker:'张三'};
  await assert.rejects(analyzeGetnoteNote({note,store,runtimeConfig:()=>runtime(),runStructured:async()=>outcome(invalid)}),error=>error.code==='GETNOTE_INSIGHT_EVIDENCE_MISMATCH');
  assert.equal((await store.listCandidates()).length,0);
});

test('explicitDueDate requires matching explicit date evidence and vague due hints cannot become a date',async t=>{
  const store=await tempStore(t,'paw-getnote-date-');
  const invalid=modelDecision();invalid.actionCandidates[0]={...invalid.actionCandidates[0],explicitDueDate:'2026-08-22'};
  await assert.rejects(analyzeGetnoteNote({note,store,runtimeConfig:()=>runtime(),runStructured:async()=>outcome(invalid)}),error=>error.code==='GETNOTE_INSIGHT_DATE_UNSUPPORTED');
});

test('parser rejects unknown automation fields before any Workbench state mutation exists',async t=>{
  const store=await tempStore(t,'paw-getnote-scope-');
  const invalid=modelDecision();invalid.actionCandidates[0]={...invalid.actionCandidates[0],today:true};
  await assert.rejects(analyzeGetnoteNote({note,store,runtimeConfig:()=>runtime(),runStructured:async()=>outcome(invalid)}));
  assert.equal((await store.listCandidates()).length,0);
});
