import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { syncProject } from '../src/domain.mjs';
import { walkProjectFiles,projectScanBudget,ensureProjectDir,projectPath,SCAN_CAPS } from '../src/projects.mjs';

test('project walk stops at directory and depth budgets',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-scan-budget-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  await fsp.mkdir(path.join(root,'a','b'),{recursive:true});await fsp.mkdir(path.join(root,'c'),{recursive:true});
  await fsp.writeFile(path.join(root,'root.txt'),'root');await fsp.writeFile(path.join(root,'a','b','deep.txt'),'deep');

  const depthLimited=await walkProjectFiles(root,{maxFiles:20,maxDirectories:20,maxDepth:1,maxDurationMs:5_000});
  assert.equal(depthLimited.scan.complete,false);assert.ok(depthLimited.scan.reasons.includes('max_depth'));
  assert.equal(depthLimited.files.some(file=>file.path.endsWith('deep.txt')),false);

  const directoryLimited=await walkProjectFiles(root,{maxFiles:20,maxDirectories:1,maxDepth:10,maxDurationMs:5_000});
  assert.equal(directoryLimited.scan.complete,false);assert.ok(directoryLimited.scan.reasons.includes('max_directories'));
  assert.equal(directoryLimited.scan.directoriesVisited,1);
});

test('project walk duration budget is deterministic and configuration is capped',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-scan-duration-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  await fsp.writeFile(path.join(root,'one.txt'),'1');await fsp.writeFile(path.join(root,'two.txt'),'2');
  let time=0;
  const result=await walkProjectFiles(root,{maxFiles:20,maxDirectories:20,maxDepth:10,maxDurationMs:3,now:()=>time++});
  assert.equal(result.scan.complete,false);assert.ok(result.scan.reasons.includes('max_duration'));

  const config=projectScanBudget({WORKBENCH_SCAN_MAX_FILES:'999999',WORKBENCH_SCAN_MAX_DIRECTORIES:'999999',WORKBENCH_SCAN_MAX_DEPTH:'999999',WORKBENCH_SCAN_MAX_DURATION_MS:'999999'});
  assert.deepEqual(config,SCAN_CAPS);
});

test('an exhausted scan budget becomes low confidence and a visible confirmation without persisting narrative',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-scan-confirmation-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app'),store=new JsonStore(path.join(appRoot,'data'));await store.ensure();
  const config=await store.readConfig();
  const project={
    id:'p_scan_budget',businessId:'biz_client',name:'扫描预算项目',intro:'验证扫描预算',folder:'扫描预算项目',
    createdAt:'2026-08-12',startDate:'2026-08-12',endDate:'2026-08-30',git:'',feishu:'',completed:false,archived:false,
    progress:{percent:0,status:'未启动',summary:'尚未同步',resume:'尚未同步',blocker:'暂无明确卡点。',lastActivity:null,confidence:.9,syncedAt:null}
  };
  const dir=await ensureProjectDir(appRoot,config,project);
  await fsp.mkdir(path.join(dir,'01_原始资料','超过深度'),{recursive:true});
  await fsp.writeFile(path.join(dir,'01_原始资料','超过深度','evidence.txt'),'evidence');
  await store.updateState(state=>{state.projects.push(project);});

  const previous={depth:process.env.WORKBENCH_SCAN_MAX_DEPTH,key:process.env.OPENAI_API_KEY};
  process.env.WORKBENCH_SCAN_MAX_DEPTH='1';delete process.env.OPENAI_API_KEY;
  t.after(()=>{
    if(previous.depth===undefined)delete process.env.WORKBENCH_SCAN_MAX_DEPTH;else process.env.WORKBENCH_SCAN_MAX_DEPTH=previous.depth;
    if(previous.key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous.key;
  });
  const analysis=await syncProject({appRoot,store,projectId:project.id});
  const state=await store.readState(),updated=state.projects.find(item=>item.id===project.id);

  assert.equal(analysis.scan.complete,false);assert.ok(analysis.scan.reasons.includes('max_depth'));
  assert.ok(analysis.progress.confidence<=.35);assert.match(analysis.progress.summary,/部分证据/);
  assert.ok(updated.progress.confidence<=.35);assert.equal(updated.progress.hasBlocker,true);
  assert.equal('summary' in updated.progress,false);assert.equal('blocker' in updated.progress,false);
  assert.equal(state.confirmations.some(item=>item.type==='progress_unclear'&&item.projectId===project.id),true);
  assert.equal(projectPath(appRoot,config,project),dir);
});
