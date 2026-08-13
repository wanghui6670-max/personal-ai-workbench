import test from 'node:test';import assert from 'node:assert/strict';import fsp from 'node:fs/promises';import http from 'node:http';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';

async function waitFor(url,timeout=8000){const start=Date.now();while(Date.now()-start<timeout){try{const r=await fetch(url);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('server did not start');}
async function api(base,url,opts={}){const r=await fetch(base+url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});const data=await r.json().catch(()=>({}));return{r,data};}
async function exists(target){try{await fsp.access(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function serverEnv(overrides={}){return{...process.env,WORKBENCH_PASSWORD:'',SESSION_SECRET:'',CAPTURE_TOKEN:'',TRUSTED_ORIGINS:'',ALLOW_INSECURE_PUBLIC:'',COOKIE_SECURE:'',...overrides};}
function waitForExit(child,timeout=5000){return new Promise((resolve,reject)=>{let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('server did not exit'));},timeout);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr});});});}
function rawRequest({port,path='/',method='GET',headers={},body=''}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers},res=>{res.resume();res.once('end',()=>resolve(res));});req.once('error',reject);if(body)req.write(body);req.end();});}
function cleanupServer(t,tmp,child){t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}await fsp.rm(tmp,{recursive:true,force:true});});}

test('critical human-in-the-loop workflow',async(t)=>{
 const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-test-'));const data=path.join(tmp,'data'),workspace=path.join(tmp,'workspace');await fsp.mkdir(data,{recursive:true});await fsp.mkdir(workspace,{recursive:true});
 const port=43500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:''}),stdio:'ignore'});
 cleanupServer(t,tmp,child);await waitFor(base+'/api/health');
 const health=await api(base,'/api/health');assert.equal(health.data.workspaceRoot,workspace,'localhost health remains compatible');
 let x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'整理客户合同'})});assert.equal(x.r.status,201);const inboxId=x.data.item.id;
 x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:inboxId,command:'做成独立待办'})});assert.equal(x.data.needsFollowup,true);
 x=await api(base,'/api/state');assert.equal(x.data.inbox.length,1);assert.equal(x.data.todos.length,0);
 x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:inboxId,command:'做成独立待办，8月18日截止'})});assert.equal(x.data.todo.dueDate.endsWith('-08-18'),true);
 x=await api(base,'/api/state');assert.equal(x.data.todayTodos.length,0,'todo must not auto-enter today');const todoId=x.data.todos[0].id;
 x=await api(base,'/api/todos/today',{method:'POST',body:JSON.stringify({todoId,add:true})});assert.deepEqual(x.data.todayPlan,[todoId]);
 x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'开发一个客户订餐小程序'})});assert.equal(x.r.status,201);const projectInboxId=x.data.item.id;
 x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'开发一个客户订餐小程序',sourceInboxId:projectInboxId})});assert.equal(x.r.status,400,'project must require end date');
 x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'开发一个客户订餐小程序',endDate:'2026-02-30',sourceInboxId:projectInboxId})});assert.equal(x.r.status,400,'project end date must be a real date');
 x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'绕过收件箱的项目',endDate:'2026-08-30'})});assert.equal(x.r.status,400,'project cannot bypass inbox');
 x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'篡改后的项目描述',endDate:'2026-08-30',sourceInboxId:projectInboxId})});assert.equal(x.r.status,409,'project description must match its inbox source');
 x=await api(base,'/api/notes',{method:'POST',body:JSON.stringify({text:'绕过收件箱的备忘'})});assert.equal(x.r.status,409,'note cannot bypass inbox');
 x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'开发一个客户订餐小程序',endDate:'2026-08-30',sourceInboxId:projectInboxId,businessId:'biz_missing'})});assert.equal(x.r.status,400,'an invalid explicit business choice must fail instead of delegating classification to AI');
 x=await api(base,'/api/state');assert.equal(x.data.inbox.some(item=>item.id===projectInboxId),true,'invalid business choice must preserve the inbox source');
 x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'开发一个客户订餐小程序',endDate:'2026-08-30',sourceInboxId:projectInboxId})});assert.equal(x.r.status,201);assert.equal(x.data.unclassified,true,'without confident AI classification project stays unclassified');const pid=x.data.project.id;
 x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'重复提交',endDate:'2026-08-30',sourceInboxId:projectInboxId})});assert.equal(x.r.status,409,'an inbox item can create at most one project');
 x=await api(base,'/api/state');assert.equal(x.data.inbox.some(item=>item.id===projectInboxId),false,'project creation consumes its inbox source');assert.equal(x.data.projects.length,1);assert.equal(x.data.notes.length,0,'project creation must not create a duplicate note');
 x=await api(base,'/api/projects/'+pid+'/classify',{method:'POST',body:JSON.stringify({businessId:'biz_client'})});assert.equal(x.r.status,200);
 const expected=path.join(workspace,'03_客户项目',x.data.project.folder);const st=await fsp.stat(expected);assert.equal(st.isDirectory(),true);const md=await fsp.readFile(path.join(expected,'PROJECT.md'),'utf8');assert.match(md,/计划结束/);
});

