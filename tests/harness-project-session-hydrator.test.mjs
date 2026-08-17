import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectSessionStore} from '../src/harness-core/project-session-store.mjs';
import {ProjectSessionManager} from '../src/harness-core/project-session-manager.mjs';
import {ProjectSessionHydrator} from '../src/harness-core/project-session-hydrator.mjs';

async function fixture(t,{feishu=true}={}){
  const dataDir=await fsp.mkdtemp(path.join(os.tmpdir(),'harness-project-hydrator-'));
  t.after(()=>fsp.rm(dataDir,{recursive:true,force:true}));
  const state={projects:[{
    id:'prj_1',name:'Personal AI Workbench',businessId:'biz_ai',folder:'Personal-AI-Workbench',
    endDate:'2026-09-30',createdAt:'2026-08-11T00:00:00.000Z',archived:false,completed:false,
    git:'https://example.invalid/repo.git',feishu:feishu?'https://example.feishu.cn/docx/example':'',
    progress:{
      percent:40,status:'进行中',hasBlocker:true,lastActivity:'2026-08-17T10:00:00.000Z',
      syncedAt:'2026-08-17T10:05:00.000Z',feishuRevisionId:feishu?'rev-1':null,
      feishuRecordBlockId:feishu?'block-1':null,feishuRecordedAt:feishu?'2026-08-17T10:05:00.000Z':null,
      feishuOperationId:feishu?'op-1':null
    }
  }]};
  const workbenchStore={readState:async()=>structuredClone(state)};
  const sessionStore=new ProjectSessionStore({dataDir});
  let tick=0;
  const manager=new ProjectSessionManager({workbenchStore,sessionStore,clock:()=>`2026-08-17T12:00:0${tick++}.000Z`});
  const session=await manager.openProject('prj_1');
  await manager.checkpoint(session.id,{
    workspaceLastActivity:'2026-08-17T10:00:00.000Z',
    gitHead:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });
  return{dataDir,state,workbenchStore,sessionStore,manager};
}

