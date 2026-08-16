import test from 'node:test';
import assert from 'node:assert/strict';
import { localDiaryReviewPlan, normalizeDiaryReviewDecision } from '../src/diary-review-planner.mjs';

test('clear todo stays classified as todo even when due date is missing',()=>{
  const plan=normalizeDiaryReviewDecision({
    category:'todo',destination:'todo',targetProjectId:null,dueDate:null,confidence:.91,
    reason:'这是明确的后续行动，但原文没有截止日期。',message:'补充截止日期后即可创建待办。'
  },{evidence:[],conflicts:[],gaps:[]},{id:'in-1'});
  assert.equal(plan.kind,'clarification');
  assert.equal(plan.category,'todo');
  assert.equal(plan.destination,'todo');
  assert.match(plan.reason,/分类：待办候选/);
  assert.match(plan.messageReply,/待办候选|截止日期/);
});

test('analysis and daily records receive an automatic memo destination',()=>{
  for(const category of ['analysis','daily_record']){
    const plan=normalizeDiaryReviewDecision({
      category,destination:'memo',targetProjectId:null,dueDate:null,confidence:.86,
      reason:'属于记录或思考，不需要任务化。',message:'建议保存为备忘。'
    },{evidence:[],conflicts:[],gaps:[]},{id:`in-${category}`});
    assert.equal(plan.kind,'tool');
    assert.equal(plan.toolName,'inbox_process');
    assert.equal(plan.args.command,'只是备忘');
    assert.equal(plan.category,category);
  }
});

test('uniquely matched project progress receives project-note preview',()=>{
  const plan=normalizeDiaryReviewDecision({
    category:'project_progress',destination:'project_note',targetProjectId:'p-1',dueDate:null,confidence:.9,
    reason:'明确描述现有项目进展。',message:'建议归入项目记录。'
  },{evidence:[],conflicts:[],gaps:[]},{id:'in-project'});
  assert.equal(plan.kind,'tool');
  assert.equal(plan.args.targetProjectId,'p-1');
  assert.match(plan.args.command,/项目记录/);
});

test('local fallback still distributes actionable and reflective diary blocks',()=>{
  const todo=localDiaryReviewPlan({
    route:{id:'in-todo'},state:{inbox:[{id:'in-todo',text:'[飞书混合日记｜块类型：复选框记录] 补完固定开场 slogan 三个版本'}],projects:[]}
  });
  assert.equal(todo.category,'todo');
  assert.equal(todo.kind,'clarification');

  const analysis=localDiaryReviewPlan({
    route:{id:'in-analysis'},state:{inbox:[{id:'in-analysis',text:'采集库的价值是选题和结构，不是再整理成更多文件。'}],projects:[]}
  });
  assert.equal(analysis.category,'analysis');
  assert.equal(analysis.args.command,'只是备忘');

  const project=localDiaryReviewPlan({
    route:{id:'in-project'},state:{
      inbox:[{id:'in-project',text:'常金米业项目目前已完成第一轮需求访谈，进入方案整理阶段'}],
      projects:[{id:'p-1',name:'常金米业',archived:false}]
    }
  });
  assert.equal(project.category,'project_progress');
  assert.equal(project.args.targetProjectId,'p-1');
});
