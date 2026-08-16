import test from 'node:test';
import assert from 'node:assert/strict';
import { localDiaryReviewPlan, normalizeDiaryTodoExtraction } from '../src/diary-review-planner.mjs';

test('one diary paragraph can produce multiple atomic todo candidates',()=>{
  const projects=[{id:'p-1',name:'常金米业',archived:false}];
  const plan=normalizeDiaryTodoExtraction({
    todoCandidates:[
      {text:'补完固定开场 slogan 三个版本',dueDate:null,targetProjectId:null,confidence:.91,reason:'明确的后续制作动作。'},
      {text:'联系常金米业确认采购截图需求',dueDate:'2026-08-20',targetProjectId:'p-1',confidence:.9,reason:'原文明示了联系动作、项目和日期。'}
    ],
    reason:'同一段里包含两个独立下一步动作。'
  },{evidence:[],conflicts:[],gaps:[]},{id:'in-1'},{projects});
  assert.equal(plan.kind,'tool');
  assert.equal(plan.toolName,'diary_extract_todos');
  assert.equal(plan.args.itemId,'in-1');
  assert.equal(plan.args.candidates.length,2);
  assert.equal(plan.args.candidates[0].dueDate,null);
  assert.equal(plan.args.candidates[1].targetProjectId,'p-1');
});

test('analysis-only diary paragraph produces zero todo candidates instead of a memo/task',()=>{
  const plan=normalizeDiaryTodoExtraction({
    todoCandidates:[],
    reason:'这是对采集库价值的分析，没有独立下一步动作。'
  },{evidence:[],conflicts:[],gaps:[]},{id:'in-analysis'},{projects:[]});
  assert.equal(plan.toolName,'diary_extract_todos');
  assert.deepEqual(plan.args.candidates,[]);
  assert.equal(plan.category,'non_todo');
  assert.match(plan.messageReply,/没有提取到待办/);
});

test('candidate normalization deduplicates repeated actions and drops unknown project ids',()=>{
  const plan=normalizeDiaryTodoExtraction({
    todoCandidates:[
      {text:'  补完视频后再拍  ',dueDate:null,targetProjectId:'unknown',confidence:.8,reason:'动作'},
      {text:'补完视频后再拍',dueDate:null,targetProjectId:null,confidence:.7,reason:'重复动作'}
    ],reason:'重复'
  },{}, {id:'in-dedupe'}, {projects:[]});
  assert.equal(plan.args.candidates.length,1);
  assert.equal(plan.args.candidates[0].text,'补完视频后再拍');
  assert.equal(plan.args.candidates[0].targetProjectId,null);
});

test('local fallback extracts only obvious action sentences and does not taskify pure analysis',()=>{
  const todo=localDiaryReviewPlan({
    route:{id:'in-todo'},state:{inbox:[{id:'in-todo',text:'前面是复盘。补完固定开场 slogan 三个版本；然后再拍成片。'}],projects:[]}
  });
  assert.equal(todo.toolName,'diary_extract_todos');
  assert.ok(todo.args.candidates.length>=1);
  assert.ok(todo.args.candidates.every(item=>item.dueDate===null));

  const analysis=localDiaryReviewPlan({
    route:{id:'in-analysis'},state:{inbox:[{id:'in-analysis',text:'采集库的价值是选题和结构，不是再整理成更多文件。'}],projects:[]}
  });
  assert.equal(analysis.args.candidates.length,0);
});
