import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import {
  syncProject,
  updateProject,
  readProjectRecords,
  createProject,
  assignProjectBusiness
} from '../src/domain.mjs';
import { createWorkbenchRegistry } from '../src/mcp/registry.mjs';
import { prepareIdentityProjectDir } from '../src/project-directory.mjs';
import {
  projectIdentityBlock,
  migrateProjectIdentity
} from '../src/project-identity.mjs';
import {
  normalizeFeishuProjectDocumentUrl,
  PROJECT_RECORD_READ_MAX
} from '../src/project-record-contract.mjs';
import { withProjectSyncLease } from '../src/project-sync-coordinator.mjs';

const PROJECT_ROOT=path.resolve('.');

function emptyState(overrides={}){
  return {
    schemaVersion:1,
    inbox:[],
    todos:[],
    todayPlan:[],
    todayPlanDate:null,
    projects:[],
    confirmations:[],
    notes:[],
    activities:[],
    morningSessions:[],
    ...overrides
  };
}

function machineProgress(overrides={}){
  return {
    percent:20,
    status:'进行中',
    hasBlocker:false,
    lastActivity:'2026-08-13T01:00:00.000Z',
    syncedAt:'2026-08-13T02:00:00.000Z',
    confidence:.8,
    ...overrides
  };
}

function project(overrides={}){
  return {
    id:'p_integrity',
    businessId:'biz_ai',
    name:'完整性项目',
    intro:'验证飞书唯一叙事真源',
    folder:'integrity-project',
    createdAt:'2026-08-13',
    startDate:'2026-08-13',
    endDate:'2026-08-31',
    git:'',
    feishu:'https://example.feishu.cn/wiki/project',
    completed:false,
    archived:false,
    progress:machineProgress(),
    ...overrides
  };
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-record-integrity-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app');
  const store=new JsonStore(path.join(appRoot,'data'));
  await store.ensure();
  return {root,appRoot,store,config:await store.readConfig()};
}

function withoutOpenAi(t){
  const previous=process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(()=>{
    if(previous===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previous;
  });
}

test('startup migration creates an immutable raw snapshot before stripping legacy narrative',async t=>{
  const {store}=await fixture(t);
  const legacyProject=project({
    businessId:null,
    folder:'',
    feishu:'',
    progress:{
      percent:41,
      status:'进行中',
      summary:'升级前唯一分析正文',
      resume:'升级前恢复摘要',
      blocker:'升级前卡点',
      lastActivity:null,
      syncedAt:'2026-08-12T01:00:00.000Z',
      confidence:.7
    }
  });
  const raw=emptyState({
    projects:[legacyProject],
    activities:[{at:'2026-08-12T01:00:00.000Z',type:'project_synced',projectId:legacyProject.id,text:'同步：升级前唯一分析正文'}]
  });
  await fsp.writeFile(store.stateFile,JSON.stringify(raw,null,2),'utf8');

  await store.ensure();

  const snapshotPath=path.join(store.migrationDir,'pre-narrative-v1-startup.json');
  const snapshotText=await fsp.readFile(snapshotPath,'utf8');
  assert.match(snapshotText,/升级前唯一分析正文/);
  const state=await store.readState();
  assert.equal('summary' in state.projects[0].progress,false);
  assert.equal('resume' in state.projects[0].progress,false);
  assert.equal('blocker' in state.projects[0].progress,false);
  assert.equal(
    state.confirmations.some(item=>
      item.type==='legacy_project_narrative_pending'&&item.projectId===legacyProject.id
    ),
    true
  );

  const before=await fsp.readFile(snapshotPath,'utf8');
  await store.ensure();
  const after=await fsp.readFile(snapshotPath,'utf8');
  assert.equal(after,before);
});

test('restoring a valid legacy backup archives its raw narrative before normalized restore',async t=>{
  const {store}=await fixture(t);
  const legacyProject=project({
    businessId:null,
    folder:'',
    feishu:'',
    progress:{
      percent:33,
      status:'进行中',
      summary:'恢复文件里的原始分析',
      resume:'恢复文件里的摘要',
      blocker:'恢复文件里的卡点',
      lastActivity:null,
      syncedAt:null,
      confidence:.6
    }
  });
  await store.restore({state:emptyState({projects:[legacyProject]})});
  const names=await fsp.readdir(store.migrationDir);
  const restoreName=names.find(name=>name.startsWith('pre-narrative-v1-restore-'));
  assert.ok(restoreName);
  assert.match(
    await fsp.readFile(path.join(store.migrationDir,restoreName),'utf8'),
    /恢复文件里的原始分析/
  );
  const state=await store.readState();
  assert.equal('summary' in state.projects[0].progress,false);
});

test('PROJECT.md migration is dry-run first, backs up legacy managed content, and is idempotent',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-project-md-migration-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const p=project();
  const legacy=`用户自定义说明\n<!-- personal-ai-workbench:managed:start -->\n<!-- personal-ai-workbench:project-id:${p.id} -->\n# ${p.name}\n\n## 当前进度\n\n- 进度说明：旧本地分析正文\n- 当前卡点：旧本地卡点\n- 上下文恢复：旧本地恢复摘要\n<!-- personal-ai-workbench:managed:end -->\n`;
  await fsp.writeFile(path.join(root,'PROJECT.md'),legacy,'utf8');

  const dry=await migrateProjectIdentity(root,p,{businessName:'动觉 AI',dryRun:true});
  assert.equal(dry.status,'legacy');
  assert.equal(dry.applied,false);
  assert.equal(await fsp.readFile(path.join(root,'PROJECT.md'),'utf8'),legacy);

  const applied=await migrateProjectIdentity(root,p,{businessName:'动觉 AI',dryRun:false});
  assert.equal(applied.status,'migrated');
  assert.equal(applied.applied,true);
  assert.equal(await fsp.readFile(applied.backup,'utf8'),legacy);
  const current=await fsp.readFile(path.join(root,'PROJECT.md'),'utf8');
  assert.match(current,/分析与总结真源：飞书云文档/);
  assert.doesNotMatch(current,/旧本地分析正文|旧本地卡点|旧本地恢复摘要/);
  assert.match(current,/用户自定义说明/);

  const replay=await migrateProjectIdentity(root,p,{businessName:'动觉 AI',dryRun:false});
  assert.equal(replay.status,'current');
  assert.equal(replay.applied,false);
});

