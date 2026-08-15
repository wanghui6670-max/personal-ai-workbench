import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GETNOTE_INSIGHT_SCHEMA_VERSION,
  GetnoteInsightStore,
  candidateKeyFor,
  evidenceIdFor,
  getnoteContentHash,
  normalizeGetnoteInsight
} from '../src/getnote-insight.mjs';

function baseInsight(overrides={}){
  const noteId='note-001';
  const excerpt='首批数量王辉这边再跟经销商确认一下。';
  const evidenceId=evidenceIdFor({noteId,excerpt,speaker:'张三'});
  return{
    schemaVersion:GETNOTE_INSIGHT_SCHEMA_VERSION,
    note:{noteId,title:'新品上市周会',createdAt:'2026-08-15T09:00:00+08:00',updatedAt:'2026-08-15T10:00:00+08:00',noteUrl:'https://www.biji.com/note/note-001'},
    source:{contentHash:getnoteContentHash('会议正文-v1'),language:'zh-CN'},
    parser:{version:'1.0.0',modelProfile:'gpt-5.6-luna/xhigh',parsedAt:'2026-08-15T11:00:00+08:00'},
    summary:{text:'会议确认新品上市节奏与首批配额。',confidence:0.95,evidenceIds:[evidenceId]},
    topics:[{text:'新品上市',confidence:0.98}],
    decisions:[{text:'首发时间定在九月第二周。',status:'confirmed',confidence:0.96,evidenceIds:[evidenceId]}],
    actionCandidates:[{text:'确认经销商首批配额',ownerHint:'王辉',dueHint:'下周',explicitDueDate:null,confidence:0.84,evidenceIds:[evidenceId]}],
    risks:[{text:'渠道物料可能无法按计划到位。',severity:'medium',confidence:0.88,evidenceIds:[evidenceId]}],
    openQuestions:[{text:'最终渠道预算是否已经审批？',confidence:0.81,evidenceIds:[evidenceId]}],
    projectCandidates:[{name:'新品上市',confidence:0.9,evidenceIds:[evidenceId]}],
    evidence:[{id:evidenceId,excerpt,speaker:'张三'}],
    quality:{overallConfidence:0.91,warnings:[]},
    ...overrides
  };
}

test('GetNoteInsightV1 requires evidence and refuses hidden task automation fields',()=>{
  const normalized=normalizeGetnoteInsight(baseInsight());
  assert.equal(normalized.schemaVersion,'getnote-insight-v1');
  assert.equal(normalized.decisions[0].status,'confirmed');
  assert.equal(normalized.actionCandidates[0].explicitDueDate,null);
  assert.ok(normalized.actionCandidates[0].candidateKey.startsWith('cand_'));

  const noEvidence=baseInsight({actionCandidates:[{text:'确认配额',confidence:0.8,evidenceIds:[]}]});
  assert.throws(()=>normalizeGetnoteInsight(noEvidence),/evidence/i);

  const automated=baseInsight({actionCandidates:[{text:'确认配额',confidence:0.8,evidenceIds:baseInsight().actionCandidates[0].evidenceIds,today:true}]});
  assert.throws(()=>normalizeGetnoteInsight(automated),/不支持的字段|unsupported/i);
});

test('evidence and candidate keys stay stable when AI paraphrases the candidate text',()=>{
  const noteId='note-001';
  const excerpt='首批数量王辉这边再跟经销商确认一下。';
  const firstEvidence=evidenceIdFor({noteId,excerpt,speaker:'张三'});
  const secondEvidence=evidenceIdFor({noteId,excerpt:'  首批数量王辉这边再跟经销商确认一下。  ',speaker:'张三'});
  assert.equal(firstEvidence,secondEvidence);
  const first=candidateKeyFor({noteId,kind:'action',evidenceIds:[firstEvidence]});
  const second=candidateKeyFor({noteId,kind:'action',evidenceIds:[secondEvidence]});
  assert.equal(first,second);

  const one=normalizeGetnoteInsight(baseInsight());
  const two=normalizeGetnoteInsight(baseInsight({actionCandidates:[{...baseInsight().actionCandidates[0],text:'与经销商确认首批配额'}]}));
  assert.equal(one.actionCandidates[0].candidateKey,two.actionCandidates[0].candidateKey);
});

