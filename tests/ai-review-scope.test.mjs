import test from 'node:test';
import assert from 'node:assert/strict';
import {enforceInboxReviewPlan,inboxReviewPlannerMessage,isInboxReviewRoute,scopedInboxReviewState,scopedInboxReviewTools} from '../src/ai-review-scope.mjs';

test('inbox review scope sends only the target explicit Feishu todo and project directory summary',()=>{
  const state={
    inbox:[
      {id:'in-target',text:'给常金米业准备下周方案',source:'feishu_todo',feishuMode:'todo_only',feishuTodoKind:'native_todo',createdAt:'2026-08-16T01:00:00Z'},
      {id:'in-private',text:'不相关的敏感日记原文',source:'feishu_doc',feishuMode:'mixed_diary',createdAt:'2026-08-16T01:01:00Z'}
    ],
    projects:[
      {id:'p-1',name:'常金米业',intro:'不应发送的项目长介绍',businessId:'biz-ai',endDate:'2026-08-31',completed:false,archived:false},
      {id:'p-2',name:'已归档项目',businessId:'biz-ai',endDate:'2026-08-20',completed:true,archived:true}
    ],
    todos:[{id:'todo-secret',title:'不相关待办正文',dueDate:'2026-08-20',done:false}],todayPlan:['todo-secret'],confirmations:[{id:'confirm-secret',text:'不相关确认'}]
  };
  const route={view:'inbox-review',id:'in-target'};assert.equal(isInboxReviewRoute(route),true);
  const scoped=scopedInboxReviewState(state,route);
  assert.equal(scoped.inbox.length,1);
  assert.equal(scoped.inbox[0].id,'in-target');
  assert.equal(scoped.inbox[0].source,'feishu_todo');
  assert.match(scoped.inbox[0].text,/飞书明确待办/);
  assert.deepEqual(scoped.projects,[{id:'p-1',name:'常金米业',businessId:'biz-ai',endDate:'2026-08-31',completed:false,archived:false}]);
  assert.deepEqual(scoped.todos,[]);assert.deepEqual(scoped.todayPlan,[]);assert.deepEqual(scoped.confirmations,[]);
  const serialized=JSON.stringify(scoped);assert.equal(serialized.includes('不相关的敏感日记原文'),false);assert.equal(serialized.includes('不相关待办正文'),false);assert.equal(serialized.includes('不应发送的项目长介绍'),false);
});

test('explicit Feishu todo review never asks AI to extract tasks from diary prose',()=>{
  const state={inbox:[{id:'in-todo',text:'补发报价单',source:'feishu_todo',createdAt:'2026-08-16T02:00:00Z',feishuMode:'todo_only',feishuHeadingPath:['2026-08-16'],feishuTodoKind:'native_todo'}],projects:[],todos:[],todayPlan:[],confirmations:[]};
  const route={view:'inbox-review',id:'in-todo'};
  const prompt=inboxReviewPlannerMessage(state,route,'旧浏览器提示');
  assert.match(prompt,/已经由飞书来源明确标记为待办/);
  assert.match(prompt,/不要再判断它是不是待办/);
  assert.match(prompt,/不要从普通日记里提取新任务/);
  assert.match(prompt,/缺截止日期必须 clarification/);
  assert.equal(prompt.includes('旧浏览器提示'),false);
});

test('inbox review exposes only inbox_process and rejects diary extraction or cross-item plans',()=>{
  const tools=[{name:'inbox_search'},{name:'inbox_process'},{name:'diary_extract_todos'},{name:'todo_today'}];
  const route={view:'inbox-review',id:'in-target'};
  assert.deepEqual(scopedInboxReviewTools(tools,route).map(tool=>tool.name),['inbox_process']);
  assert.equal(enforceInboxReviewPlan({kind:'tool',toolName:'inbox_process',args:{itemId:'in-target',command:'创建独立待办，截止 2026-08-20'}},route).toolName,'inbox_process');
  const diary=enforceInboxReviewPlan({kind:'tool',toolName:'diary_extract_todos',args:{itemId:'in-target',candidates:[]}},route);assert.equal(diary.kind,'clarification');assert.equal(diary.toolName,null);
  const wrong=enforceInboxReviewPlan({kind:'tool',toolName:'inbox_process',args:{itemId:'in-other',command:'创建待办'}},route);assert.equal(wrong.kind,'clarification');assert.equal(wrong.toolName,null);
  const other=enforceInboxReviewPlan({kind:'tool',toolName:'todo_today',args:{todoId:'todo-1',add:true}},route);assert.equal(other.kind,'clarification');assert.equal(other.toolName,null);
});
