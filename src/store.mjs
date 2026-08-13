import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso, todayIso } from './utils.mjs';
import { isValidDateOnly, validateConfig, validateState, validateStateConfigReferences, validateStateInput } from './validation.mjs';
import { stripNarrativeProgress } from './project-record-policy.mjs';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_OPERATION_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const DEFAULT_CONFIG = {
  workspaceRoot: './workspace',
  port: 4173,
  businesses: [
    {id:'biz_ai',name:'动觉 AI',folder:'01_动觉AI'},
    {id:'biz_store',name:'实体门店',folder:'02_实体门店'},
    {id:'biz_client',name:'客户项目',folder:'03_客户项目'},
    {id:'biz_personal',name:'个人内容',folder:'04_个人内容'}
  ],
  settings: { recentDays: 3, dueSoonDays: 3 },
  dataSource: null
};

const DEFAULT_STATE = {
  schemaVersion: 1,
  inbox: [], todos: [], todayPlan: [], todayPlanDate: null, projects: [], confirmations: [], notes: [],
  activities: [], morningSessions: []
};

function legacyNarrativeEntries(state={}){
  const entries=[];
  for(const project of Array.isArray(state.projects)?state.projects:[]){
    const fields=[];
    for(const [containerName,progress] of [['progress',project?.progress],['progressBeforeCompletion',project?.progressBeforeCompletion]]){
      if(!progress||typeof progress!=='object'||Array.isArray(progress))continue;
      for(const field of ['summary','resume','blocker']){
        if(typeof progress[field]==='string'&&progress[field].trim())fields.push(`${containerName}.${field}`);
      }
    }
    if(fields.length)entries.push({projectId:project?.id||null,name:project?.name||'',feishu:project?.feishu||'',fields});
  }
  const activityCount=(Array.isArray(state.activities)?state.activities:[]).filter(activity=>activity?.type==='project_synced').length;
  return {projects:entries,activityCount,found:entries.length>0||activityCount>0};
}

function normalizeProject(project){
  if(!project||typeof project!=='object'||Array.isArray(project))return project;
  const next={...project};
  if(project.progress)next.progress=stripNarrativeProgress(project.progress);
  if(project.progressBeforeCompletion)next.progressBeforeCompletion=stripNarrativeProgress(project.progressBeforeCompletion);
  return next;
}

function normalizeActivity(activity){
  if(!activity||typeof activity!=='object'||Array.isArray(activity))return activity;
  if(activity.type!=='project_synced')return activity;
  return {...activity,text:'项目进度已同步；分析与总结正文保存在飞书项目文档。'};
}

function addMigrationConfirmations(state,legacy){
  if(!legacy.found)return;
  for(const entry of legacy.projects){
    if(!entry.projectId||state.confirmations.some(item=>item.type==='legacy_project_narrative_pending'&&item.projectId===entry.projectId))continue;
    const project=state.projects.find(item=>item.id===entry.projectId);
    state.confirmations.unshift({
      id:`cf_${randomUUID().replaceAll('-','')}`,
      type:'legacy_project_narrative_pending',
      projectId:entry.projectId,
      text:`「${project?.name||entry.name||'旧项目'}」存在升级前项目分析。原始内容已保存在不可覆盖的迁移快照中；请在绑定飞书项目文档后显式迁移并核对。`,
      createdAt:nowIso()
    });
  }
}

function normalizeState(state={}, {migrateLegacyTodayPlan=false}={}) {
  const todayPlan=Array.isArray(state.todayPlan)?state.todayPlan:[];
  const legacyUndatedTodayPlan=migrateLegacyTodayPlan&&!Object.hasOwn(state,'todayPlanDate')&&todayPlan.length>0;
  return {
    ...DEFAULT_STATE,
    ...state,
    schemaVersion: 1,
    inbox: Array.isArray(state.inbox)?state.inbox:[],
    todos: Array.isArray(state.todos)?state.todos:[],
    todayPlan: legacyUndatedTodayPlan?[]:todayPlan,
    todayPlanDate: isValidDateOnly(state.todayPlanDate)?state.todayPlanDate:null,
    projects: Array.isArray(state.projects)?state.projects.map(normalizeProject):[],
    confirmations: Array.isArray(state.confirmations)?state.confirmations:[],
    notes: Array.isArray(state.notes)?state.notes:[],
    activities: Array.isArray(state.activities)?state.activities.map(normalizeActivity):[],
    morningSessions: Array.isArray(state.morningSessions)?state.morningSessions:[]
  };
}