test('unsafe startup exits before creating data or workspace directories',async t=>{
  const cases=[
    {name:'localhost password with blank session secret',env:{HOST:'127.0.0.1',PORT:'4173',WORKBENCH_PASSWORD:'enabled',SESSION_SECRET:''},error:/启用 WORKBENCH_PASSWORD 时 SESSION_SECRET 至少需要 24 个字符/},
    {name:'localhost password with default session secret',env:{HOST:'127.0.0.1',PORT:'4173',WORKBENCH_PASSWORD:'enabled',SESSION_SECRET:'local-dev-session-secret-change-me'},error:/启用 WORKBENCH_PASSWORD 时 SESSION_SECRET 至少需要 24 个字符/},
    {name:'public bind without password',env:{HOST:'0.0.0.0',PORT:'4173'},error:/未设置 WORKBENCH_PASSWORD/},
    {name:'public bind with short session secret',env:{HOST:'0.0.0.0',PORT:'4173',WORKBENCH_PASSWORD:'enabled',SESSION_SECRET:'too-short'},error:/SESSION_SECRET 至少需要 24 个字符/},
    {name:'public trusted origin without password',env:{HOST:'127.0.0.1',PORT:'4173',TRUSTED_ORIGINS:'https://workbench.example.com'},error:/未设置 WORKBENCH_PASSWORD/},
    {name:'public trusted origin with short session secret',env:{HOST:'127.0.0.1',PORT:'4173',TRUSTED_ORIGINS:'https://workbench.example.com',WORKBENCH_PASSWORD:'enabled',SESSION_SECRET:'too-short'},error:/SESSION_SECRET 至少需要 24 个字符/},
    {name:'invalid host',env:{HOST:'127.0.0.999',PORT:'4173'},error:/HOST 格式无效/},
    {name:'invalid port',env:{HOST:'127.0.0.1',PORT:'70000'},error:/PORT 必须是 1 到 65535/}
  ];
  for(const item of cases){
    const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-preflight-'));const data=path.join(tmp,'empty-data'),workspace=path.join(tmp,'empty-workspace');
    const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({...item.env,DATA_DIR:data,WORKSPACE_ROOT:workspace}),stdio:['ignore','ignore','pipe']});
    t.after(()=>fsp.rm(tmp,{recursive:true,force:true}));
    const result=await waitForExit(child);
    assert.equal(result.code,1,item.name);assert.match(result.stderr,item.error,item.name);
    assert.equal(await exists(data),false,`${item.name}: data directory must not be created`);
    assert.equal(await exists(workspace),false,`${item.name}: workspace directory must not be created`);
  }
});

