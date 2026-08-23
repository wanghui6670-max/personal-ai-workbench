const nonEmptyString={type:'string',minLength:1,maxLength:4000};
const shortString={type:'string',minLength:1,maxLength:180};
const optionalString={anyOf:[{type:'string',maxLength:180},{type:'null'}]};
const FILTER_OPS=['eq','ne','contains','in','lt','lte','gt','gte'];
const TASK_STATUSES=['todo','in_progress','waiting','blocked','done','cancelled'];

function descriptor({name,description,inputSchema={type:'object',additionalProperties:false,properties:{},required:[]},execute}){
  return Object.freeze({name,description,inputSchema,readOnly:true,requiresConfirmation:false,execute});
}
function object(value,label='工具参数'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error(`${label}必须是 JSON 对象。`),{code:'MCP_TOOL_INVALID_ARGUMENT',statusCode:400});
  return value;
}
function string(value,label){
  if(typeof value!=='string'||!value.trim())throw Object.assign(new Error(`${label}必须是非空字符串。`),{code:'MCP_TOOL_INVALID_ARGUMENT',statusCode:400});
  return value.trim();
}
function actionResult(action){return{action,message:`已生成操作预览 ${action.id}。请在"业务执行"页面确认；未确认前 Joycrew 不会改变。`,navigation:{view:'operations',id:null,modal:'none'}};}
function shellEscape(s){return `'${String(s).replace(/'/g,"'\\''")}'`;}
const AGENT_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const filterSchema={type:'object',additionalProperties:false,properties:{field:shortString,op:{type:'string',enum:FILTER_OPS},value:{}},required:['field','op','value']};
const recordSourceSchema={type:'object',additionalProperties:false,properties:{kind:{const:'records'},sourceId:shortString,entity:shortString,filters:{type:'array',maxItems:20,items:filterSchema}},required:['kind','sourceId','entity']};
const fileSourceSchema={type:'object',additionalProperties:false,properties:{kind:{const:'file'},sourceId:shortString,relativePath:{type:'string',minLength:1,maxLength:1000}},required:['kind','sourceId','relativePath']};

