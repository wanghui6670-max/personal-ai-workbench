import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionStore, createSessionStore } from '../src/harness-core/index.mjs';

const FIXED_NOW='2026-08-20T00:00:00.000Z';

async function fixture(t,prefix){
  const dir=await mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}

function executionRecord(index,{status='ok'}={}){
  return {
    executionId:`ex_${String(index).padStart(2,'0')}`,
    trigger:'test',
    sessionRef:null,
    actor:'test',
    tool:'project_list',
    startedAt:`2026-08-19T00:00:${String(index).padStart(2,'0')}.000Z`,
    completedAt:status==='running'?null:`2026-08-19T00:01:${String(index).padStart(2,'0')}.000Z`,
    status,
    resultSummary:'',
    errorCode:null
  };
}

function sessionRecord(index){
  return {
    id:`sess_${String(index).padStart(32,'0')}`,
    type:'project',
    projectId:`p_${index}`,
    goal:'',
    checkpoint:null,
    workingMemory:{},
    contextRefs:[],
    decisionRefs:[],
    executionRefs:[],
    updatedAt:FIXED_NOW
  };
}

test('concurrent execution writes remain complete in a private valid JSON file',async t=>{
  const dir=await fixture(t,'harness-execution-concurrent-');
  const file=path.join(dir,'harness','executions.json');
  const store=createExecutionStore({file,maxRecords:100});
  await Promise.all(Array.from({length:32},(_,index)=>store.append(executionRecord(index))));
  const payload=JSON.parse(await readFile(file,'utf8'));
  assert.equal(payload.executions.length,32);
  assert.equal(new Set(payload.executions.map(item=>item.executionId)).size,32);
  assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
});

test('execution retention keeps only the newest configured records',async t=>{
  const dir=await fixture(t,'harness-execution-retention-');
  const file=path.join(dir,'executions.json');
  const store=createExecutionStore({file,maxRecords:3});
  for(let index=0;index<5;index+=1)await store.append(executionRecord(index));
  assert.deepEqual((await store.list()).map(item=>item.executionId),['ex_02','ex_03','ex_04']);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')).executions.map(item=>item.executionId),['ex_02','ex_03','ex_04']);
});

test('execution retention preserves every running record and list limit zero is empty',async t=>{
  const dir=await fixture(t,'harness-execution-running-retention-');
  const file=path.join(dir,'executions.json');
  const store=createExecutionStore({file,maxRecords:2});
  for(let index=0;index<3;index+=1)await store.append(executionRecord(index,{status:'running'}));
  for(let index=3;index<7;index+=1)await store.append(executionRecord(index));
  const records=await store.list();
  assert.deepEqual(
    records.filter(item=>item.status==='running').map(item=>item.executionId),
    ['ex_00','ex_01','ex_02']
  );
  assert.deepEqual(
    records.filter(item=>item.status!=='running').map(item=>item.executionId),
    ['ex_05','ex_06']
  );
  assert.deepEqual(await store.list({limit:0}),[]);
});

test('corrupt execution JSON is copied before an empty store is rebuilt',async t=>{
  const dir=await fixture(t,'harness-execution-corrupt-');
  const file=path.join(dir,'executions.json');
  const corrupt='{"executions":';
  await writeFile(file,corrupt);
  const store=createExecutionStore({file,now:()=>new Date(FIXED_NOW)});
  assert.deepEqual(await store.load(),[]);
  const names=await readdir(dir);
  const backup=names.find(name=>name.startsWith('executions.json.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(dir,backup),'utf8'),corrupt);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{executions:[]});
});

test('invalid execution envelope is preserved before recovery',async t=>{
  const dir=await fixture(t,'harness-execution-envelope-');
  const file=path.join(dir,'executions.json');
  const invalid='{"unexpected":[]}';
  await writeFile(file,invalid);
  const store=createExecutionStore({file,now:()=>new Date(FIXED_NOW)});
  assert.deepEqual(await store.load(),[]);
  const names=await readdir(dir);
  const backup=names.find(name=>name.startsWith('executions.json.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(dir,backup),'utf8'),invalid);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{executions:[]});
});

test('load marks stale running executions as interrupted',async t=>{
  const dir=await fixture(t,'harness-execution-interrupted-');
  const file=path.join(dir,'executions.json');
  await writeFile(file,JSON.stringify({executions:[executionRecord(1,{status:'running'})]}));
  const store=createExecutionStore({file,now:()=>new Date(FIXED_NOW)});
  const [record]=await store.load();
  assert.equal(record.status,'interrupted');
  assert.equal(record.completedAt,FIXED_NOW);
  assert.equal(record.errorCode,'HARNESS_EXECUTION_INTERRUPTED');
  assert.equal(JSON.parse(await readFile(file,'utf8')).executions[0].status,'interrupted');
});

test('concurrent session writes remain complete in a private valid JSON file',async t=>{
  const dir=await fixture(t,'harness-session-concurrent-');
  const file=path.join(dir,'harness','sessions.json');
  const store=createSessionStore({file});
  await Promise.all(Array.from({length:16},(_,index)=>store.create(sessionRecord(index))));
  const payload=JSON.parse(await readFile(file,'utf8'));
  assert.equal(payload.sessions.length,16);
  assert.equal(new Set(payload.sessions.map(item=>item.id)).size,16);
  assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
});

test('corrupt session JSON is copied before an empty store is rebuilt',async t=>{
  const dir=await fixture(t,'harness-session-corrupt-');
  const file=path.join(dir,'sessions.json');
  const corrupt='{"sessions":';
  await writeFile(file,corrupt);
  const store=createSessionStore({file,now:()=>new Date(FIXED_NOW)});
  assert.deepEqual(await store.load(),[]);
  const names=await readdir(dir);
  const backup=names.find(name=>name.startsWith('sessions.json.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(dir,backup),'utf8'),corrupt);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{sessions:[]});
});

test('invalid session envelope is preserved before recovery',async t=>{
  const dir=await fixture(t,'harness-session-envelope-');
  const file=path.join(dir,'sessions.json');
  const invalid='{"unexpected":[]}';
  await writeFile(file,invalid);
  const store=createSessionStore({file,now:()=>new Date(FIXED_NOW)});
  assert.deepEqual(await store.load(),[]);
  const names=await readdir(dir);
  const backup=names.find(name=>name.startsWith('sessions.json.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(dir,backup),'utf8'),invalid);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{sessions:[]});
});
