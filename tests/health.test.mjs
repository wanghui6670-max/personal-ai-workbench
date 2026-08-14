import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PRODUCT_VERSION } from '../src/product.mjs';

function serverEnv(overrides={}){
  return{
    ...process.env,
    WORKBENCH_PASSWORD:'',SESSION_SECRET:'',CAPTURE_TOKEN:'',TRUSTED_ORIGINS:'',
    ALLOW_INSECURE_PUBLIC:'',COOKIE_SECURE:'',OPENAI_API_KEY:'',AI_PROVIDER_ENABLED:'',
    JOYCREW_ENABLED:'0',JOYCREW_TRUSTED_PROXY_TOKEN:'',JOYCREW_SESSION_TOKEN:'',
    ...overrides
  };
}

async function requestHealth(base){
  const response=await fetch(`${base}/api/health`);
  return{response,body:await response.json()};
}

async function requestJson(base,pathname,options={}){
  const response=await fetch(`${base}${pathname}`,{
    ...options,
    headers:{'Content-Type':'application/json',...(options.headers||{})}
  });
  return{response,body:await response.json()};
}

async function waitUntilHealthy(base,timeout=8_000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    try{const result=await requestHealth(base);if(result.response.status===200)return result;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('server did not become healthy');
}

async function startFixture(t,name){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),`workbench-health-${name}-`));
  const data=path.join(root,'data'),workspace=path.join(root,'workspace');
  const port=49_000+Math.floor(Math.random()*1_000),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:path.resolve('.'),
    env:serverEnv({PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,WORKSPACE_ROOT:workspace}),
    stdio:'ignore'
  });
  t.after(async()=>{child.kill('SIGTERM');await fsp.rm(root,{recursive:true,force:true});});
  const health=await waitUntilHealthy(base);
  return{root,data,workspace,base,health};
}

async function contentSnapshot(root){
  const entries=[];
  async function visit(target,relative='.'){
    const stat=await fsp.lstat(target);
    const item={path:relative,mode:stat.mode,size:stat.size,mtimeMs:stat.mtimeMs,type:'other'};
    if(stat.isDirectory()){
      item.type='directory';entries.push(item);
      const names=(await fsp.readdir(target)).sort();
      for(const name of names)await visit(path.join(target,name),relative==='.'?name:path.join(relative,name));
    }else if(stat.isFile()){
      item.type='file';item.sha256=crypto.createHash('sha256').update(await fsp.readFile(target)).digest('hex');entries.push(item);
    }else if(stat.isSymbolicLink()){
      item.type='symlink';item.target=await fsp.readlink(target);entries.push(item);
    }else entries.push(item);
  }
  await visit(root);
  return entries;
}

async function createAssignedProject(fixture){
  let result=await requestJson(fixture.base,'/api/inbox',{
    method:'POST',body:JSON.stringify({text:'readiness 项目'})
  });
  assert.equal(result.response.status,201);
  result=await requestJson(fixture.base,'/api/projects',{
    method:'POST',
    body:JSON.stringify({
      description:'readiness 项目',endDate:'2026-08-30',
      sourceInboxId:result.body.item.id,businessId:'biz_ai'
    })
  });
  assert.equal(result.response.status,201);
  return result.body.project;
}

test('health is a compatible read-only readiness response for the unified product',async t=>{
  const fixture=await startFixture(t,'ready');
  const {response,body}=fixture.health;
  assert.equal(response.status,200);
  assert.equal(body.ok,true);
  assert.equal(body.version,PRODUCT_VERSION);
  assert.equal(typeof body.time,'string');
  assert.equal(body.authEnabled,false);
  assert.equal(body.aiEnabled,false);
  assert.equal(body.joycrew.enabled,false);
  assert.equal(body.workspaceRoot,fixture.workspace);

  const before={data:await contentSnapshot(fixture.data),workspace:await contentSnapshot(fixture.workspace)};
  for(let index=0;index<3;index++)assert.equal((await requestHealth(fixture.base)).response.status,200);
  const after={data:await contentSnapshot(fixture.data),workspace:await contentSnapshot(fixture.workspace)};
  assert.deepEqual(after,before,'readiness must not change directory entries or file content/metadata');
});

