import crypto from 'node:crypto';

const ACTION_TYPES=new Set(['run.create','deliverable.create','approval.decide']);
const ACTION_ID_PATTERN=/^jact_[A-Za-z0-9_-]{20,80}$/;
const FILTER_OPS=new Set(['eq','ne','contains','in','lt','lte','gt','gte']);

function actionError(code,message,statusCode=400){return Object.assign(new Error(message),{code,statusCode});}
function text(value,label,{min=1,max=4000}={}){
  if(typeof value!=='string')throw actionError('JOYCREW_ACTION_INVALID',`${label} 必须是字符串。`);
  const normalized=value.trim();
  if(normalized.length<min||normalized.length>max)throw actionError('JOYCREW_ACTION_INVALID',`${label} 长度必须在 ${min}-${max} 个字符之间。`);
  return normalized;
}
function plainObject(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw actionError('JOYCREW_ACTION_INVALID',`${label} 必须是 JSON 对象。`);
  return value;
}
function safeValue(value,depth=0){
  if(depth>5)throw actionError('JOYCREW_ACTION_INVALID','参数嵌套层级过深。');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){
    if(!Number.isFinite(value))throw actionError('JOYCREW_ACTION_INVALID','参数包含无效数字。');
    return value;
  }
  if(typeof value==='string')return value.length<=4_000?value:`${value.slice(0,3_999)}…`;
  if(Array.isArray(value)){
    if(value.length>100)throw actionError('JOYCREW_ACTION_INVALID','参数数组过长。');
    return value.map(item=>safeValue(item,depth+1));
  }
  if(value&&typeof value==='object'){
    const entries=Object.entries(value);
    if(entries.length>100)throw actionError('JOYCREW_ACTION_INVALID','参数字段过多。');
    return Object.fromEntries(entries.map(([key,item])=>[text(key,'字段名',{max:120}),safeValue(item,depth+1)]));
  }
  throw actionError('JOYCREW_ACTION_INVALID','参数包含不支持的值。');
}
function relativePath(value){
  const normalized=text(value,'相对路径',{max:1000}).replace(/\\/g,'/');
  if(normalized.startsWith('/')||/^[A-Za-z]:\//.test(normalized)||normalized.includes('\0'))throw actionError('JOYCREW_ACTION_INVALID','文件路径必须是受控相对路径。');
  const segments=normalized.split('/');
  if(segments.some(part=>part==='..'||part===''))throw actionError('JOYCREW_ACTION_INVALID','文件路径不能包含空段或目录穿越。');
  return normalized;
}
function normalizeFilter(value){
  const input=plainObject(value,'过滤条件');
  const field=text(input.field,'过滤字段',{max:160});
  const op=text(input.op,'过滤操作',{max:20});
  if(!FILTER_OPS.has(op))throw actionError('JOYCREW_ACTION_INVALID','过滤操作不受支持。');
  return {field,op,value:safeValue(input.value)};
}
function normalizeSource(value){
  const input=plainObject(value,'数据源');
  const kind=text(input.kind,'数据源类型',{max:20});
  const sourceId=text(input.sourceId,'数据源 ID',{max:180});
  if(kind==='records'){
    const filters=Array.isArray(input.filters)?input.filters:[];
    if(filters.length>20)throw actionError('JOYCREW_ACTION_INVALID','单个记录源最多 20 个过滤条件。');
    return {kind,sourceId,entity:text(input.entity,'实体名',{max:160}),filters:filters.map(normalizeFilter)};
  }
  if(kind==='file')return {kind,sourceId,relativePath:relativePath(input.relativePath)};
  throw actionError('JOYCREW_ACTION_INVALID','数据源类型只能是 records 或 file。');
}
function normalizeRun(value){
  const input=plainObject(value,'Run 参数');
  const sources=Array.isArray(input.sources)?input.sources:[];
  if(!sources.length||sources.length>20)throw actionError('JOYCREW_ACTION_INVALID','Run 必须选择 1-20 个数据源。');
  return {
    projectId:text(input.projectId,'项目 ID',{max:180}),
    task:text(input.task,'执行任务',{min:3,max:4000}),
    employeeId:text(input.employeeId,'AI 员工 ID',{max:180}),
    sources:sources.map(normalizeSource)
  };
}
function normalizeDeliverable(value){
  const input=plainObject(value,'交付参数');
  return {runId:text(input.runId,'Run ID',{max:180}),title:text(input.title,'交付标题',{max:120})};
}
function normalizeApproval(value){
  const input=plainObject(value,'审批参数');
  const decision=text(input.decision,'审批决定',{max:20});
  if(!['approve','reject'].includes(decision))throw actionError('JOYCREW_ACTION_INVALID','审批决定只能是 approve 或 reject。');
  return {approvalId:text(input.approvalId,'审批 ID',{max:180}),decision};
}
function normalizePayload(type,payload){
  if(type==='run.create')return normalizeRun(payload);
  if(type==='deliverable.create')return normalizeDeliverable(payload);
  if(type==='approval.decide')return normalizeApproval(payload);
  throw actionError('JOYCREW_ACTION_UNSUPPORTED','不支持的 Joycrew 操作类型。');
}
function sortValue(value){
  if(Array.isArray(value))return value.map(sortValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortValue(value[key])]));
  return value;
}
function digest(value){return crypto.createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex');}
function compact(value,max=120){const text=String(value||'').replace(/\s+/g,' ').trim();return text.length<=max?text:`${text.slice(0,max-1)}…`;}
function publicAction(action){
  return {
    id:action.id,type:action.type,title:action.title,summary:action.summary,effects:action.effects,
    payload:action.payload,digest:action.digest,source:action.source,status:action.status,
    createdAt:action.createdAt,expiresAt:action.expiresAt,
    ...(action.executedAt?{executedAt:action.executedAt}:{}),
    ...(action.cancelledAt?{cancelledAt:action.cancelledAt}:{}),
    ...(action.result?{result:action.result}:{}),
    ...(action.error?{error:action.error}:{}),
    ...(action.uncertainAt?{uncertainAt:action.uncertainAt}:{})
  };
}
function descriptor(type,payload){
  if(type==='run.create')return{
    title:`运行 AI 员工：${payload.employeeId}`,
    summary:`在项目 ${payload.projectId} 上执行「${compact(payload.task)}」，读取 ${payload.sources.length} 个明确选择的数据源。`,
    effects:['创建 Joycrew Run','按需调用 DataWeave 读取所选来源','调用已配置 Runtime','生成 Evidence Package']
  };
  if(type==='deliverable.create')return{
    title:`生成交付：${payload.title}`,
    summary:`从 Run ${payload.runId} 的 Evidence 生成服务器正式交付。`,
    effects:['读取 Run 与 Evidence','写入服务器专用交付目录','保存 Deliverable 来源链']
  };
  return{
    title:`${payload.decision==='approve'?'批准并执行':'拒绝'}写回审批`,
    summary:`对审批 ${payload.approvalId} 执行 ${payload.decision==='approve'?'批准':'拒绝'}。`,
    effects:payload.decision==='approve'?['重新检查源状态','执行受控写回','写后验证','保存审批与审计结果']:['标记审批为拒绝','不修改业务源']
  };
}

export class JoycrewActionBroker{
  constructor({client,now=Date.now,ttlMs=10*60*1000,completedTtlMs=5*60*1000,uncertainTtlMs=30*60*1000}={}){
    if(!client)throw new Error('JoycrewActionBroker requires client');
    this.client=client;
    this.now=now;
    this.ttlMs=ttlMs;
    this.completedTtlMs=completedTtlMs;
    this.uncertainTtlMs=uncertainTtlMs;
    this.actions=new Map();
  }
  prune(){
    const now=this.now();
    for(const [id,action] of this.actions){
      const cutoff=action.status==='pending'||action.status==='executing'?Date.parse(action.expiresAt):Date.parse(action.finishedExpiresAt||action.expiresAt);
      if(!Number.isFinite(cutoff)||cutoff<=now)this.actions.delete(id);
    }
  }
  prepare(type,payload,{source='workbench'}={}){
    this.prune();
    if(!ACTION_TYPES.has(type))throw actionError('JOYCREW_ACTION_UNSUPPORTED','不支持的 Joycrew 操作类型。');
    const normalized=normalizePayload(type,payload);
    const at=this.now();
    const meta=descriptor(type,normalized);
    const action={
      id:`jact_${crypto.randomBytes(18).toString('base64url')}`,
      type,payload:normalized,...meta,source:text(String(source||'workbench'),'操作来源',{max:80}),
      digest:`sha256:${digest({type,payload:normalized})}`,
      status:'pending',createdAt:new Date(at).toISOString(),expiresAt:new Date(at+this.ttlMs).toISOString()
    };
    this.actions.set(action.id,action);
    return publicAction(action);
  }
  get(id){
    if(typeof id!=='string'||!ACTION_ID_PATTERN.test(id))throw actionError('JOYCREW_ACTION_NOT_FOUND','操作预览不存在或已过期。',404);
    const action=this.actions.get(id);
    if(!action)throw actionError('JOYCREW_ACTION_NOT_FOUND','操作预览不存在或已过期。',404);
    const cutoff=action.status==='pending'||action.status==='executing'?Date.parse(action.expiresAt):Date.parse(action.finishedExpiresAt||action.expiresAt);
    if(!Number.isFinite(cutoff)||cutoff<=this.now()){
      this.actions.delete(id);
      if(action.status==='pending'||action.status==='executing')throw actionError('JOYCREW_ACTION_EXPIRED','操作预览已过期，请重新生成。',410);
      throw actionError('JOYCREW_ACTION_NOT_FOUND','操作预览不存在或已过期。',404);
    }
    return action;
  }
  list({includeCompleted=false}={}){
    this.prune();
    return [...this.actions.values()].filter(action=>includeCompleted||action.status==='pending'||action.status==='executing'||action.status==='uncertain').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(publicAction);
  }
  cancel(id){
    const action=this.get(id);
    if(action.status==='executing')throw actionError('JOYCREW_ACTION_BUSY','操作正在执行，不能取消。',409);
    if(action.status==='uncertain')throw actionError('JOYCREW_ACTION_UNCERTAIN','Joycrew 是否已完成该操作无法确定；请先刷新业务状态核对，不能直接取消或重试。',409);
    if(action.status==='executed')return publicAction(action);
    action.status='cancelled';
    action.cancelledAt=new Date(this.now()).toISOString();
    action.finishedExpiresAt=new Date(this.now()+this.completedTtlMs).toISOString();
    return publicAction(action);
  }
  async execute(id,{confirmed=false}={}){
    const action=this.get(id);
    if(!confirmed)throw actionError('JOYCREW_ACTION_CONFIRMATION_REQUIRED','必须先确认操作预览。',409);
    if(action.status==='executed')return publicAction(action);
    if(action.status==='cancelled')throw actionError('JOYCREW_ACTION_CANCELLED','操作预览已取消。',409);
    if(action.status==='uncertain')throw actionError('JOYCREW_ACTION_UNCERTAIN','上一次请求结果不确定；为避免重复副作用，不能用同一预览再次执行。请刷新业务状态核对后重新生成。',409);
    if(action.status==='executing')throw actionError('JOYCREW_ACTION_BUSY','操作正在执行，请不要重复提交。',409);
    if(Date.parse(action.expiresAt)<=this.now()){
      this.actions.delete(action.id);
      throw actionError('JOYCREW_ACTION_EXPIRED','操作预览已过期，请重新生成。',410);
    }
    action.status='executing';
    try{
      let result;
      if(action.type==='run.create')result=await this.client.createRun(action.payload.projectId,{task:action.payload.task,employeeId:action.payload.employeeId,sources:action.payload.sources});
      else if(action.type==='deliverable.create')result=await this.client.createDeliverable(action.payload.runId,action.payload.title);
      else result=action.payload.decision==='approve'?await this.client.approve(action.payload.approvalId):await this.client.reject(action.payload.approvalId);
      action.status='executed';
      action.result=safeValue(result);
      action.executedAt=new Date(this.now()).toISOString();
      action.finishedExpiresAt=new Date(this.now()+this.completedTtlMs).toISOString();
      return publicAction(action);
    }catch(error){
      const safePreflight=error?.code==='JOYCREW_DISABLED'||error?.code==='JOYCREW_CONFIGURATION_INVALID';
      if(safePreflight){
        action.status='pending';
      }else{
        action.status='uncertain';
        action.uncertainAt=new Date(this.now()).toISOString();
        action.finishedExpiresAt=new Date(this.now()+this.uncertainTtlMs).toISOString();
        action.error={
          code:typeof error?.code==='string'?error.code:'JOYCREW_RESULT_UNCERTAIN',
          message:'请求可能已经到达 Joycrew，但 Workbench 没有获得可验证结果。请刷新业务状态核对，不能直接重试。',
          retryable:false
        };
      }
      throw error;
    }
  }
}

export function createJoycrewActionBroker(options){return new JoycrewActionBroker(options);}
