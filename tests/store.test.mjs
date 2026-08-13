import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';

function emptyState(overrides={}){
  return {
    schemaVersion:1,inbox:[],todos:[],todayPlan:[],todayPlanDate:null,projects:[],confirmations:[],notes:[],activities:[],morningSessions:[],
    ...overrides
  };
}

async function temporaryStore(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-store-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return store;
}

async function mode(target){
  return (await fsp.lstat(target)).mode&0o777;
}

function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

async function settleWithin(promise,label,timeoutMs=2000){
  let timer;
  try{
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(`${label} timed out`)),timeoutMs);
      })
    ]);
  }finally{
    clearTimeout(timer);
  }
}

test('store creates private directories and files under a permissive umask',async(t)=>{
  const previousUmask=process.umask(0o022);
  t.after(()=>process.umask(previousUmask));
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-store-mode-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  await store.writeState(emptyState({todos:[{id:'td_private',dueDate:'2026-08-20',done:false}]}));
  const manualBackup=await store.backupNow();

  assert.equal(await mode(store.dataDir),0o700);
  assert.equal(await mode(store.backupDir),0o700);
  assert.equal(await mode(store.stateFile),0o600);
  assert.equal(await mode(store.configFile),0o600);
  assert.equal(await mode(manualBackup),0o600);
  for(const name of await fsp.readdir(store.backupDir)){
    assert.equal(await mode(path.join(store.backupDir,name)),0o600);
  }
});

test('manual backups share the write queue and cannot observe a mixed state/config pair',async t=>{
  const store=await temporaryStore(t);
  const originalConfig=await store.readConfig();
  let releaseWrite;const blocked=new Promise(resolve=>{releaseWrite=resolve;});
  let enteredWrite;const entered=new Promise(resolve=>{enteredWrite=resolve;});
  const write=store.updateState(async state=>{
    state.todos.push({id:'td_queued',dueDate:'2026-08-20',done:false});
    enteredWrite();await blocked;
  });
  await entered;
  const backupPromise=store.backupNow();
  releaseWrite();await write;
  const backup=JSON.parse(await fsp.readFile(await backupPromise,'utf8'));
  assert.equal(backup.state.todos.some(todo=>todo.id==='td_queued'),true);
  assert.deepEqual(backup.config,originalConfig);
});

test('rapid queued manual backups use distinct files and preserve each queue snapshot',async t=>{
  const store=await temporaryStore(t);
  const firstState=emptyState({todos:[{id:'td_first_backup',dueDate:'2026-08-20',done:false}]});
  const secondState=emptyState({todos:[{id:'td_second_backup',dueDate:'2026-08-21',done:false}]});
  await store.writeState(firstState);

  const OriginalDate=globalThis.Date;
  const frozenTime=OriginalDate.now();
  class FrozenDate extends OriginalDate {
    constructor(...args){super(...(args.length?args:[frozenTime]));}
    static now(){return frozenTime;}
  }
  globalThis.Date=FrozenDate;
  t.after(()=>{globalThis.Date=OriginalDate;});

  const firstBackupPromise=store.backupNow();
  const mutationPromise=store.writeState(secondState);
  const secondBackupPromise=store.backupNow();
  const [firstBackup,,secondBackup]=await Promise.all([
    firstBackupPromise,
    mutationPromise,
    secondBackupPromise
  ]);

  assert.notEqual(firstBackup,secondBackup);
  assert.match(path.basename(firstBackup),/^backup-.+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i);
  assert.match(path.basename(secondBackup),/^backup-.+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i);

  const [firstPayload,secondPayload]=await Promise.all([
    fsp.readFile(firstBackup,'utf8').then(JSON.parse),
    fsp.readFile(secondBackup,'utf8').then(JSON.parse)
  ]);
  assert.deepEqual(firstPayload.state,firstState);
  assert.deepEqual(secondPayload.state,secondState);
  assert.equal(firstPayload.backedUpAt,secondPayload.backedUpAt);
  assert.equal((await fsp.readdir(store.backupDir)).filter(name=>name.startsWith('backup-')).length,2);
});