test('corrupt state returns a generic non-leaking 503 response',async t=>{
  const fixture=await startFixture(t,'state');
  const sensitive=`sensitive-state-${fixture.root}`;
  await fsp.writeFile(path.join(fixture.data,'state.json'),`{"private":"${sensitive}"`,'utf8');

  const {response,body}=await requestHealth(fixture.base);
  assert.equal(response.status,503);
  assert.deepEqual(body,{ok:false,status:'not_ready'});
  const serialized=JSON.stringify(body);
  assert.equal(serialized.includes(fixture.root),false);
  assert.equal(serialized.includes(sensitive),false);
  assert.equal('error' in body,false);
});

test('missing workspace and a symlinked business directory are not ready',async t=>{
  await t.test('missing workspace',async t=>{
    const fixture=await startFixture(t,'missing-workspace');
    await fsp.rm(fixture.workspace,{recursive:true});
    const {response,body}=await requestHealth(fixture.base);
    assert.equal(response.status,503);assert.deepEqual(body,{ok:false,status:'not_ready'});
  });

  await t.test('symlinked business directory',async t=>{
    const fixture=await startFixture(t,'business-symlink');
    const outside=path.join(fixture.root,'outside');await fsp.mkdir(outside);
    const business=path.join(fixture.workspace,'01_动觉AI');
    await fsp.rmdir(business);await fsp.symlink(outside,business);
    const {response,body}=await requestHealth(fixture.base);
    assert.equal(response.status,503);assert.deepEqual(body,{ok:false,status:'not_ready'});
    assert.equal(JSON.stringify(body).includes(outside),false);
  });
});

test('classified project directories participate in strict readiness',async t=>{
  await t.test('an existing safe project remains ready',async t=>{
    const fixture=await startFixture(t,'project-ready');
    await createAssignedProject(fixture);
    const {response,body}=await requestHealth(fixture.base);
    assert.equal(response.status,200);assert.equal(body.ok,true);
  });

  await t.test('a missing project directory is not ready',async t=>{
    const fixture=await startFixture(t,'project-missing');
    const project=await createAssignedProject(fixture);
    await fsp.rm(path.join(fixture.workspace,'01_动觉AI',project.folder),{recursive:true});
    const {response,body}=await requestHealth(fixture.base);
    assert.equal(response.status,503);assert.deepEqual(body,{ok:false,status:'not_ready'});
  });

  await t.test('a symlinked project directory is not ready',async t=>{
    const fixture=await startFixture(t,'project-symlink');
    const project=await createAssignedProject(fixture);
    const projectDirectory=path.join(fixture.workspace,'01_动觉AI',project.folder);
    const outside=path.join(fixture.root,'outside-project');await fsp.mkdir(outside);
    await fsp.rm(projectDirectory,{recursive:true});await fsp.symlink(outside,projectDirectory);
    const {response,body}=await requestHealth(fixture.base);
    assert.equal(response.status,503);assert.deepEqual(body,{ok:false,status:'not_ready'});
  });

  await t.test('a traversal folder is generic not-ready and does not stop the server',async t=>{
    const fixture=await startFixture(t,'project-traversal');
    const project=await createAssignedProject(fixture);
    const stateFile=path.join(fixture.data,'state.json');
    const state=JSON.parse(await fsp.readFile(stateFile,'utf8'));
    state.projects.find(item=>item.id===project.id).folder='../../escape';
    await fsp.writeFile(stateFile,JSON.stringify(state,null,2),'utf8');

    let result=await requestHealth(fixture.base);
    assert.equal(result.response.status,503);assert.deepEqual(result.body,{ok:false,status:'not_ready'});
    assert.equal(JSON.stringify(result.body).includes(fixture.root),false);
    const derived=await requestJson(fixture.base,'/api/state');
    assert.equal(derived.response.status,500,'the invalid derived path is rejected without terminating the process');
    result=await requestHealth(fixture.base);
    assert.equal(result.response.status,503);assert.deepEqual(result.body,{ok:false,status:'not_ready'});
  });
});
