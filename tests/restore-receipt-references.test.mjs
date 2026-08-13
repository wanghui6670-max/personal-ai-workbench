import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function runRestore(input,dataDir){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['scripts/restore.mjs',input],{
      cwd:path.resolve('.'),
      env:{...process.env,DATA_DIR:dataDir},
      stdio:['ignore','pipe','pipe']
    });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

test('restore rejects a project recovery receipt whose project is absent before creating data',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-dangling-receipt-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'dangling.json');
  const dataDir=path.join(root,'data');
  const payload={
    backupVersion:2,
    backedUpAt:'2026-08-13T11:00:00.000Z',
    state:{
      schemaVersion:1,inbox:[],inboxAcks:[],todos:[],todayPlan:[],todayPlanDate:null,
      projects:[],confirmations:[],notes:[],activities:[],morningSessions:[]
    },
    config:{workspaceRoot:'./workspace',port:4173,businesses:[],settings:{recentDays:3,dueSoonDays:3},dataSource:null},
    captureReceipts:[],
    projectRecordReceipts:[{
      version:1,
      operationId:'pa_dangling_01',
      kind:'analysis',
      projectId:'p_missing',
      documentUrl:'https://example.feishu.cn/wiki/project',
      revisionId:'12',
      blockId:'block_12',
      recordedAt:'2026-08-13T11:00:00.000Z',
      projectSnapshotHash:'a'.repeat(64),
      machineProgress:{percent:10,status:'进行中',hasBlocker:false,confidence:.8},
      phase:'remote_saved_local_pending'
    }]
  };
  await fsp.writeFile(input,JSON.stringify(payload),'utf8');

  const result=await runRestore(input,dataDir);
  assert.notEqual(result.code,0,result.stdout);
  assert.match(result.stderr,/projectId 引用了恢复状态中不存在的项目/);
  await assert.rejects(fsp.access(dataDir),error=>error.code==='ENOENT');
});
