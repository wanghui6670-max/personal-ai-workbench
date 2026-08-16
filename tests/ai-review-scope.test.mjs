import test from 'node:test';
import assert from 'node:assert/strict';
import {enforceInboxReviewPlan,isInboxReviewRoute,scopedInboxReviewState,scopedInboxReviewTools} from '../src/ai-review-scope.mjs';

test('inbox review scope sends only the target Inbox item and project directory summary',()=>{
  const state={
    inbox:[
      {id:'in-target',text:'给常金米业准备下周方案',source:'feishu_doc',createdAt:'2026-08-16T01:00:00Z'},
      {id:'in-private',text:'不相关的敏感收件箱原文',source:'feishu_doc',createdAt:'2026-08-16T01:01:00Z'}
    ],
    projects:[
      {id:'p-1',name:'常金米业',intro:'不应发送的项目长介绍',businessId:'biz-ai',endDate:'2026-08-31',completed:false,archived:false},
      {id:'p-2',name:'已归档项目',businessId:'biz-ai',endDate:'2026-08-20',completed:true,archived:true}
    ],
    todos:[{id:'todo-secret',title:'不相关待办正文',dueDate:'2026-08-20',done:false}],
    todayPlan:['todo-secret'],
    confirmations:[{id:'confirm-secret',text:'不相关确认'}]
  };
  const route={view:'inbox-review',id:'in-target'};
  assert.equal(isInboxReviewRoute(route),true);
  const scoped=scopedInboxReviewState(state,route);
  assert.deepEqual(scoped.inbox,[{id:'in-target',text:'给常金米业准备下周方案',source:'feishu_doc',createdAt:'2026-08-16T01:00:00Z'}]);
  assert.deepEqual(scoped.projects,[{id:'p-1',name:'常金米业',businessId:'biz-ai',endDate:'2026-08-31',completed:false,archived:false}]);
  assert.deepEqual(scoped.todos,[]);
  assert.deepEqual(scoped.todayPlan,[]);
  assert.deepEqual(scoped.confirmations,[]);
  const serialized=JSON.stringify(scoped);
  assert.equal(serialized.includes('不相关的敏感收件箱原文'),false);
  assert.equal(serialized.includes('不相关待办正文'),false);
  assert.equal(serialized.includes('不应发送的项目长介绍'),false);
});

test('inbox review exposes only inbox_process and rejects cross-item plans',()=>{
  const tools=[{name:'inbox_search'},{name:'inbox_process'},{name:'todo_today'}];
  const route={view:'inbox-review',id:'in-target'};
  assert.deepEqual(scopedInboxReviewTools(tools,route).map(tool=>tool.name),['inbox_process']);
  assert.equal(enforceInboxReviewPlan({kind:'tool',toolName:'inbox_process',args:{itemId:'in-target',command:'只是备忘'}},route).toolName,'inbox_process');
  const wrong=enforceInboxReviewPlan({kind:'tool',toolName:'inbox_process',args:{itemId:'in-other',command:'删除'}},route);
  assert.equal(wrong.kind,'clarification');
  assert.equal(wrong.toolName,null);
  const other=enforceInboxReviewPlan({kind:'tool',toolName:'todo_today',args:{todoId:'todo-1',add:true}},route);
  assert.equal(other.kind,'clarification');
  assert.equal(other.toolName,null);
});