test('manual backup blocks a config mutation at the state/config read barrier',async t=>{
  const store=await temporaryStore(t);
  const originalState=await store.readState();
  const originalConfig=await store.readConfig();
  let memoryState=structuredClone(originalState);
  let memoryConfig=structuredClone(originalConfig);
  let backupPayload=null;
  let blockStateRead=true;
  let configMutatorStarted=false;
  const stateReadStarted=deferred();
  const releaseStateRead=deferred();

  // With the old unqueued backupNow(), updateConfig could enter while the
  // backup was paused here and create a before-state/after-config snapshot.
  store._read=async file=>{
    if(file===store.stateFile){
      const snapshot=structuredClone(memoryState);
      if(blockStateRead){
        blockStateRead=false;
        stateReadStarted.resolve();
        await releaseStateRead.promise;
      }
      return snapshot;
    }
    if(file===store.configFile)return structuredClone(memoryConfig);
    throw new Error(`unexpected read: ${file}`);
  };
  store._maybeDailyBackup=async()=>{};
  store._atomicWrite=async(file,data)=>{
    if(file===store.stateFile)memoryState=structuredClone(data);
    else if(file===store.configFile)memoryConfig=structuredClone(data);
    else backupPayload=structuredClone(data);
  };

  const backupPromise=store.backupNow();
  await stateReadStarted.promise;
  const configUpdatePromise=store.updateConfig(config=>{
    configMutatorStarted=true;
    config.workspaceRoot='./after-barrier';
  });
  await new Promise(resolve=>setImmediate(resolve));
  const mutationEnteredBeforeRelease=configMutatorStarted;

  releaseStateRead.resolve();
  const [backupTarget]=await Promise.all([backupPromise,configUpdatePromise]);

  assert.equal(mutationEnteredBeforeRelease,false);
  assert.match(path.basename(backupTarget),/^backup-.+\.json$/);
  assert.deepEqual(backupPayload.state,originalState);
  assert.deepEqual(backupPayload.config,originalConfig);
  assert.equal(memoryConfig.workspaceRoot,'./after-barrier');
});

test('daily backup completes inside a queued write without nested queue deadlock',async t=>{
  const store=await temporaryStore(t);
  const nextState=emptyState({todos:[{id:'td_daily',dueDate:'2026-08-20',done:false}]});

  await settleWithin(store.writeState(nextState),'daily backup');

  assert.deepEqual(await store.readState(),nextState);
  const dailyNames=(await fsp.readdir(store.backupDir)).filter(name=>/^state-\d{4}-\d{2}-\d{2}\.json$/.test(name));
  assert.equal(dailyNames.length,1);
});

test('restore completes behind a mutation and backs up one pre-restore queue state',async t=>{
  const store=await temporaryStore(t);
  const previousConfig=await store.readConfig();
  const mutationEntered=deferred();
  const releaseMutation=deferred();
  const queuedState=emptyState({todos:[{id:'td_before_restore',dueDate:'2026-08-20',done:false}]});
  const restoredState=emptyState({projects:[{id:'p_restored',endDate:'2026-09-01'}]});
  const restoredConfig={...previousConfig,workspaceRoot:'./restored-by-test'};

  const mutation=store.updateState(async state=>{
    state.todos=structuredClone(queuedState.todos);
    mutationEntered.resolve();
    await releaseMutation.promise;
  });
  await mutationEntered.promise;
  const restore=store.restore({state:restoredState,config:restoredConfig,includeConfig:true});
  releaseMutation.resolve();

  await settleWithin(Promise.all([mutation,restore]),'restore');
  const safetyPath=await restore;
  const safety=JSON.parse(await fsp.readFile(safetyPath,'utf8'));

  assert.deepEqual(safety.state,queuedState);
  assert.deepEqual(safety.config,previousConfig);
  assert.deepEqual(await store.readState(),restoredState);
  assert.deepEqual(await store.readConfig(),restoredConfig);
});

test('state symlink is rejected without changing its external target',async(t)=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-store-symlink-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const dataDir=path.join(root,'data');
  const external=path.join(root,'external-state.json');
  const original='external file must remain unchanged';
  await fsp.mkdir(dataDir,{recursive:true});
  await fsp.writeFile(external,original,'utf8');
  await fsp.symlink(external,path.join(dataDir,'state.json'));
  const store=new JsonStore(dataDir);

  await assert.rejects(store.ensure(),/state\.json.*符号链接/);
  await assert.rejects(store.writeState(emptyState()),/state\.json.*符号链接/);
  assert.equal(await fsp.readFile(external,'utf8'),original);
});

test('state persistence rejects todos without a valid dueDate before backup or write',async(t)=>{
  const store=await temporaryStore(t);
  const before=await fsp.readFile(store.stateFile,'utf8');
  const backupsBefore=await fsp.readdir(store.backupDir);
  await assert.rejects(
    store.writeState(emptyState({todos:[{id:'td_missing',done:false}]})),
    /dueDate 必须是合法的 YYYY-MM-DD/
  );
  assert.equal(await fsp.readFile(store.stateFile,'utf8'),before);
  assert.deepEqual(await fsp.readdir(store.backupDir),backupsBefore);
});

test('state persistence rejects an unknown schema version before backup or write',async(t)=>{
  const store=await temporaryStore(t);
  const before=await fsp.readFile(store.stateFile,'utf8');
  const backupsBefore=await fsp.readdir(store.backupDir);
  await assert.rejects(store.writeState(emptyState({schemaVersion:2})),/不支持 schemaVersion 2/);
  assert.equal(await fsp.readFile(store.stateFile,'utf8'),before);
  assert.deepEqual(await fsp.readdir(store.backupDir),backupsBefore);
});

test('state persistence rejects projects without a valid endDate',async(t)=>{
  const store=await temporaryStore(t);
  await assert.rejects(
    store.updateState(state=>{state.projects.push({id:'p_missing'});}),
    /endDate 必须是合法的 YYYY-MM-DD/
  );
  assert.deepEqual((await store.readState()).projects,[]);
});

