import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { createWorkbenchRegistry } from '../src/mcp/registry.mjs';
import { planProjectKnowledgeMessage } from '../src/mcp/project-knowledge-tools.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from '../src/harness-policy.mjs';

async function setup(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-mcp-knowledge-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  await store.updateState(state=>{
    state.projects.push({
      id:'p_knowledge',
      businessId:'biz_ai',
      name:'知识索引项目',
      intro:'本地 Git 与飞书指针盘点',
      folder:'knowledge-index',
      createdAt:'2026-08-13',
      startDate:'2026-08-13',
      endDate:'2026-08-31',
      git:'ssh://user:demo-token@example.invalid/knowledge.git?token=secret#fragment',
      feishu:'https://example.feishu.cn/wiki/knowledgeDoc',
      completed:false,
      archived:false,
      progress:{percent:40,status:'进行中',hasBlocker:true,lastActivity:null,syncedAt:null,confidence:.8}
    });
    state.todos.push({
      id:'td_knowledge',
      title:'补齐项目知识索引',
      context:'不要把飞书正文写入本地状态',
      projectId:'p_knowledge',
      dueDate:'2026-08-20',
      done:false
    });
    state.notes.push({
      id:'nt_knowledge',
      projectId:'p_knowledge',
      text:'这条备忘正文不得出现在 overview 或 search 结果里',
      createdAt:'2026-08-13T00:00:00.000Z'
    });
  });
  return {root,store};
}

test('registry exposes read-only project knowledge tools and keeps them on the navigator allowlist',async t=>{
  const {root,store}=await setup(t);
  const registry=createWorkbenchRegistry({appRoot:root,store});
  const tools=registry.list();
  const overview=tools.find(tool=>tool.name==='project_overview');
  const search=tools.find(tool=>tool.name==='project_knowledge_search');
  assert.equal(overview?.readOnly,true);
  assert.equal(overview?.requiresConfirmation,false);
  assert.equal(search?.readOnly,true);
  assert.equal(search?.requiresConfirmation,false);
  assert.equal(HARNESS_NAVIGATOR_TOOL_ALLOWLIST.includes('project_overview'),true);
  assert.equal(HARNESS_NAVIGATOR_TOOL_ALLOWLIST.includes('project_knowledge_search'),true);
  const exposed=registry.list({readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST}).map(tool=>tool.name);
  assert.equal(exposed.includes('project_overview'),true);
  assert.equal(exposed.includes('project_knowledge_search'),true);
});

test('project_overview returns pointer-only inventory and never echoes note or Feishu bodies',async t=>{
  const {root,store}=await setup(t);
  const registry=createWorkbenchRegistry({appRoot:root,store});
  const {result}=await registry.call('project_overview',{projectId:'p_knowledge'});
  assert.equal(result.projectId,'p_knowledge');
  assert.equal(result.name,'知识索引项目');
  assert.equal(result.progress.percent,40);
  assert.equal(result.progress.hasBlocker,true);
  assert.equal(result.todos.open,1);
  assert.equal(result.todos.done,0);
  assert.equal(result.assets.folder,true);
  assert.equal(result.assets.gitConfigured,true);
  assert.equal(result.assets.feishuBound,true);
  assert.equal(result.git.remote,'ssh://example.invalid/knowledge.git');
  assert.equal(result.feishu.bound,true);
  assert.equal(result.feishu.documentUrl,'https://example.feishu.cn/wiki/knowledgeDoc');
  assert.equal(result.notes.count,1);
  assert.equal(result.notes.text,undefined);
  assert.equal(result.records,undefined);
  const serialized=JSON.stringify(result);
  assert.equal(serialized.includes('这条备忘正文不得出现在 overview 或 search 结果里'),false);
  assert.equal(serialized.includes('不要把飞书正文写入本地状态'),false);
  assert.equal(serialized.includes('demo-token'),false);
  assert.equal(serialized.includes('token=secret'),false);
  await assert.rejects(
    registry.call('project_overview',{projectId:'p_missing'}),
    error=>error.statusCode===404
  );
});

test('project_knowledge_search matches local metadata chapters without reading Feishu bodies',async t=>{
  const {root,store}=await setup(t);
  const registry=createWorkbenchRegistry({appRoot:root,store});
  const {result}=await registry.call('project_knowledge_search',{projectId:'p_knowledge',query:'卡点'});
  assert.equal(result.projectId,'p_knowledge');
  assert.ok(Array.isArray(result.hits));
  assert.ok(result.hits.some(hit=>hit.chapter==='todos'));
  assert.equal(result.hits.every(hit=>typeof hit.snippet==='string'&&hit.snippet.length<=160),true);
  assert.equal(JSON.stringify(result).includes('这条备忘正文不得出现在 overview 或 search 结果里'),false);
  const gitHits=(await registry.call('project_knowledge_search',{projectId:'p_knowledge',query:'example.invalid'})).result.hits;
  assert.ok(gitHits.some(hit=>hit.chapter==='git'));
  const serialized=JSON.stringify(gitHits);
  assert.equal(serialized.includes('demo-token'),false);
  assert.equal(serialized.includes('token=secret'),false);
  await assert.rejects(
    registry.call('project_knowledge_search',{projectId:'p_knowledge',query:''}),
    error=>error.code==='MCP_INVALID_PARAMS'
  );
});

test('local planner maps inventory and knowledge-search intents before falling back to project_list',()=>{
  const state={projects:[{id:'p_knowledge',name:'知识索引项目'}]};
  const overview=planProjectKnowledgeMessage({message:'盘点一下知识索引项目',state});
  assert.equal(overview.toolName,'project_overview');
  assert.deepEqual(overview.args,{projectId:'p_knowledge'});
  const search=planProjectKnowledgeMessage({message:'搜索知识索引项目的卡点',state});
  assert.equal(search.toolName,'project_knowledge_search');
  assert.equal(search.args.projectId,'p_knowledge');
  assert.equal(search.args.query,'卡点');
});
