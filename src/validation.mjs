import { normalizeFeishuProjectDocumentUrl } from './project-record-contract.mjs';

const DATE_ONLY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const STATE_SCHEMA_VERSION = 1;
const STATE_ARRAY_FIELDS = ['inbox','todos','todayPlan','projects','confirmations','notes','activities','morningSessions'];
const STATE_ENTITY_FIELDS = STATE_ARRAY_FIELDS.filter(field=>field!=='todayPlan');
const STATE_ID_ENTITY_FIELDS = STATE_ENTITY_FIELDS.filter(field=>field!=='activities');
const SAFE_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const GETNOTE_SOURCE_DECISIONS=new Set(['dismissed','memo','project_note','project_created']);
const GETNOTE_DUE_DATE_OWNERS=new Set(['source','user']);
const GETNOTE_DECISION_FIELDS=new Set(['id','source','externalId','sourceNoteId','disposition','decidedAt']);
const MAX_EXTERNAL_TASK_DECISIONS=2000;

function invalid(scope, message) {
  const error = new Error(`${scope}：${message}`);
  error.code = scope === '无效工作台配置' ? 'INVALID_CONFIG' : 'INVALID_STATE';
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value,scope,field){
  if(typeof value!=='string'||!value.trim())throw invalid(scope,`${field} 必须是非空字符串`);
}

function requireSafeId(value,scope,field){
  requireNonEmptyString(value,scope,field);
  if(!SAFE_ID_PATTERN.test(value))throw invalid(scope,`${field} 必须是 1-128 位安全 ID（首位为字母或数字，其余只允许字母、数字、下划线或连字符）`);
}

function validateOptionalString(value,scope,field,{nullable=false,nonEmpty=false}={}){
  if(value===undefined||(nullable&&value===null))return;
  if(typeof value!=='string'||(nonEmpty&&!value.trim()))throw invalid(scope,`${field} 必须是${nonEmpty?'非空':''}字符串`);
}

function validateOptionalBoolean(value,scope,field){
  if(value!==undefined&&typeof value!=='boolean')throw invalid(scope,`${field} 必须是布尔值`);
}

function validateProgress(progress,scope,field){
  if(progress===undefined)return;
  if(!isRecord(progress))throw invalid(scope,`${field} 必须是对象`);
  const allowed=new Set(['percent','status','hasBlocker','lastActivity','syncedAt','confidence','feishuRevisionId','feishuRecordBlockId','feishuRecordedAt','feishuOperationId']);
  for(const key of Object.keys(progress)){
    if(!allowed.has(key))throw invalid(scope,`${field}.${key} 不是允许的机器进度字段；项目分析正文必须只保存在飞书项目文档`);
  }
  if(Object.hasOwn(progress,'percent')&&(!Number.isInteger(progress.percent)||progress.percent<0||progress.percent>100)){
    throw invalid(scope,`${field}.percent 必须是 0-100 的整数`);
  }
  validateOptionalString(progress.status,scope,`${field}.status`);
  validateOptionalBoolean(progress.hasBlocker,scope,`${field}.hasBlocker`);
  for(const key of ['lastActivity','syncedAt'])validateOptionalString(progress[key],scope,`${field}.${key}`,{nullable:true});
  for(const key of ['feishuRevisionId','feishuRecordBlockId','feishuRecordedAt','feishuOperationId'])validateOptionalString(progress[key],scope,`${field}.${key}`,{nullable:true});
  if(Object.hasOwn(progress,'confidence')&&(typeof progress.confidence!=='number'||!Number.isFinite(progress.confidence)||progress.confidence<0||progress.confidence>1)){
    throw invalid(scope,`${field}.confidence 必须是 0-1 的有限数值`);
  }
}

function validateOptionalId(value,scope,field,{nullable=false}={}){
  if(value===undefined||(nullable&&value===null))return;
  requireSafeId(value,scope,field);
}

function isSinglePathSegment(value){
  return value!=='.'&&value!=='..'&&!value.includes('/')&&!value.includes('\\')&&!value.includes('\0');
}

function validateFeishuUrl(value,scope,field,{allowEmpty=false}={}){
  if(value===undefined)return;
  if(typeof value!=='string')throw invalid(scope,`${field} 必须是字符串`);
  if(!value.trim()&&allowEmpty)return;
  try{normalizeFeishuProjectDocumentUrl(value);}
  catch(error){throw invalid(scope,`${field}：${error.message}`);}
}