function normalizeConfig(config={}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    businesses: Array.isArray(config.businesses) && config.businesses.length ? config.businesses : DEFAULT_CONFIG.businesses,
    settings: {...DEFAULT_CONFIG.settings,...(config.settings||{})},
    dataSource: config.dataSource === undefined ? DEFAULT_CONFIG.dataSource : config.dataSource
  };
}

function prepareState(state, options) {
  validateStateInput(state, options);
  const legacy=legacyNarrativeEntries(state);
  const normalized=normalizeState(state,options);
  addMigrationConfirmations(normalized,legacy);
  return validateState(normalized);
}

function prepareConfig(config) {
  validateConfig(config);
  return normalizeConfig(config);
}

function safeOperationId(value){
  const operationId=String(value??'').trim();
  if(!SAFE_OPERATION_ID.test(operationId))throw Object.assign(new Error('recovery operationId 格式无效。'),{code:'INVALID_RECOVERY_RECEIPT'});
  return operationId;
}

export class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir,'state.json');
    this.configFile = path.join(dataDir,'config.json');
    this.backupDir = path.join(dataDir,'backups');
    this.migrationDir = path.join(dataDir,'migrations');
    this.recoveryDir = path.join(dataDir,'recovery');
    this._queue = Promise.resolve();
  }

  async ensure() {
    await this._ensurePrivateDirectory(this.dataDir,'数据目录');
    await this._ensurePrivateDirectory(this.backupDir,'备份目录');
    await this._ensurePrivateDirectory(this.migrationDir,'迁移目录');
    await this._ensurePrivateDirectory(this.recoveryDir,'恢复凭据目录');
    const existing=await this._assertSafeLayout();
    if(!existing.state)await this._atomicWrite(this.stateFile,DEFAULT_STATE);
    if(!existing.config)await this._atomicWrite(this.configFile,DEFAULT_CONFIG);
    const rawState=await this._readRaw(this.stateFile);
    const rawConfig=await this._readRaw(this.configFile);
    const legacy=legacyNarrativeEntries(rawState);
    if(legacy.found)await this._archiveLegacySnapshot({source:'startup',state:rawState,config:rawConfig,legacy});
    const state = prepareState(rawState,{migrateLegacyTodayPlan:true});
    await this._atomicWrite(this.stateFile,state);
    const config = prepareConfig(rawConfig);
    await this._atomicWrite(this.configFile,config);
  }

  _unsafePath(label,message='不能是符号链接'){
    const error=new Error(`不安全的工作台路径：${label}${message}`);
    error.code='UNSAFE_STORE_PATH';
    return error;
  }
  async _safeLstat(target,label,type=null){
    let stat;
    try{stat=await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink())throw this._unsafePath(label);
    if(type==='directory'&&!stat.isDirectory())throw this._unsafePath(label,'必须是目录');
    if(type==='file'&&!stat.isFile())throw this._unsafePath(label,'必须是普通文件');
    return stat;
  }
  async _ensurePrivateDirectory(target,label){
    const existing=await this._safeLstat(target,label,'directory');
    if(!existing)await fsp.mkdir(target,{recursive:true,mode:PRIVATE_DIRECTORY_MODE});
    await this._safeLstat(target,label,'directory');
    await fsp.chmod(target,PRIVATE_DIRECTORY_MODE);
  }
  async _assertSafeLayout(){
    const dataDir=await this._safeLstat(this.dataDir,'数据目录','directory');
    if(!dataDir)throw this._unsafePath('数据目录','不存在');
    const backupDir=await this._safeLstat(this.backupDir,'备份目录','directory');
    const migrationDir=await this._safeLstat(this.migrationDir,'迁移目录','directory');
    const recoveryDir=await this._safeLstat(this.recoveryDir,'恢复凭据目录','directory');
    if(!backupDir||!migrationDir||!recoveryDir)throw this._unsafePath('工作台子目录','不存在');
    const state=await this._safeLstat(this.stateFile,'state.json','file');
    const config=await this._safeLstat(this.configFile,'config.json','file');
    return {state,config,backupDir,migrationDir,recoveryDir};
  }
  async _readRaw(file) {
    await this._assertSafeLayout();
    await this._safeLstat(file,path.basename(file),'file');
    return JSON.parse(await fsp.readFile(file,'utf8'));
  }
  async _read(file){return this._readRaw(file);}
  async _atomicWrite(file,data) {
    await this._assertSafeLayout();
    await this._safeLstat(file,path.basename(file),'file');
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let created=false;
    try{
      await fsp.writeFile(tmp,JSON.stringify(data,null,2),{encoding:'utf8',flag:'wx',mode:PRIVATE_FILE_MODE});
      created=true;
      await fsp.chmod(tmp,PRIVATE_FILE_MODE);
      await this._safeLstat(file,path.basename(file),'file');
      await fsp.rename(tmp,file);
      created=false;
    }catch(error){
      if(created)await fsp.unlink(tmp).catch(()=>{});
      throw error;
    }
  }
  async _writeImmutable(file,data){
    await this._assertSafeLayout();
    try{
      await fsp.writeFile(file,JSON.stringify(data,null,2),{encoding:'utf8',flag:'wx',mode:PRIVATE_FILE_MODE});
      await fsp.chmod(file,PRIVATE_FILE_MODE);
      return file;
    }catch(error){
      if(error.code==='EEXIST')return file;
      throw error;
    }
  }
  async _archiveLegacySnapshot({source,state,config,legacy}){
    const fixed=source==='startup'?'pre-narrative-v1-startup.json':`pre-narrative-v1-${source}-${nowIso().replace(/[:.]/g,'-')}-${randomUUID()}.json`;
    const target=path.join(this.migrationDir,fixed);
    return this._writeImmutable(target,{
      migration:'project-narrative-to-feishu-v1',
      status:'pending_explicit_migration',
      capturedAt:nowIso(),
      source,
      legacy,
      state,
      config
    });
  }

  async readState(){ return prepareState(await this._read(this.stateFile),{migrateLegacyTodayPlan:true}); }
  async readConfig(){ return prepareConfig(await this._read(this.configFile)); }
  async writeConfig(config){ return this._enqueue(async()=>{ const next=prepareConfig(config);await this._maybeDailyBackup();await this._atomicWrite(this.configFile,next);return config; }); }
  async writeState(state){ return this._enqueue(async()=>{ const next=prepareState(state);await this._maybeDailyBackup();await this._atomicWrite(this.stateFile,next);return state; }); }
  async updateState(mutator){
    return this._enqueue(async()=>{
      const state = prepareState(await this._read(this.stateFile),{migrateLegacyTodayPlan:true});
      const result = await mutator(state);
      const next = prepareState(state);
      await this._maybeDailyBackup();
      await this._atomicWrite(this.stateFile,next);
      return result;
    });
  }
  async updateConfig(mutator){
    return this._enqueue(async()=>{
      const config = prepareConfig(await this._read(this.configFile));
      const result = await mutator(config);
      const next = prepareConfig(config);
      await this._maybeDailyBackup();
      await this._atomicWrite(this.configFile,next);
      return result;
    });
  }
  _enqueue(fn){
    const run = this._queue.then(fn,fn);
    this._queue = run.then(()=>undefined,()=>undefined);
    return run;
  }
  async _maybeDailyBackup(){
    const name = `state-${todayIso()}.json`;
    const target = path.join(this.backupDir,name);
    await this._assertSafeLayout();
    if(await this._safeLstat(target,name,'file'))return;
    const state = await this.readState();
    const config = await this.readConfig();
    await this._atomicWrite(target,{backedUpAt:nowIso(),state,config});
  }
  async _backupNowUnlocked(){
    const state = await this.readState();
    const config = await this.readConfig();
    const stamp = nowIso().replace(/[:.]/g,'-');
    const target = path.join(this.backupDir,`backup-${stamp}-${randomUUID()}.json`);
    await this._atomicWrite(target,{backedUpAt:nowIso(),state,config});
    return target;
  }
  async backupNow(){ return this._enqueue(()=>this._backupNowUnlocked()); }

  async writeProjectRecordReceipt(receipt){
    const operationId=safeOperationId(receipt?.operationId);
    const target=path.join(this.recoveryDir,`project-record-${operationId}.json`);
    const safe={
      version:1,
      operationId,
      kind:String(receipt?.kind||''),
      projectId:String(receipt?.projectId||''),
      documentUrl:String(receipt?.documentUrl||''),
      revisionId:receipt?.revisionId===null||receipt?.revisionId===undefined?null:String(receipt.revisionId),
      blockId:receipt?.blockId?String(receipt.blockId):null,
      recordedAt:receipt?.recordedAt?String(receipt.recordedAt):nowIso(),
      projectSnapshotHash:String(receipt?.projectSnapshotHash||''),
      machineProgress:receipt?.machineProgress&&typeof receipt.machineProgress==='object'?structuredClone(receipt.machineProgress):null,
      phase:String(receipt?.phase||'remote_saved_local_pending')
    };
    await this._atomicWrite(target,safe);
    return safe;
  }
  async readProjectRecordReceipt(operationId){
    const id=safeOperationId(operationId);
    const target=path.join(this.recoveryDir,`project-record-${id}.json`);
    try{return await this._readRaw(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async deleteProjectRecordReceipt(operationId){
    const id=safeOperationId(operationId);
    const target=path.join(this.recoveryDir,`project-record-${id}.json`);
    const stat=await this._safeLstat(target,path.basename(target),'file');
    if(stat)await fsp.unlink(target);
  }
  async listProjectRecordReceipts(){
    await this._assertSafeLayout();
    const names=await fsp.readdir(this.recoveryDir);
    const receipts=[];
    for(const name of names.filter(item=>/^project-record-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(item)).sort()){
      receipts.push(await this._readRaw(path.join(this.recoveryDir,name)));
    }
    return receipts;
  }

  async restore({state,config,includeConfig=config!==undefined}={}){
    validateStateInput(state,{restore:true});
    const legacy=legacyNarrativeEntries(state);
    const nextState=prepareState(state,{restore:true});
    const nextConfig=includeConfig?prepareConfig(config):null;
    if(includeConfig)validateStateConfigReferences(nextState,nextConfig);
    return this._enqueue(async()=>{
      await this.ensure();
      if(legacy.found)await this._archiveLegacySnapshot({source:'restore',state,config:includeConfig?config:await this.readConfig(),legacy});
      const previousState=await this.readState();
      const previousConfig=await this.readConfig();
      const safety=await this._backupNowUnlocked();
      try{
        await this._atomicWrite(this.stateFile,nextState);
        if(includeConfig)await this._atomicWrite(this.configFile,nextConfig);
      }catch(error){
        const rollbackErrors=[];
        try{await this._atomicWrite(this.stateFile,previousState);}catch(rollbackError){rollbackErrors.push(`state: ${rollbackError.message}`);}
        if(includeConfig){
          try{await this._atomicWrite(this.configFile,previousConfig);}catch(rollbackError){rollbackErrors.push(`config: ${rollbackError.message}`);}
        }
        if(rollbackErrors.length){
          const rollbackError=new Error(`恢复失败，且回滚未完整完成（${rollbackErrors.join('；')}）`,{cause:error});
          rollbackError.code='RESTORE_ROLLBACK_FAILED';
          throw rollbackError;
        }
        throw error;
      }
      return safety;
    });
  }
}

export function addActivity(state, activity) {
  state.activities.unshift({at:nowIso(), ...activity});
  if (state.activities.length > 2000) state.activities.length = 2000;
}

export { legacyNarrativeEntries };