test('Feishu project URL is official HTTPS only and rebinding clears every old pointer atomically',async t=>{
  assert.equal(
    normalizeFeishuProjectDocumentUrl('https://example.feishu.cn/wiki/project'),
    'https://example.feishu.cn/wiki/project'
  );
  for(const invalid of [
    'http://example.feishu.cn/wiki/project',
    'https://example.com/wiki/project',
    'https://user:pass@example.feishu.cn/wiki/project',
    'https://example.feishu.cn/wiki/project?token=secret'
  ]){
    assert.throws(()=>normalizeFeishuProjectDocumentUrl(invalid));
  }

  const {appRoot,store}=await fixture(t);
  const p=project({
    businessId:null,
    folder:'',
    progress:machineProgress({
      feishuRevisionId:'8',
      feishuRecordBlockId:'old_block',
      feishuRecordedAt:'2026-08-13T02:00:00.000Z',
      feishuOperationId:'pa_old'
    })
  });
  await store.updateState(state=>{state.projects.push(p);});
  const changed=await updateProject({
    appRoot,
    store,
    projectId:p.id,
    patch:{feishu:'https://new.feishu.cn/wiki/new_project'}
  });
  assert.equal(changed.feishu,'https://new.feishu.cn/wiki/new_project');
  for(const field of [
    'feishuRevisionId',
    'feishuRecordBlockId',
    'feishuRecordedAt',
    'feishuOperationId'
  ]){
    assert.equal(Object.hasOwn(changed.progress,field),false);
  }
  await assert.rejects(
    updateProject({appRoot,store,projectId:p.id,patch:{feishu:'https://example.com/wiki/no'}}),
    /官方飞书/
  );
});

test('remote-saved/local-failed project sync retains a receipt and retries without duplicate Feishu write',async t=>{
  withoutOpenAi(t);
  const {appRoot,store,config}=await fixture(t);
  const p=project();
  await prepareIdentityProjectDir(appRoot,config,p,{businessName:'动觉 AI'});
  await fsp.writeFile(
    path.join(appRoot,'workspace','01_动觉AI',p.folder,'02_工作过程','work.txt'),
    '真实工作证据',
    'utf8'
  );
  await store.updateState(state=>{state.projects.push(p);});

  const records=new Map();
  let remoteWrites=0;
  const client={
    appendAnalysis:async(_url,_text,{operationId})=>{
      if(records.has(operationId))return {...records.get(operationId),replayed:true};
      remoteWrites+=1;
      const result={revisionId:'7',item:{blockId:'analysis_7',operationId},replayed:false};
      records.set(operationId,result);
      return result;
    }
  };

  const originalUpdate=store.updateState.bind(store);
  let failCommit=true;
  store.updateState=async mutator=>{
    if(failCommit){
      failCommit=false;
      throw Object.assign(new Error('injected local commit failure'),{code:'INJECTED'});
    }
    return originalUpdate(mutator);
  };

  let firstError;
  try{
    await syncProject({appRoot,store,projectId:p.id,projectRecordClient:client});
  }catch(error){firstError=error;}
  assert.equal(firstError?.code,'PROJECT_RECORD_REMOTE_SAVED_LOCAL_PENDING');
  assert.equal(remoteWrites,1);
  const pending=await store.listProjectRecordReceipts();
  assert.equal(pending.length,1);
  assert.equal(pending[0].phase,'remote_saved_local_pending');
  assert.equal(
    (await store.readState()).confirmations.some(item=>
      item.type==='project_record_recovery_pending'&&item.operationId===pending[0].operationId
    ),
    true
  );

  const retried=await syncProject({appRoot,store,projectId:p.id,projectRecordClient:client});
  assert.equal(retried.record.replayed,true);
  assert.equal(remoteWrites,1);
  assert.equal((await store.listProjectRecordReceipts()).length,0);
  const state=await store.readState();
  assert.equal(state.projects[0].progress.feishuRecordBlockId,'analysis_7');
  assert.equal(state.confirmations.some(item=>item.type==='project_record_recovery_pending'),false);
});