function validateDataSource(value,scope='无效工作台配置'){
  if(value===undefined||value===null)return;
  if(!isRecord(value))throw invalid(scope,'dataSource 必须是对象或 null');
  if(value.provider!=='feishu_doc')throw invalid(scope,'dataSource.provider 目前只支持 feishu_doc');
  requireNonEmptyString(value.documentUrl,scope,'dataSource.documentUrl');
  validateFeishuUrl(value.documentUrl,scope,'dataSource.documentUrl');
  for(const field of ['inboxHeading','inboxPrefix'])validateOptionalString(value[field],scope,`dataSource.${field}`,{nonEmpty:true});
  for(const field of ['lastRevisionId','lastSyncAt','lastSyncStatus','lastSyncError'])validateOptionalString(value[field],scope,`dataSource.${field}`,{nullable:true});
  if(Object.hasOwn(value,'lastImportedCount')&&(!Number.isInteger(value.lastImportedCount)||value.lastImportedCount<0))throw invalid(scope,'dataSource.lastImportedCount 必须是非负整数');
}

function validateExternalTaskDecisions(value,scope){
  if(value===undefined)return;
  if(!Array.isArray(value))throw invalid(scope,'externalTaskDecisions 必须是数组');
  if(value.length>MAX_EXTERNAL_TASK_DECISIONS)throw invalid(scope,`externalTaskDecisions 最多 ${MAX_EXTERNAL_TASK_DECISIONS} 条`);
  const ids=new Set();
  const externalIds=new Set();
  for(const [index,decision] of value.entries()){
    const field=`externalTaskDecisions[${index}]`;
    if(!isRecord(decision))throw invalid(scope,`${field} 必须是对象`);
    for(const key of Object.keys(decision)){
      if(!GETNOTE_DECISION_FIELDS.has(key))throw invalid(scope,`${field}.${key} 不是允许的来源决策字段`);
    }
    requireSafeId(decision.id,scope,`${field}.id`);
    if(ids.has(decision.id))throw invalid(scope,`${field}.id 不能重复`);
    ids.add(decision.id);
    if(decision.source!=='getnote_cli')throw invalid(scope,`${field}.source 目前只支持 getnote_cli`);
    requireNonEmptyString(decision.externalId,scope,`${field}.externalId`);
    if(decision.externalId.length>512)throw invalid(scope,`${field}.externalId 过长`);
    if(externalIds.has(decision.externalId))throw invalid(scope,`${field}.externalId 不能重复`);
    externalIds.add(decision.externalId);
    validateOptionalString(decision.sourceNoteId,scope,`${field}.sourceNoteId`,{nullable:true,nonEmpty:true});
    if(!GETNOTE_SOURCE_DECISIONS.has(decision.disposition))throw invalid(scope,`${field}.disposition 不受支持`);
    requireNonEmptyString(decision.decidedAt,scope,`${field}.decidedAt`);
  }
}

export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function validateStateInput(state, {restore = false} = {}) {
  if (!isRecord(state)) throw invalid('无效工作台状态', 'state 必须是对象');
  if(Object.hasOwn(state,'schemaVersion')&&state.schemaVersion!==STATE_SCHEMA_VERSION){
    throw invalid('无效工作台状态',`不支持 schemaVersion ${String(state.schemaVersion)}`);
  }
  for (const key of STATE_ARRAY_FIELDS) {
    if (Object.hasOwn(state, key) && !Array.isArray(state[key])) {
      throw invalid('无效工作台状态', `${key} 必须是数组`);
    }
  }
  if(Object.hasOwn(state,'inboxAcks')&&!Array.isArray(state.inboxAcks))throw invalid('无效工作台状态','inboxAcks 必须是数组');
  validateExternalTaskDecisions(state.externalTaskDecisions,'无效工作台状态');
  if (restore && (!Array.isArray(state.todos) || !Array.isArray(state.projects))) {
    throw invalid('无效工作台状态', '恢复数据必须包含 todos 和 projects 数组');
  }
  return state;
}