test('public unauthenticated health is redacted and repeated login failures are throttled',async(t)=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-auth-'));const data=path.join(tmp,'data'),workspace=path.join(tmp,'workspace');
  const port=44500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({PORT:String(port),HOST:'0.0.0.0',DATA_DIR:data,WORKSPACE_ROOT:workspace,WORKBENCH_PASSWORD:'test-password',SESSION_SECRET:'test-session-secret-at-least-24-chars'}),stdio:'ignore'});
  cleanupServer(t,tmp,child);await waitFor(base+'/api/health');

  let x=await api(base,'/api/health');assert.equal('workspaceRoot' in x.data,false);
  x=await api(base,'/api/auth/login',{method:'POST',body:JSON.stringify({password:'test-password'})});assert.equal(x.r.status,200);
  const cookie=String(x.r.headers.get('set-cookie')||'').split(';')[0];
  x=await api(base,'/api/health',{headers:{Cookie:cookie}});assert.equal(x.data.workspaceRoot,workspace);
  x=await api(base,'/api/capture',{method:'POST',headers:{Cookie:cookie},body:JSON.stringify({text:'session-authorized-capture'})});assert.equal(x.r.status,201);

  for(let i=0;i<4;i++){x=await api(base,'/api/auth/login',{method:'POST',body:JSON.stringify({password:'wrong'})});assert.equal(x.r.status,401);}
  x=await api(base,'/api/auth/login',{method:'POST',body:JSON.stringify({password:'wrong'})});assert.equal(x.r.status,429);assert.equal(x.r.headers.has('retry-after'),true);
});

test('expensive endpoints return 429 after the configured per-client limit',async(t)=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-rate-limit-'));const data=path.join(tmp,'data'),workspace=path.join(tmp,'workspace');
  const port=45500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({
    PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:'',
    CAPTURE_TOKEN:'rate-limit-capture-token',WORKBENCH_CAPTURE_RATE_LIMIT:'1',WORKBENCH_SYNC_RATE_LIMIT:'1',WORKBENCH_MORNING_RATE_LIMIT:'1',WORKBENCH_RATE_LIMIT_WINDOW_MS:'10000'
  }),stdio:'ignore'});
  cleanupServer(t,tmp,child);await waitFor(base+'/api/health');

  for(const [endpoint,body,firstStatus] of [
    ['/api/capture',{text:'一次采集'},201],
    ['/api/projects/sync',{},200],
    ['/api/morning/chat',{message:'帮我看看今天'},200]
  ]){
    const headers={'Content-Type':'application/json',...(endpoint==='/api/capture'?{Authorization:'Bearer rate-limit-capture-token'}:{})};
    let x=await api(base,endpoint,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(x.r.status,firstStatus,endpoint);
    x=await api(base,endpoint,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(x.r.status,429,endpoint);assert.equal(x.r.headers.has('retry-after'),true,endpoint);
  }
});

test('request boundary rejects untrusted hosts, cross-site writes, and non-JSON mutations without changing state',async(t)=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-request-guard-'));const data=path.join(tmp,'data'),workspace=path.join(tmp,'workspace');
  const port=45500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:''}),stdio:'ignore'});
  cleanupServer(t,tmp,child);await waitFor(base+'/api/health');

  const before=await api(base,'/api/state');const inboxCount=before.data.inbox.length;
  let r=await fetch(base+'/api/inbox',{method:'POST',headers:{Host:`127.0.0.1:${port}`,'Content-Type':'application/json',Origin:'https://evil.example'},body:JSON.stringify({text:'evil-origin-must-not-write'})});
  assert.equal(r.status,403);assert.equal(r.headers.get('vary'),'Origin');
  let after=await api(base,'/api/state');assert.equal(after.data.inbox.length,inboxCount,'evil Origin must not mutate state');

  r=await rawRequest({port,path:'/api/health',headers:{Host:'evil.example'}});assert.equal(r.statusCode,421);
  r=await fetch(base+'/api/inbox',{method:'POST',headers:{'Content-Type':'text/plain'},body:'plain-text-must-not-write'});assert.equal(r.status,415);
  after=await api(base,'/api/state');assert.equal(after.data.inbox.length,inboxCount,'non-JSON body must not mutate state');

  r=await fetch(base+'/api/inbox',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({text:'trusted-local-write'})});
  assert.equal(r.status,201);after=await api(base,'/api/state');assert.equal(after.data.inbox.length,inboxCount+1,'trusted localhost JSON write should succeed');
});