test('MCP and every other caller share the same domain-level project sync lease',async t=>{
  const {appRoot,store}=await fixture(t);
  const p=project({businessId:null,folder:'',feishu:''});
  await store.updateState(state=>{state.projects.push(p);});
  const registry=createWorkbenchRegistry({appRoot,store});

  let release;
  let enteredResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const held=withProjectSyncLease(p.id,async()=>{
    enteredResolve();
    await new Promise(resolve=>{release=resolve;});
  });
  await entered;

  await assert.rejects(
    registry.call('project_sync',{projectId:p.id},{confirmed:true}),
    error=>error.code==='PROJECT_SYNC_BUSY'
  );
  await assert.rejects(
    registry.call('projects_sync_all',{}, {confirmed:true}),
    error=>error.code==='PROJECT_SYNC_BUSY'
  );

  release();
  await held;
});

test('project record reads are latest-first, bounded, and cursor-paginated',async t=>{
  const {store}=await fixture(t);
  const p=project({businessId:null,folder:''});
  await store.updateState(state=>{state.projects.push(p);});
  const items=Array.from({length:PROJECT_RECORD_READ_MAX+5},(_,index)=>({
    blockId:`b_${index+1}`,
    kind:index%2?'summary':'analysis',
    operationId:`op_${index+1}`,
    text:`record ${index+1}`
  }));
  const client={fetch:async()=>({revisionId:'99',items})};

  const first=await readProjectRecords({store,projectId:p.id,limit:2,projectRecordClient:client});
  assert.deepEqual(first.records.map(item=>item.blockId),['b_105','b_104']);
  assert.equal(first.nextCursor,'b_104');

  const second=await readProjectRecords({
    store,
    projectId:p.id,
    limit:2,
    beforeBlockId:first.nextCursor,
    projectRecordClient:client
  });
  assert.deepEqual(second.records.map(item=>item.blockId),['b_103','b_102']);

  const capped=await readProjectRecords({
    store,
    projectId:p.id,
    limit:10_000,
    projectRecordClient:client
  });
  assert.equal(capped.records.length,PROJECT_RECORD_READ_MAX);
});

test('project creation and later classification write identity-only PROJECT.md from the first byte',async t=>{
  withoutOpenAi(t);
  const {appRoot,store,config}=await fixture(t);
  const source={id:'in_create',text:'创建一个身份索引项目',source:'manual',createdAt:'2026-08-13T01:00:00.000Z'};
  await store.updateState(state=>{state.inbox.push(source);});
  const created=await createProject({
    appRoot,
    store,
    description:source.text,
    endDate:'2026-08-31',
    businessId:'biz_ai',
    sourceInboxId:source.id
  });
  const createdMd=await fsp.readFile(
    path.join(appRoot,'workspace',config.businesses[0].folder,created.project.folder,'PROJECT.md'),
    'utf8'
  );
  assert.match(createdMd,/分析与总结真源：飞书云文档/);
  assert.doesNotMatch(createdMd,/进度说明|当前卡点|上下文恢复|最近同步/);

  const unclassifiedSource={id:'in_classify',text:'稍后归类的项目',source:'manual',createdAt:'2026-08-13T02:00:00.000Z'};
  await store.updateState(state=>{state.inbox.push(unclassifiedSource);});
  const unclassified=await createProject({
    appRoot,
    store,
    description:unclassifiedSource.text,
    endDate:'2026-09-01',
    businessId:null,
    sourceInboxId:unclassifiedSource.id
  });
  const classified=await assignProjectBusiness({
    appRoot,
    store,
    projectId:unclassified.project.id,
    businessId:'biz_client'
  });
  const clientBusiness=config.businesses.find(item=>item.id==='biz_client');
  const classifiedMd=await fsp.readFile(
    path.join(appRoot,'workspace',clientBusiness.folder,classified.folder,'PROJECT.md'),
    'utf8'
  );
  assert.match(classifiedMd,/分析与总结真源：飞书云文档/);
  assert.doesNotMatch(classifiedMd,/进度说明|当前卡点|上下文恢复|最近同步/);
});

test('domain-core barrel file is removed and no production entry point imports it',async()=>{
  const domain=await fsp.readFile(path.join(PROJECT_ROOT,'src','domain.mjs'),'utf8');
  assert.doesNotMatch(domain,/domain-core/);

  const srcRoot=path.join(PROJECT_ROOT,'src');
  const imports=[];
  async function walk(dir){
    for(const entry of await fsp.readdir(dir,{withFileTypes:true})){
      const target=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(target);
      else if(entry.isFile()&&entry.name.endsWith('.mjs')){
        const text=await fsp.readFile(target,'utf8');
        if(text.includes("from './domain-core.mjs'")||text.includes("from '../domain-core.mjs'")){
          imports.push(path.relative(PROJECT_ROOT,target));
        }
      }
    }
  }
  await walk(srcRoot);
  assert.deepEqual(imports,[]);
});