export function validateState(state) {
  const scope='无效工作台状态';
  if (!isRecord(state)) throw invalid(scope, 'state 必须是对象');
  if(state.schemaVersion!==STATE_SCHEMA_VERSION){
    throw invalid(scope,`不支持 schemaVersion ${String(state.schemaVersion)}`);
  }
  for(const field of STATE_ARRAY_FIELDS){
    if(!Array.isArray(state[field]))throw invalid(scope,`${field} 必须是数组`);
  }
  if(!Array.isArray(state.inboxAcks))throw invalid(scope,'inboxAcks 必须是数组');
  validateExternalTaskDecisions(state.externalTaskDecisions,scope);
  for(const field of STATE_ENTITY_FIELDS){
    for(const [index,entity] of state[field].entries()){
      if(!isRecord(entity))throw invalid(scope,`${field}[${index}] 必须是对象`);
    }
  }
  for(const field of STATE_ID_ENTITY_FIELDS){
    const ids=new Set();
    for(const [index,entity] of state[field].entries()){
      requireSafeId(entity.id,scope,`${field}[${index}].id`);
      if(ids.has(entity.id))throw invalid(scope,`${field}[${index}].id 不能重复`);
      ids.add(entity.id);
    }
  }
  if (state.todayPlanDate !== null && !isValidDateOnly(state.todayPlanDate)) {
    throw invalid(scope, 'todayPlanDate 必须是 null 或合法的 YYYY-MM-DD 日期');
  }
  if (state.todayPlan.length > 0 && !isValidDateOnly(state.todayPlanDate)) {
    throw invalid(scope, 'todayPlan 非空时 todayPlanDate 必须是合法的 YYYY-MM-DD 日期');
  }

  for (const [index, todo] of state.todos.entries()) {
    if (!isValidDateOnly(todo.dueDate)) {
      throw invalid(scope, `todos[${index}].dueDate 必须是合法的 YYYY-MM-DD 日期`);
    }
    validateOptionalString(todo.title,scope,`todos[${index}].title`);
    validateOptionalString(todo.context,scope,`todos[${index}].context`);
    validateOptionalString(todo.createdAt,scope,`todos[${index}].createdAt`);
    validateOptionalBoolean(todo.done,scope,`todos[${index}].done`);
    validateOptionalId(todo.projectId,scope,`todos[${index}].projectId`,{nullable:true});
    if(todo.dueDateOwner!==undefined&&!GETNOTE_DUE_DATE_OWNERS.has(todo.dueDateOwner)){
      throw invalid(scope,`todos[${index}].dueDateOwner 必须是 source 或 user`);
    }
  }

  for (const [index, project] of state.projects.entries()) {
    if (!isValidDateOnly(project.endDate)) {
      throw invalid(scope, `projects[${index}].endDate 必须是合法的 YYYY-MM-DD 日期`);
    }
    for(const field of ['name','intro','createdAt','startDate','git','sourceDescription']){
      validateOptionalString(project[field],scope,`projects[${index}].${field}`);
    }
    validateFeishuUrl(project.feishu,scope,`projects[${index}].feishu`,{allowEmpty:true});
    validateOptionalBoolean(project.completed,scope,`projects[${index}].completed`);
    validateOptionalBoolean(project.archived,scope,`projects[${index}].archived`);
    validateOptionalId(project.businessId,scope,`projects[${index}].businessId`,{nullable:true});
    if(project.businessId!==undefined&&project.businessId!==null){
      requireNonEmptyString(project.folder,scope,`projects[${index}].folder`);
      if(!isSinglePathSegment(project.folder))throw invalid(scope,`projects[${index}].folder 必须是单层目录名`);
    }else{
      validateOptionalString(project.folder,scope,`projects[${index}].folder`);
      if(typeof project.folder==='string'&&project.folder&&!isSinglePathSegment(project.folder))throw invalid(scope,`projects[${index}].folder 必须是单层目录名`);
    }
    validateProgress(project.progress,scope,`projects[${index}].progress`);
    validateProgress(project.progressBeforeCompletion,scope,`projects[${index}].progressBeforeCompletion`);
  }

  const projectSourceIds=new Set();
  for(const [index,project] of state.projects.entries()){
    if(project.sourceInboxId===undefined)continue;
    requireSafeId(project.sourceInboxId,scope,`projects[${index}].sourceInboxId`);
    if(projectSourceIds.has(project.sourceInboxId)){
      throw invalid(scope,`projects[${index}].sourceInboxId 不能重复`);
    }
    projectSourceIds.add(project.sourceInboxId);
  }

  for(const [index,item] of state.inbox.entries()){
    for(const field of ['text','source','createdAt','feishuBlockId'])validateOptionalString(item[field],scope,`inbox[${index}].${field}`);
  }
  const ackIds=new Set();
  for(const [index,ack] of state.inboxAcks.entries()){
    if(!isRecord(ack))throw invalid(scope,`inboxAcks[${index}] 必须是对象`);
    requireNonEmptyString(ack.blockId,scope,`inboxAcks[${index}].blockId`);
    if(ackIds.has(ack.blockId))throw invalid(scope,`inboxAcks[${index}].blockId 不能重复`);
    ackIds.add(ack.blockId);
    requireNonEmptyString(ack.contentHash,scope,`inboxAcks[${index}].contentHash`);
    if(!SHA256_PATTERN.test(ack.contentHash))throw invalid(scope,`inboxAcks[${index}].contentHash 必须是 SHA-256 十六进制`);
    if(Object.hasOwn(ack,'text'))throw invalid(scope,`inboxAcks[${index}] 不得保存收件箱正文`);
    validateOptionalString(ack.acknowledgedAt,scope,`inboxAcks[${index}].acknowledgedAt`,{nullable:true});
  }
  for(const [index,note] of state.notes.entries()){
    validateOptionalString(note.text,scope,`notes[${index}].text`);
    validateOptionalString(note.createdAt,scope,`notes[${index}].createdAt`);
    validateOptionalId(note.projectId,scope,`notes[${index}].projectId`,{nullable:true});
  }
  for(const [index,confirmation] of state.confirmations.entries()){
    for(const field of ['type','text','createdAt'])validateOptionalString(confirmation[field],scope,`confirmations[${index}].${field}`);
    validateOptionalId(confirmation.projectId,scope,`confirmations[${index}].projectId`);
    validateOptionalId(confirmation.inboxId,scope,`confirmations[${index}].inboxId`);
    validateOptionalId(confirmation.operationId,scope,`confirmations[${index}].operationId`);
    validateOptionalBoolean(confirmation.synthetic,scope,`confirmations[${index}].synthetic`);
  }
  for(const [index,activity] of state.activities.entries()){
    for(const field of ['type','text','at'])validateOptionalString(activity[field],scope,`activities[${index}].${field}`);
    validateOptionalId(activity.projectId,scope,`activities[${index}].projectId`);
    validateOptionalId(activity.todoId,scope,`activities[${index}].todoId`);
    validateOptionalId(activity.inboxId,scope,`activities[${index}].inboxId`);
  }
  for(const [index,session] of state.morningSessions.entries()){
    validateOptionalString(session.date,scope,`morningSessions[${index}].date`);
    validateOptionalString(session.createdAt,scope,`morningSessions[${index}].createdAt`);
    if(Object.hasOwn(session,'messages')){
      if(!Array.isArray(session.messages))throw invalid(scope,`morningSessions[${index}].messages 必须是数组`);
      for(const [messageIndex,message] of session.messages.entries()){
        if(!isRecord(message))throw invalid(scope,`morningSessions[${index}].messages[${messageIndex}] 必须是对象`);
        for(const field of ['role','text','at'])validateOptionalString(message[field],scope,`morningSessions[${index}].messages[${messageIndex}].${field}`);
      }
    }
  }

  const todosById = new Map(state.todos.map(todo => [todo.id, todo]));
  const projectIds = new Set(state.projects.map(project=>project.id));
  for(const [index,todo] of state.todos.entries()){
    if(todo.projectId!==undefined&&todo.projectId!==null&&!projectIds.has(todo.projectId)){
      throw invalid(scope,`todos[${index}].projectId 引用了不存在的项目`);
    }
  }
  const todayIds=new Set();
  for (const [index, todoId] of state.todayPlan.entries()) {
    requireSafeId(todoId,scope,`todayPlan[${index}]`);
    if(todayIds.has(todoId))throw invalid(scope,`todayPlan[${index}] 不能重复`);
    todayIds.add(todoId);
    const todo = todosById.get(todoId);
    if (!todo) throw invalid(scope, `todayPlan[${index}] 引用了不存在的待办`);
    if (todo.done === true) throw invalid(scope, `todayPlan[${index}] 不能引用已完成待办`);
  }
  return state;
}