test('Hydration compares live Authorities against the prior checkpoint, returns live context, then advances machine cursors',async t=>{
  const f=await fixture(t);
  const hydrator=new ProjectSessionHydrator({
    workbenchStore:f.workbenchStore,
    sessionManager:f.manager,
    readWorkspaceEvidence:async()=>({
      status:'ok',latestActivity:'2026-08-17T11:30:00.000Z',fileCount:2,
      recentFiles:[
        {path:'02_工作过程/设计.md',mtime:'2026-08-17T11:30:00.000Z',size:120,content:'SECRET FILE BODY'},
        {path:'PROJECT.md',mtime:'2026-08-17T11:00:00.000Z',size:80}
      ],
      git:{status:'ok',head:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',dirty:true,
        recentCommits:[{hash:'bbbbbbb',date:'2026-08-17T11:20:00.000Z',subject:'feat: harness hydration',body:'SECRET COMMIT BODY'}]}
    }),
    readFeishuRecords:async()=>({
      revisionId:'rev-2',records:[{blockId:'block-2',recordedAt:'2026-08-17T11:40:00.000Z',operationId:'op-2',text:'最新项目总结正文'}]
    })
  });

  const context=await hydrator.hydrateProject('prj_1');
  assert.equal(context.session.id,'project:prj_1');
  assert.equal(context.session.previousCursor.gitHead,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(context.project.name,'Personal AI Workbench');
  assert.equal(context.authorities.workspace.latestActivity,'2026-08-17T11:30:00.000Z');
  assert.deepEqual(context.authorities.workspace.recentFiles,[
    {path:'02_工作过程/设计.md',mtime:'2026-08-17T11:30:00.000Z',size:120},
    {path:'PROJECT.md',mtime:'2026-08-17T11:00:00.000Z',size:80}
  ]);
  assert.equal(context.authorities.git.head,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.deepEqual(context.authorities.git.recentCommits,[
    {hash:'bbbbbbb',date:'2026-08-17T11:20:00.000Z',subject:'feat: harness hydration'}
  ]);
  assert.equal(context.authorities.feishu.revisionId,'rev-2');
  assert.equal(context.authorities.feishu.records[0].text,'最新项目总结正文');
  assert.deepEqual(context.changes,{workbench:false,workspace:true,git:true,feishu:true});

  const stored=await f.sessionStore.read('project:prj_1');
  assert.equal(stored.cursor.workspaceLastActivity,'2026-08-17T11:30:00.000Z');
  assert.equal(stored.cursor.gitHead,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(stored.cursor.feishuRevisionId,'rev-2');
  assert.equal(stored.cursor.feishuRecordBlockId,'block-2');
  assert.equal(stored.cursor.feishuOperationId,'op-2');
  const persisted=JSON.stringify(stored);
  for(const forbidden of ['Personal AI Workbench','SECRET FILE BODY','SECRET COMMIT BODY','最新项目总结正文','feat: harness hydration']){
    assert.equal(persisted.includes(forbidden),false);
  }
});

test('a failed Feishu Authority degrades the live context and preserves the previous Feishu cursor while other successful cursors advance',async t=>{
  const f=await fixture(t);
  const hydrator=new ProjectSessionHydrator({
    workbenchStore:f.workbenchStore,
    sessionManager:f.manager,
    readWorkspaceEvidence:async()=>({
      status:'ok',latestActivity:'2026-08-17T11:30:00.000Z',fileCount:0,recentFiles:[],
      git:{status:'ok',head:'cccccccccccccccccccccccccccccccccccccccc',dirty:false,recentCommits:[]}
    }),
    readFeishuRecords:async()=>{throw Object.assign(new Error('sensitive Feishu failure body'),{code:'FEISHU_UNREACHABLE'});}
  });

  const context=await hydrator.hydrateProject('prj_1');
  assert.deepEqual(context.authorities.feishu,{status:'unavailable',errorCode:'FEISHU_UNREACHABLE',revisionId:null,records:[]});
  assert.equal(context.changes.feishu,null);
  assert.equal(JSON.stringify(context).includes('sensitive Feishu failure body'),false);

  const stored=await f.sessionStore.read('project:prj_1');
  assert.equal(stored.cursor.feishuRevisionId,'rev-1');
  assert.equal(stored.cursor.feishuRecordBlockId,'block-1');
  assert.equal(stored.cursor.workspaceLastActivity,'2026-08-17T11:30:00.000Z');
  assert.equal(stored.cursor.gitHead,'cccccccccccccccccccccccccccccccccccccccc');
});

test('an unbound project does not call Feishu and reports that Authority as not configured',async t=>{
  const f=await fixture(t,{feishu:false});
  let feishuCalls=0;
  const hydrator=new ProjectSessionHydrator({
    workbenchStore:f.workbenchStore,
    sessionManager:f.manager,
    readWorkspaceEvidence:async()=>({status:'ok',latestActivity:null,fileCount:0,recentFiles:[],git:{status:'not_repo',head:null,dirty:false,recentCommits:[]}}),
    readFeishuRecords:async()=>{feishuCalls+=1;return{revisionId:'impossible',records:[]};}
  });
  const context=await hydrator.hydrateProject('prj_1');
  assert.equal(feishuCalls,0);
  assert.deepEqual(context.authorities.feishu,{status:'not_configured',errorCode:null,revisionId:null,records:[]});
});

test('Hydration never creates context for an unknown detached project',async t=>{
  const f=await fixture(t);
  const hydrator=new ProjectSessionHydrator({
    workbenchStore:f.workbenchStore,
    sessionManager:f.manager,
    readWorkspaceEvidence:async()=>({status:'ok',latestActivity:null,fileCount:0,recentFiles:[],git:{status:'not_repo',head:null,dirty:false,recentCommits:[]}}),
    readFeishuRecords:async()=>({revisionId:null,records:[]})
  });
  await assert.rejects(()=>hydrator.hydrateProject('missing'),error=>error?.code==='PROJECT_SESSION_PROJECT_NOT_FOUND');
});