export function createJoycrewTools({client,actions,crewCatalog=null}={}){
  if(!client||!actions)throw new Error('Joycrew tools require client and action broker');
  return [
    descriptor({
      name:'joycrew_workspace_open',
      description:'打开统一工作台中的“业务执行”页面；不会改变 Joycrew。',
      execute:async()=>({navigation:{view:'operations',id:null,modal:'none'},message:'打开业务执行页面。'})
    }),
    descriptor({
      name:'joycrew_status_read',
      description:'检查 Joycrew 是否已配置、可访问，以及当前运行、持久化和认证模式；不返回凭证。',
      execute:async()=>client.probe()
    }),
    descriptor({
      name:'joycrew_dashboard_read',
      description:'读取 Joycrew 业务总览、项目、AI 员工、最近 Run、待审批和交付；不会启动 Run。',
      execute:async()=>client.overview()
    }),
    descriptor({
      name:'joycrew_project_list',
      description:'读取 Joycrew 企业项目列表。',
      execute:async()=>client.projects()
    }),
    descriptor({
      name:'joycrew_project_read',
      description:'读取一个 Joycrew 项目以及其 Run、Evidence、审批和交付。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:shortString},required:['projectId']},
      execute:async(_context,args)=>client.project(string(object(args).projectId,'projectId'))
    }),
    descriptor({
      name:'joycrew_customer_list',
      description:'读取 Joycrew 客户列表。',
      execute:async()=>client.customers()
    }),
    descriptor({
      name:'joycrew_task_list',
      description:'按项目、客户或状态读取 Joycrew 业务任务。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:optionalString,customerId:optionalString,status:{anyOf:[{type:'string',enum:TASK_STATUSES},{type:'null'}]}},required:[]},
      execute:async(_context,args)=>{
        const input=object(args);const filters={};
        for(const key of ['projectId','customerId','status'])if(typeof input[key]==='string'&&input[key].trim())filters[key]=input[key].trim();
        return client.tasks(filters);
      }
    }),
    descriptor({
      name:'joycrew_approval_list',
      description:'读取当前 Workspace 的 Joycrew 写回审批；只有管理员身份可以成功读取。',
      execute:async()=>client.approvals()
    }),
    descriptor({
      name:'joycrew_deliverable_list',
      description:'读取 Joycrew 正式交付及其 Run、Evidence 来源链。',
      execute:async()=>client.deliverables()
    }),
    descriptor({
      name:'joycrew_pending_action_list',
      description:'读取尚未确认的 Joycrew 操作预览；不会执行这些操作。',
      execute:async()=>({actions:actions.list()})
    }),
    descriptor({
      name:'joycrew_run_prepare',
      description:'只生成“创建 Joycrew Run”的操作预览。不会立即运行 AI 员工；用户必须在业务执行页面确认。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:shortString,task:{type:'string',minLength:3,maxLength:4000},employeeId:shortString,sources:{type:'array',minItems:1,maxItems:20,items:{anyOf:[recordSourceSchema,fileSourceSchema]}}},required:['projectId','task','employeeId','sources']},
      execute:async(_context,args)=>actionResult(actions.prepare('run.create',object(args),{source:'harness'}))
    }),
    descriptor({
      name:'joycrew_deliverable_prepare',
      description:'只生成“从成功 Run 创建正式交付”的操作预览。不会立即写服务器。',
      inputSchema:{type:'object',additionalProperties:false,properties:{runId:shortString,title:{type:'string',minLength:1,maxLength:120}},required:['runId','title']},
      execute:async(_context,args)=>actionResult(actions.prepare('deliverable.create',object(args),{source:'harness'}))
    }),
    descriptor({
      name:'joycrew_approval_prepare',
      description:'只生成批准或拒绝 Joycrew 写回审批的操作预览。批准仍会在确认后由 Joycrew 重新检查源状态。',
      inputSchema:{type:'object',additionalProperties:false,properties:{approvalId:shortString,decision:{type:'string',enum:['approve','reject']}},required:['approvalId','decision']},
      execute:async(_context,args)=>actionResult(actions.prepare('approval.decide',object(args),{source:'harness'}))
    }),
    descriptor({
      name:'crew_agent_list',
      description:'列出可用的 AI 员工（本机 Codex agents 和 Joycrew employees）。返回每个员工的 id、岗位名、部门、描述和来源。',
      execute:async()=>{
        const agents=[];
        // 本机 Codex agents
        if(crewCatalog){
          try{
            const data=await crewCatalog.catalog();
            for(const a of data.agents||[]){
              agents.push({id:a.id,name:a.title||a.name,source:'codex',dept:a.dept||'',description:a.description||''});
            }
          }catch{/* crewCatalog 读取失败时静默降级 */}
        }
        // Joycrew employees（如果可用）
        try{
          const overview=await client.overview();
          for(const e of overview.employees||[]){
            agents.push({id:e.id,name:e.name,source:'joycrew',dept:e.role||'',description:`${e.version||''} readiness=${e.readiness||'unknown'}`});
          }
        }catch{/* Joycrew 不可用时只返回 Codex agents */}
        return {agents,count:agents.length};
      }
    }),
    descriptor({
      name:'crew_agent_dispatch',
      description:'向指定 AI 员工派单。当 Joycrew 可用时生成 Run 操作预览（需用户在业务执行页面确认）；当 Joycrew 不可用时返回 codex 派单命令供用户复制执行。',
      inputSchema:{type:'object',additionalProperties:false,properties:{agentId:{type:'string',minLength:1,maxLength:180,pattern:'^[A-Za-z0-9][A-Za-z0-9_-]*$'},task:{type:'string',minLength:3,maxLength:4000},projectId:optionalString,sources:{type:'array',maxItems:20,items:{anyOf:[recordSourceSchema,fileSourceSchema]}}},required:['agentId','task']},
      execute:async(_context,args)=>{
        const input=object(args);
        const agentId=string(input.agentId,'agentId');
        const task=string(input.task,'task');
        // defense-in-depth: execute 层再次校验 agentId pattern，防止绕过 schema 层
        if(!AGENT_ID_PATTERN.test(agentId))throw Object.assign(new Error('agentId 只允许字母、数字、下划线和连字符，且以字母或数字开头。'),{code:'MCP_TOOL_INVALID_ARGUMENT',statusCode:400});
        // 优先尝试 Joycrew Run（如果提供了 projectId 和 sources）
        if(input.projectId&&Array.isArray(input.sources)&&input.sources.length>0){
          return actionResult(actions.prepare('run.create',{projectId:input.projectId,employeeId:agentId,task,sources:input.sources},{source:'harness-navigator'}));
        }
        // Joycrew 不可用或缺少必填参数时，返回 codex 派单命令（单引号转义防止命令注入）
        return{message:`Joycrew 不可用或缺少 projectId/sources 参数。请在终端检查并执行以下命令派单：`,command:`codex exec --agent ${shellEscape(agentId)} ${shellEscape(task)}`};
      }
    })
  ];
}