export function validateStateConfigReferences(state,config){
  validateConfig(config);
  const businessIds=new Set(config.businesses.map(business=>business.id));
  for(const [index,project] of state.projects.entries()){
    if(project.businessId!==undefined&&project.businessId!==null&&!businessIds.has(project.businessId)){
      throw invalid('无效工作台状态',`projects[${index}].businessId 引用了不存在的业务板块`);
    }
  }
  return state;
}

export function validateConfig(config) {
  const scope='无效工作台配置';
  if (!isRecord(config)) throw invalid(scope, 'config 必须是对象');
  if(Object.hasOwn(config,'workspaceRoot'))requireNonEmptyString(config.workspaceRoot,scope,'workspaceRoot');
  if(Object.hasOwn(config,'businesses')&&!Array.isArray(config.businesses))throw invalid(scope,'businesses 必须是数组');
  if(Array.isArray(config.businesses)){
    if(config.businesses.length===0)throw invalid(scope,'businesses 不能为空');
    const ids=new Set(),names=new Set(),folders=new Set();
    for(const [index,business] of config.businesses.entries()){
      if(!isRecord(business))throw invalid(scope,`businesses[${index}] 必须是对象`);
      requireSafeId(business.id,scope,`businesses[${index}].id`);
      for(const field of ['name','folder'])requireNonEmptyString(business[field],scope,`businesses[${index}].${field}`);
      if(!isSinglePathSegment(business.folder))throw invalid(scope,`businesses[${index}].folder 必须是单层目录名`);
      for(const [field,seen] of [['id',ids],['name',names],['folder',folders]]){
        if(seen.has(business[field]))throw invalid(scope,`businesses[${index}].${field} 不能重复`);
        seen.add(business[field]);
      }
    }
  }
  if (Object.hasOwn(config, 'settings') && !isRecord(config.settings)) {
    throw invalid(scope, 'settings 必须是对象');
  }
  validateDataSource(config.dataSource,scope);
  return config;
}