test('cache key includes note, content hash, parser version and model profile without persisting raw note content',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-getnote-insight-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new GetnoteInsightStore(root);
  const insight=baseInsight();
  const first=await store.putInsight(insight);
  assert.equal(first.replayed,false);
  const replay=await store.putInsight(insight);
  assert.equal(replay.replayed,true);
  assert.deepEqual(await store.findCachedInsight({noteId:insight.note.noteId,contentHash:insight.source.contentHash,parserVersion:'1.0.0',modelProfile:'gpt-5.6-luna/xhigh'}),first.insight);
  assert.equal(await store.findCachedInsight({noteId:insight.note.noteId,contentHash:insight.source.contentHash,parserVersion:'1.0.1',modelProfile:'gpt-5.6-luna/xhigh'}),null);
  assert.equal(await store.findCachedInsight({noteId:insight.note.noteId,contentHash:insight.source.contentHash,parserVersion:'1.0.0',modelProfile:'gpt-5.6-luna/medium'}),null);

  const files=await fsp.readdir(path.join(root,'getnote','insights'));
  assert.equal(files.length,1);
  const persisted=await fsp.readFile(path.join(root,'getnote','insights',files[0]),'utf8');
  assert.doesNotMatch(persisted,/rawContent|会议正文-v1/);
});

test('same cache tuple cannot be silently overwritten by a different AI result',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-getnote-conflict-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new GetnoteInsightStore(root);
  const insight=baseInsight();
  await store.putInsight(insight);
  await assert.rejects(
    store.putInsight({...insight,summary:{...insight.summary,text:'不同的总结'}}),
    error=>error.code==='GETNOTE_INSIGHT_CACHE_CONFLICT'
  );
});

test('candidate reconciliation stales only unresolved candidates and preserves human decisions',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-getnote-candidates-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new GetnoteInsightStore(root);
  const first=await store.putInsight(baseInsight());
  const key=first.insight.actionCandidates[0].candidateKey;
  let candidates=await store.listCandidates();
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].state,'pending');
  assert.equal(candidates[0].sourcePresent,true);

  await store.setCandidateReviewState(key,{expectedState:'pending',state:'accepted',resolution:{type:'todo',id:'td-accepted'}});
  const changed=baseInsight({
    source:{contentHash:getnoteContentHash('会议正文-v2'),language:'zh-CN'},
    parser:{version:'1.0.0',modelProfile:'gpt-5.6-luna/xhigh',parsedAt:'2026-08-15T12:00:00+08:00'},
    actionCandidates:[]
  });
  await store.putInsight(changed);
  candidates=await store.listCandidates();
  assert.equal(candidates[0].state,'accepted');
  assert.equal(candidates[0].sourcePresent,false);
  assert.equal(candidates[0].resolution.id,'td-accepted');

  const secondRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-getnote-stale-'));
  t.after(()=>fsp.rm(secondRoot,{recursive:true,force:true}));
  const pendingStore=new GetnoteInsightStore(secondRoot);
  await pendingStore.putInsight(baseInsight());
  await pendingStore.putInsight(changed);
  const stale=(await pendingStore.listCandidates())[0];
  assert.equal(stale.state,'stale');
  assert.equal(stale.sourcePresent,false);
});

test('human review transitions use expected state and rejected candidates can be restored only while source still exists',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-getnote-review-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new GetnoteInsightStore(root);
  const result=await store.putInsight(baseInsight());
  const key=result.insight.actionCandidates[0].candidateKey;
  const rejected=await store.setCandidateReviewState(key,{expectedState:'pending',state:'rejected'});
  assert.equal(rejected.state,'rejected');
  await assert.rejects(store.setCandidateReviewState(key,{expectedState:'pending',state:'accepted',resolution:{type:'todo',id:'td-x'}}),error=>error.code==='GETNOTE_CANDIDATE_CONFLICT');
  const restored=await store.setCandidateReviewState(key,{expectedState:'rejected',state:'pending'});
  assert.equal(restored.state,'pending');
});