function containsAny(text,patterns){return patterns.some(pattern=>pattern.test(text));}
export function planJoycrewMessage({message}={}){
  const text=String(message||'').trim();
  if(!text)return null;
  if(containsAny(text,[/打开.*业务执行/,/进入.*业务执行/,/打开.*Joycrew/i]))return{kind:'tool',toolName:'joycrew_workspace_open',args:{},reason:'打开统一产品中的 Joycrew 业务执行页面。'};
  if(containsAny(text,[/Joycrew.*状态/i,/业务执行.*状态/,/连接.*Joycrew/i]))return{kind:'tool',toolName:'joycrew_status_read',args:{},reason:'检查 Joycrew 配置和连通状态。'};
  if(containsAny(text,[/业务总览/,/AI员工.*总览/,/Joycrew.*总览/i]))return{kind:'tool',toolName:'joycrew_dashboard_read',args:{},reason:'读取业务、员工、Run、审批和交付总览。'};
  if(containsAny(text,[/待审批/,/审批列表/,/写回审批/]))return{kind:'tool',toolName:'joycrew_approval_list',args:{},reason:'读取 Joycrew 待审批写回。'};
  if(containsAny(text,[/交付列表/,/最近交付/,/正式交付/]))return{kind:'tool',toolName:'joycrew_deliverable_list',args:{},reason:'读取 Joycrew 正式交付。'};
  if(containsAny(text,[/客户列表/,/有哪些客户/]))return{kind:'tool',toolName:'joycrew_customer_list',args:{},reason:'读取 Joycrew 客户列表。'};
  if(containsAny(text,[/业务任务/,/团队任务/,/Joycrew.*任务/i]))return{kind:'tool',toolName:'joycrew_task_list',args:{},reason:'读取 Joycrew 业务任务。'};
  if(containsAny(text,[/Joycrew.*项目/i,/企业项目/,/业务项目列表/]))return{kind:'tool',toolName:'joycrew_project_list',args:{},reason:'读取 Joycrew 企业项目。'};
  if(containsAny(text,[/AI员工.*列表/,/有哪些.*AI员工/,/列出.*AI员工/,/可用.*员工/]))return{kind:'tool',toolName:'crew_agent_list',args:{},reason:'列出可用的 AI 员工。'};
  if(containsAny(text,[/派单/,/分配.*任务.*员工/,/让.*AI员工.*做/]))return{kind:'tool',toolName:'crew_agent_dispatch',args:{},reason:'向 AI 员工派单。'};
  return null;
}
