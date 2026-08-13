import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

async function waitFor(url,timeout=8000){const start=Date.now();while(Date.now()-start<timeout){try{const r=await fetch(url);if(r.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('server did not start');}
async function api(base,url,opts={}){const r=await fetch(base+url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});return{r,data:await r.json().catch(()=>({}))};}
function serverEnv(overrides={}){return{...process.env,WORKBENCH_PASSWORD:'',SESSION_SECRET:'',CAPTURE_TOKEN:'',TRUSTED_ORIGINS:'',ALLOW_INSECURE_PUBLIC:'',OPENAI_API_KEY:'',...overrides};}

async function startServer(t){
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-archive-date-'));
  const port=49500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({PORT:String(port),HOST:'127.0.0.1',DATA_DIR:path.join(tmp,'data'),WORKSPACE_ROOT:path.join(tmp,'workspace')}),stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}await fsp.rm(tmp,{recursive:true,force:true});});await waitFor(base+'/api/health');return base;
}

async function createProject(base,name){
  let x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:name})});
  return api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:name,endDate:'2099-08-30',sourceInboxId:x.data.item.id})});
}

test('archived projects do not receive or consume inbox commands',async t=>{
  const base=await startServer(t);
  let archived=await createProject(base,'同名归档项目');const archivedId=archived.data.project.id;
  let active=await createProject(base,'同名归档项目');const activeId=active.data.project.id;
  await api(base,`/api/projects/${archivedId}`,{method:'PATCH',body:JSON.stringify({archived:true})});

  let x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'只应进入活跃项目'})});const activeInbox=x.data.item.id;
  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:activeInbox,command:'放到同名归档项目做成待办，2099年8月28日截止'})});
  assert.equal(x.r.status,200);assert.equal(x.data.todo.projectId,activeId,'active project wins over same-name archived project');

  x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'不得进入归档项目'})});const archivedInbox=x.data.item.id;
  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:archivedInbox,command:'放到同名归档项目做成待办，2099年8月28日截止',targetProjectId:archivedId})});
  assert.equal(x.r.status,409);assert.match(x.data.error,/已归档/);
  const state=(await api(base,'/api/state')).data;
  assert.equal(state.inbox.some(item=>item.id===archivedInbox),true,'rejected archived target keeps inbox item');
  assert.equal(state.todos.some(todo=>todo.context==='不得进入归档项目'),false);
});

test('invalid dates and request types return 400 without mutating state',async t=>{
  const base=await startServer(t);
  let project=await createProject(base,'日期边界项目');const projectId=project.data.project.id;
  let x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'非法日期任务'})});const inboxId=x.data.item.id;

  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:inboxId,command:'放到日期边界项目做成待办，2099年2月30日截止'})});
  assert.equal(x.r.status,200);assert.equal(x.data.needsFollowup,true);
  let state=(await api(base,'/api/state')).data;assert.equal(state.inbox.some(item=>item.id===inboxId),true);assert.equal(state.todos.length,0);

  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:42,command:{bad:true}})});assert.equal(x.r.status,400);
  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify(null)});assert.equal(x.r.status,400);

  x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'有效待办'})});
  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:x.data.item.id,command:'做成独立待办，2099年8月20日截止'})});const todoId=x.data.todo.id;
  const mutations=[
    [`/api/todos/${todoId}`,{dueDate:'2099-02-30'}],
    [`/api/todos/${todoId}`,{dueDate:''}],
    [`/api/todos/${todoId}`,{dueDate:null}],
    [`/api/todos/${todoId}`,{done:'true'}],
    [`/api/todos/${todoId}`,[]],
    [`/api/projects/${projectId}`,{endDate:'2099-02-30'}],
    [`/api/projects/${projectId}`,{endDate:''}],
    [`/api/projects/${projectId}`,{completed:'true'}],
    [`/api/projects/${projectId}`,{intro:42}],
    [`/api/projects/${projectId}`,{}]
  ];
  for(const [url,body] of mutations){x=await api(base,url,{method:'PATCH',body:JSON.stringify(body)});assert.equal(x.r.status,400,`${url} ${JSON.stringify(body)}`);}
  x=await api(base,'/api/todos/today',{method:'POST',body:JSON.stringify({todoId,add:'true'})});assert.equal(x.r.status,400);

  state=(await api(base,'/api/state')).data;
  assert.equal(state.todos.find(todo=>todo.id===todoId).dueDate,'2099-08-20');
  assert.equal(state.projects.find(item=>item.id===projectId).endDate,'2099-08-30');
  assert.equal(state.projects.find(item=>item.id===projectId).completed,false);
  assert.equal(state.todayPlan.includes(todoId),false);
});