test('capture requires a bearer token or an authenticated session even on localhost',async(t)=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-capture-guard-'));const data=path.join(tmp,'data'),workspace=path.join(tmp,'workspace');
  const port=46500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,CAPTURE_TOKEN:'test-capture-token',OPENAI_API_KEY:''}),stdio:'ignore'});
  cleanupServer(t,tmp,child);await waitFor(base+'/api/health');

  let x=await api(base,'/api/capture',{method:'POST',body:JSON.stringify({text:'unauthorized-capture'})});assert.equal(x.r.status,401);
  x=await api(base,'/api/capture',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-capture-token'},body:JSON.stringify({text:'authorized-capture'})});assert.equal(x.r.status,201);
  const state=await api(base,'/api/state');assert.equal(state.data.inbox.some(item=>item.text==='authorized-capture'),true);assert.equal(state.data.inbox.some(item=>item.text==='unauthorized-capture'),false);
});

test('capture is closed when neither a token nor password authentication is configured',async(t)=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-capture-closed-'));const data=path.join(tmp,'data'),workspace=path.join(tmp,'workspace');
  const port=47500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:''}),stdio:'ignore'});
  cleanupServer(t,tmp,child);await waitFor(base+'/api/health');

  let x=await api(base,'/api/capture',{method:'POST',body:JSON.stringify({text:'anonymous-capture'})});assert.equal(x.r.status,401);
  x=await api(base,'/api/state');assert.equal(x.data.inbox.some(item=>item.text==='anonymous-capture'),false);
});

test('ambiguous project commands wait for an explicit project choice',async t=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-project-choice-'));const data=path.join(tmp,'data'),workspace=path.join(tmp,'workspace');
  const port=48500+Math.floor(Math.random()*1000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve('.'),env:serverEnv({PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace,OPENAI_API_KEY:''}),stdio:'ignore'});
  cleanupServer(t,tmp,child);await waitFor(base+'/api/health');

  const projectIds=[];
  for(let index=0;index<2;index++){
    let x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'同名客户项目'})});
    x=await api(base,'/api/projects',{method:'POST',body:JSON.stringify({description:'同名客户项目',endDate:'2026-08-30',sourceInboxId:x.data.item.id})});
    assert.equal(x.r.status,201);projectIds.push(x.data.project.id);
  }
  let x=await api(base,'/api/inbox',{method:'POST',body:JSON.stringify({text:'准备项目交付'})});const inboxId=x.data.item.id;
  const command='放到同名客户项目做成待办，8月28日截止';
  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:inboxId,command})});
  assert.equal(x.data.needsProjectSelection,true);assert.equal(x.data.projectCandidates.length,2);
  assert.equal(new Set(x.data.projectCandidates.map(candidate=>candidate.folder)).size,2,'same-name choices must expose distinct folders');
  let current=await api(base,'/api/state');assert.equal(current.data.inbox.some(item=>item.id===inboxId),true);assert.equal(current.data.todos.length,0);assert.equal(current.data.confirmations.some(item=>item.type==='inbox_project_ambiguous'&&item.inboxId===inboxId),true);

  const unrelated=current.data.projects.find(project=>!projectIds.includes(project.id));
  if(unrelated){x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:inboxId,command,targetProjectId:unrelated.id})});assert.equal(x.r.status,409);}

  x=await api(base,'/api/inbox/command',{method:'POST',body:JSON.stringify({itemId:inboxId,command,targetProjectId:projectIds[1]})});
  assert.equal(x.r.status,200);assert.equal(x.data.todo.projectId,projectIds[1]);
  current=await api(base,'/api/state');assert.equal(current.data.inbox.some(item=>item.id===inboxId),false);assert.equal(current.data.confirmations.some(item=>item.inboxId===inboxId),false);
});
