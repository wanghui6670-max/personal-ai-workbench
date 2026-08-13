import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { createBusiness, deleteBusiness, renameBusiness, updateWorkbenchConfig } from '../src/domain.mjs';
import { ensureBusinessDirs } from '../src/projects.mjs';

delete process.env.WORKSPACE_ROOT;
process.env.OPENAI_API_KEY='';

async function exists(target){
  try{await fsp.lstat(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}
}

async function fixture(t,{ensureDirs=false}={}){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-config-fs-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app'),data=path.join(appRoot,'data');
  const store=new JsonStore(data);await store.ensure();
  const config=await store.readConfig();
  if(ensureDirs)await ensureBusinessDirs(appRoot,config);
  return{root,appRoot,store,config,workspace:path.join(appRoot,'workspace')};
}

function failConfigWrite(store,predicate,message='simulated config write failure'){
  const original=store._atomicWrite.bind(store);
  store._atomicWrite=async(file,data)=>{
    if(file===store.configFile&&predicate(data))throw new Error(message);
    return original(file,data);
  };
}

test('workspace config directory-preparation failure leaves config and pre-existing files unchanged',async t=>{
  const {root,appRoot,store,config}=await fixture(t);
  const target=path.join(root,'blocked-workspace');await fsp.mkdir(target);
  const conflict=path.join(target,'03_客户项目');await fsp.writeFile(conflict,'keep','utf8');

  await assert.rejects(updateWorkbenchConfig({appRoot,store,workspaceRoot:target}),/不是目录/);

  assert.deepEqual(await store.readConfig(),config);
  assert.equal(await fsp.readFile(conflict,'utf8'),'keep');
  assert.equal(await exists(path.join(target,'01_动觉AI')),false);
  assert.equal(await exists(path.join(target,'02_实体门店')),false);
});

test('workspace config write failure rolls back only directories created by the request',async t=>{
  const {root,appRoot,store,config}=await fixture(t);
  const target=path.join(root,'new-workspace');
  failConfigWrite(store,data=>data.workspaceRoot===target);

  await assert.rejects(updateWorkbenchConfig({appRoot,store,workspaceRoot:target}),/simulated config write failure/);

  assert.deepEqual(await store.readConfig(),config);
  assert.equal(await exists(target),false);
});

test('workspace config rejects a symlink root without persisting it or touching its target',async t=>{
  const {root,appRoot,store,config}=await fixture(t);
  const target=path.join(root,'real-workspace'),link=path.join(root,'workspace-link');
  await fsp.mkdir(target);await fsp.symlink(target,link);

  await assert.rejects(updateWorkbenchConfig({appRoot,store,workspaceRoot:link}),/根路径不能是符号链接/);

  assert.deepEqual(await store.readConfig(),config);
  assert.deepEqual(await fsp.readdir(target),[]);
});

test('createBusiness config write failure rolls back its new directory and preserves existing directories',async t=>{
  const {appRoot,store,config,workspace}=await fixture(t,{ensureDirs:true});
  const existing=path.join(workspace,config.businesses[0].folder),marker=path.join(existing,'keep.txt');
  await fsp.writeFile(marker,'keep','utf8');
  failConfigWrite(store,data=>data.businesses.some(b=>b.name==='新板块'));

  await assert.rejects(createBusiness({appRoot,store,name:'新板块'}),/simulated config write failure/);

  assert.deepEqual(await store.readConfig(),config);
  assert.equal(await exists(path.join(workspace,'05_新板块')),false);
  assert.equal(await fsp.readFile(marker,'utf8'),'keep');
});

test('createBusiness refuses to adopt an existing real directory',async t=>{
  const {appRoot,store,config,workspace}=await fixture(t,{ensureDirs:true});
  const candidate=path.join(workspace,'05_新板块'),marker=path.join(candidate,'keep.txt');
  await fsp.mkdir(candidate);await fsp.writeFile(marker,'keep','utf8');

  await assert.rejects(createBusiness({appRoot,store,name:'新板块'}),/目录已存在/);

  assert.deepEqual(await store.readConfig(),config);
  assert.equal(await fsp.readFile(marker,'utf8'),'keep');
});

test('renameBusiness config write failure restores the original directory without touching its files',async t=>{
  const {appRoot,store,config,workspace}=await fixture(t,{ensureDirs:true});
  const business=config.businesses[0],oldPath=path.join(workspace,business.folder),newPath=path.join(workspace,'01_新名称');
  const marker=path.join(oldPath,'keep.txt');await fsp.writeFile(marker,'keep','utf8');
  failConfigWrite(store,data=>data.businesses.some(b=>b.id===business.id&&b.folder==='01_新名称'));

  await assert.rejects(renameBusiness({appRoot,store,businessId:business.id,name:'新名称'}),/simulated config write failure/);

  assert.deepEqual(await store.readConfig(),config);
  assert.equal(await fsp.readFile(marker,'utf8'),'keep');
  assert.equal(await exists(newPath),false);
});

test('renameBusiness destination conflict leaves config and both real directories unchanged',async t=>{
  const {appRoot,store,config,workspace}=await fixture(t,{ensureDirs:true});
  const business=config.businesses[0],oldPath=path.join(workspace,business.folder),newPath=path.join(workspace,'01_新名称');
  const oldMarker=path.join(oldPath,'old.txt'),newMarker=path.join(newPath,'new.txt');
  await fsp.writeFile(oldMarker,'old','utf8');await fsp.mkdir(newPath);await fsp.writeFile(newMarker,'new','utf8');

  await assert.rejects(renameBusiness({appRoot,store,businessId:business.id,name:'新名称'}),/目录已存在/);

  assert.deepEqual(await store.readConfig(),config);
  assert.equal(await fsp.readFile(oldMarker,'utf8'),'old');
  assert.equal(await fsp.readFile(newMarker,'utf8'),'new');
});

test('renameBusiness rejects a retargetable workspace symlink and never moves either target',async t=>{
  const {root,appRoot,store,config}=await fixture(t);
  const first=path.join(root,'first'),second=path.join(root,'second'),link=path.join(root,'workspace-link');
  await fsp.mkdir(first);await fsp.mkdir(second);
  for(const target of [first,second]){
    await fsp.mkdir(path.join(target,config.businesses[0].folder));
    await fsp.writeFile(path.join(target,config.businesses[0].folder,'keep.txt'),path.basename(target),'utf8');
  }
  await fsp.symlink(first,link);
  await store.writeConfig({...config,workspaceRoot:link});
  await fsp.unlink(link);await fsp.symlink(second,link);

  await assert.rejects(renameBusiness({appRoot,store,businessId:config.businesses[0].id,name:'新名称'}),/根路径不能是符号链接/);

  assert.equal(await fsp.readFile(path.join(first,config.businesses[0].folder,'keep.txt'),'utf8'),'first');
  assert.equal(await fsp.readFile(path.join(second,config.businesses[0].folder,'keep.txt'),'utf8'),'second');
  assert.equal(await exists(path.join(first,'01_新名称')),false);
  assert.equal(await exists(path.join(second,'01_新名称')),false);
});

test('deleteBusiness config write failure leaves both config and real directory unchanged',async t=>{
  const {store,config,workspace}=await fixture(t,{ensureDirs:true});
  const business=config.businesses[0],directory=path.join(workspace,business.folder),marker=path.join(directory,'keep.txt');
  await fsp.writeFile(marker,'keep','utf8');
  failConfigWrite(store,data=>!data.businesses.some(b=>b.id===business.id));

  await assert.rejects(deleteBusiness({store,businessId:business.id}),/simulated config write failure/);

  assert.deepEqual(await store.readConfig(),config);
  assert.equal(await fsp.readFile(marker,'utf8'),'keep');
});

test('deleteBusiness removes only configuration and deliberately preserves the real directory',async t=>{
  const {store,config,workspace}=await fixture(t,{ensureDirs:true});
  const business=config.businesses[0],directory=path.join(workspace,business.folder),marker=path.join(directory,'keep.txt');
  await fsp.writeFile(marker,'keep','utf8');

  await deleteBusiness({store,businessId:business.id});

  assert.equal((await store.readConfig()).businesses.some(b=>b.id===business.id),false);
  assert.equal(await fsp.readFile(marker,'utf8'),'keep');
});

test('config validation rejects unsafe or ambiguous business directory mappings before persistence',async t=>{
  const {store,config}=await fixture(t);
  for(const businesses of [
    [{...config.businesses[0],folder:'../outside'}],
    [{...config.businesses[0],folder:'.'}],
    [config.businesses[0],{...config.businesses[1],id:config.businesses[0].id}],
    [config.businesses[0],{...config.businesses[1],folder:config.businesses[0].folder}]
  ]){
    await assert.rejects(store.writeConfig({...config,businesses}),/无效工作台配置/);
    assert.deepEqual(await store.readConfig(),config);
  }
});
