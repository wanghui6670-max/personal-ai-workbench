import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { syncProject } from '../src/domain.mjs';
import { prepareIdentityProjectDir } from '../src/project-directory.mjs';

function project(){
  return {
    id:'p_unknown_outcome',
    businessId:'biz_ai',
    name:'未知结果项目',
    intro:'验证飞书结果未知时安全重试',
    folder:'unknown-outcome',
    createdAt:'2026-08-13',
    startDate:'2026-08-13',
    endDate:'2026-08-31',
    git:'',
    feishu:'https://example.feishu.cn/wiki/project',
    completed:false,
    archived:false,
    progress:{percent:10,status:'进行中',hasBlocker:false,lastActivity:null,syncedAt:null,confidence:.8}
  };
}

test('unknown remote outcome keeps the operation receipt and the next sync replays instead of appending again',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-unknown-outcome-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const appRoot=path.join(root,'app');
  const store=new JsonStore(path.join(appRoot,'data'));
  await store.ensure();
  const config=await store.readConfig();
  const p=project();
  await prepareIdentityProjectDir(appRoot,config,p,{businessName:'动觉 AI'});
  await fsp.writeFile(path.join(appRoot,'workspace','01_动觉AI',p.folder,'02_工作过程','work.txt'),'evidence','utf8');
  await store.updateState(state=>{state.projects.push(p);});

  const previous=process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(()=>{
    if(previous===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previous;
  });

  const remote=new Map();
  let appendCount=0;
  let first=true;
  const client={
    appendAnalysis:async(_url,_text,{operationId})=>{
      if(remote.has(operationId))return {...remote.get(operationId),replayed:true};
      appendCount+=1;
      const saved={revisionId:'12',item:{blockId:'remote_12',operationId},replayed:false};
      remote.set(operationId,saved);
      if(first){
        first=false;
        const error=new Error('injected readback timeout after remote write');
        error.code='FEISHU_PROJECT_RECORD_READBACK_FAILED';
        throw error;
      }
      return saved;
    }
  };

  await assert.rejects(
    syncProject({appRoot,store,projectId:p.id,projectRecordClient:client}),
    /injected readback timeout/
  );
  assert.equal(appendCount,1);
  const pending=await store.listProjectRecordReceipts();
  assert.equal(pending.length,1);
  assert.equal(pending[0].phase,'remote_outcome_unknown');
  const visible=await store.readState();
  assert.equal(
    visible.confirmations.some(item=>
      item.type==='project_record_recovery_pending'&&
      item.operationId===pending[0].operationId&&
      /结果无法确认/.test(item.text)
    ),
    true
  );

  const retried=await syncProject({appRoot,store,projectId:p.id,projectRecordClient:client});
  assert.equal(retried.record.replayed,true);
  assert.equal(appendCount,1);
  assert.equal((await store.listProjectRecordReceipts()).length,0);
  const state=await store.readState();
  assert.equal(state.projects[0].progress.feishuRecordBlockId,'remote_12');
  assert.equal(state.confirmations.some(item=>item.type==='project_record_recovery_pending'),false);
});