test('state persistence rejects duplicate project inbox sources while allowing legacy projects',async t=>{
  const store=await temporaryStore(t);
  const legacy={id:'p_legacy',endDate:'2026-09-01'};
  const sourced={id:'p_sourced',endDate:'2026-09-02',sourceInboxId:'in_once'};
  await store.writeState(emptyState({projects:[legacy,sourced]}));
  await assert.rejects(
    store.writeState(emptyState({projects:[sourced,{id:'p_duplicate',endDate:'2026-09-03',sourceInboxId:'in_once'}]})),
    /sourceInboxId 不能重复/
  );
});

test('state persistence rejects forged or completed todayPlan references',async(t)=>{
  const store=await temporaryStore(t);
  await assert.rejects(
    store.writeState(emptyState({todayPlan:['td_forged'],todayPlanDate:'2026-08-12'})),
    /引用了不存在的待办/
  );
  await assert.rejects(
    store.writeState(emptyState({
      todos:[{id:'td_done',dueDate:'2026-08-20',done:true}],
      todayPlan:['td_done'],
      todayPlanDate:'2026-08-12'
    })),
    /不能引用已完成待办/
  );
});

test('first state or config write creates one daily backup with the full pre-write snapshot',async(t)=>{
  for(const firstWrite of ['state','config']){
    await t.test(`${firstWrite} first`,async(t)=>{
      const store=await temporaryStore(t);
      const originalState=emptyState();
      const originalConfig=await store.readConfig();

      if(firstWrite==='state'){
        await store.writeState(emptyState({todos:[{id:'td_after_backup',dueDate:'2026-08-20',done:false}]}));
      }else{
        await store.writeConfig({...originalConfig,workspaceRoot:'./changed-by-config'});
      }
      const dailyNames=(await fsp.readdir(store.backupDir)).filter(name=>/^state-\d{4}-\d{2}-\d{2}\.json$/.test(name));
      assert.equal(dailyNames.length,1);
      const dailyFile=path.join(store.backupDir,dailyNames[0]);
      const firstSnapshot=JSON.parse(await fsp.readFile(dailyFile,'utf8'));
      assert.deepEqual(firstSnapshot.state,originalState);
      assert.deepEqual(firstSnapshot.config,originalConfig);
      assert.equal(typeof firstSnapshot.backedUpAt,'string');

      if(firstWrite==='state'){
        await store.writeConfig({...originalConfig,workspaceRoot:'./changed-after-backup'});
      }else{
        await store.writeState(emptyState({todos:[{id:'td_after_backup',dueDate:'2026-08-20',done:false}]}));
      }
      assert.deepEqual(JSON.parse(await fsp.readFile(dailyFile,'utf8')),firstSnapshot);
      assert.deepEqual(await fsp.readdir(store.backupDir),dailyNames);
    });
  }
});

test('daily backup failure aborts state and config writes',async(t)=>{
  const store=await temporaryStore(t);
  const originalState=await store.readState();
  const originalConfig=await store.readConfig();
  const originalAtomicWrite=store._atomicWrite.bind(store);
  store._atomicWrite=async(file,data)=>{
    if(path.dirname(file)===store.backupDir&&/^state-\d{4}-\d{2}-\d{2}\.json$/.test(path.basename(file))){
      throw new Error('simulated daily backup failure');
    }
    return originalAtomicWrite(file,data);
  };

  await assert.rejects(
    store.writeState(emptyState({todos:[{id:'td_must_not_persist',dueDate:'2026-08-20',done:false}]})),
    /simulated daily backup failure/
  );
  assert.deepEqual(await store.readState(),originalState);

  await assert.rejects(
    store.updateConfig(config=>{config.workspaceRoot='./must-not-persist';}),
    /simulated daily backup failure/
  );
  assert.deepEqual(await store.readConfig(),originalConfig);
  assert.deepEqual(await fsp.readdir(store.backupDir),[]);
});

test('restore rolls state back when the paired config write fails',async(t)=>{
  const store=await temporaryStore(t);
  const previousState=emptyState({todos:[{id:'td_old',dueDate:'2026-08-20',done:false}]});
  await store.writeState(previousState);
  const previousConfig=await store.readConfig();
  const originalAtomicWrite=store._atomicWrite.bind(store);
  let failRestoredConfig=true;
  store._atomicWrite=async(file,data)=>{
    if(file===store.configFile&&data.workspaceRoot==='./restored'&&failRestoredConfig){
      failRestoredConfig=false;
      throw new Error('simulated config write failure');
    }
    return originalAtomicWrite(file,data);
  };

  await assert.rejects(store.restore({
    state:emptyState({projects:[{id:'p_new',endDate:'2026-09-01'}]}),
    config:{...previousConfig,workspaceRoot:'./restored'},
    includeConfig:true
  }),/simulated config write failure/);

  assert.deepEqual(await store.readState(),previousState);
  assert.deepEqual(await store.readConfig(),previousConfig);
});
