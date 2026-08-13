import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot=path.resolve('.');

function runMigration(dataDir){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['scripts/migrate-project-records.mjs'],{
      cwd:projectRoot,
      env:{...process.env,DATA_DIR:dataDir,OPENAI_API_KEY:'',AI_PROVIDER_ENABLED:'0'},
      stdio:['ignore','pipe','pipe']
    });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

test('migration dry-run reports current, pre-completion and long legacy narrative without contacting Feishu',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-migration-cli-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'data');
  await fsp.mkdir(path.join(dataDir,'backups'),{recursive:true});
  const state={
    schemaVersion:1,
    inbox:[],todos:[],todayPlan:[],todayPlanDate:null,confirmations:[],notes:[],activities:[],morningSessions:[],
    projects:[{
      id:'p_legacy_cli',businessId:null,name:'迁移 CLI 项目',intro:'',folder:'',createdAt:'2026-08-13',startDate:'2026-08-13',endDate:'2026-08-31',git:'',feishu:'',completed:false,archived:false,
      progress:{percent:30,status:'进行中',summary:'当前分析',resume:'当前恢复',blocker:'当前卡点',lastActivity:null,syncedAt:null,confidence:.7},
      progressBeforeCompletion:{percent:20,status:'进行中',summary:'X'.repeat(6_200),resume:'完成前恢复',blocker:'完成前卡点',lastActivity:null,syncedAt:null,confidence:.6}
    }]
  };
  const config={
    workspaceRoot:'./workspace',port:4173,
    businesses:[{id:'biz_ai',name:'动觉 AI',folder:'01_动觉AI'}],
    settings:{recentDays:3,dueSoonDays:3},dataSource:null
  };
  await fsp.writeFile(path.join(dataDir,'state.json'),JSON.stringify(state),'utf8');
  await fsp.writeFile(path.join(dataDir,'config.json'),JSON.stringify(config),'utf8');

  const result=await runMigration(dataDir);
  assert.equal(result.code,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.mode,'dry-run');
  assert.equal(report.snapshotFound,true);
  assert.equal(report.results.length,1);
  assert.equal(report.results[0].narrative,true);
  assert.ok(report.results[0].narrativeRecordCount>=3);
  assert.equal(report.results[0].narrativeMigration,'pending_feishu_binding');
  assert.equal(report.results[0].records.length,0);
});
