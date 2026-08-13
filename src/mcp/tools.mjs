import { deriveState, addInbox, processInbox, createProject, assignProjectBusiness, syncProject, syncAllProjects, syncFeishuInbox, setToday, updateTodo, updateProject, createBusiness, renameBusiness, deleteBusiness, updateWorkbenchConfig } from '../domain.mjs';
import { parseDateLike, compactText } from '../utils.mjs';
import { aiRuntimeConfig } from '../ai.mjs';

/**
 * The workbench exposes a deliberately small, allow-listed tool surface.
 * The registry is shared by the browser AI console and the MCP-compatible
 * JSON-RPC endpoint. Tools never receive arbitrary URLs, shell commands or
 * filesystem paths; mutating tools reuse the existing domain invariants.
 */

const nonEmptyString={type:'string',minLength:1};
const nullableString={anyOf:[nonEmptyString,{type:'null'}]};
const dateString={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'};

function toolError(message,statusCode=400){
  return Object.assign(new Error(message),{statusCode,code:'MCP_TOOL_INVALID_ARGUMENT'});
}

function requireObject(args){
  if(!args||typeof args!=='object'||Array.isArray(args))throw toolError('工具参数必须是 JSON 对象。');
  return args;
}

function requireString(args,key,label=key){
  if(typeof args[key]!=='string'||!args[key].trim())throw toolError(`${label} 必须是非空字符串。`);
  return args[key].trim();
}

function requireBoolean(args,key,label=key){
  if(typeof args[key]!=='boolean')throw toolError(`${label} 必须是布尔值。`);
  return args[key];
}

function requireDate(args,key,label=key){
  const value=requireString(args,key,label);
  if(!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)||Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)))throw toolError(`${label} 必须是合法的 YYYY-MM-DD 日期。`);
  return value;
}

function stateResult(context){
  return deriveState(context.appRoot,context.state,context.config,context.aiEnabled);
}

function descriptor({name,description,inputSchema={},readOnly=false,requiresConfirmation=false,execute}){
  return Object.freeze({name,description,inputSchema,readOnly,requiresConfirmation,execute});
}

export function createWorkbenchTools(){
  return [
    descriptor({
      name:'panel_navigate',
      description:'切换左侧人的工作面板，或打开一个白名单面板弹层；不会改变业务状态。',
      inputSchema:{type:'object',additionalProperties:false,properties:{view:{type:'string',enum:['today','inbox','tasks','journal','confirm','unclassified','overdue','archived','business','project']},id:nullableString,modal:{type:'string',enum:['settings','new_project','none']}},required:['view']},
      readOnly:true,
      execute:async(context,args)=>{
        const input=requireObject(args);
        const view=requireString(input,'view');
        const id=input.id===null||input.id===undefined?null:requireString(input,'id');
        const modal=input.modal===undefined?'none':requireString(input,'modal');
        if((view==='project'||view==='business')&&!id)throw toolError(`${view==='project'?'项目':'业务板块'}面板需要 id。`);
        if(view!=='project'&&view!=='business'&&id)throw toolError(`${view} 面板不接受 id。`);
        if(!['none','settings','new_project'].includes(modal))throw toolError('不支持的面板弹层。');
        if(view==='project'&&!context.state.projects.some(project=>project.id===id))throw toolError('目标项目不存在。',404);
        if(view==='business'&&!context.config.businesses.some(business=>business.id===id))throw toolError('目标业务板块不存在。',404);
        return {navigation:{view,id,modal},message:modal==='settings'?'打开工作台设置':modal==='new_project'?'打开新建项目':'切换左侧工作面板'};
      }
    }),
    descriptor({
      name:'workbench_get_state',
      description:'读取左侧工作面板的完整当前状态：收件箱、今日、待办、项目、待确认和工作日志。',
      readOnly:true,
      execute:async context=>stateResult(context)
    }),
    descriptor({
      name:'inbox_search',
      description:'搜索收件箱；不会分类、不会创建待办。',
      inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string'},limit:{type:'integer',minimum:1,maximum:50}},required:[]},
      readOnly:true,
      execute:async(context,args)=>{
        const input=requireObject(args);const query=String(input.query||'').trim().toLowerCase();const limit=Number.isInteger(input.limit)?Math.min(50,Math.max(1,input.limit)):20;
        return context.state.inbox.filter(item=>!query||String(item.text||'').toLowerCase().includes(query)).slice(0,limit);
      }
    }),
    descriptor({
      name:'inbox_add',
      description:'把一条新事项放入收件箱；所有新事项的第一站。',
      inputSchema:{type:'object',additionalProperties:false,properties:{text:nonEmptyString,source:{type:'string'}},required:['text']},
      requiresConfirmation:true,
      execute:async(context,args)=>addInbox({store:context.store,text:requireString(requireObject(args),'text'),source:typeof args.source==='string'&&args.source.trim()?args.source.trim():'ai-console'})
    }),
    descriptor({
      name:'inbox_process',
      description:'按用户明确指令处理一条收件箱事项：归入项目、创建有截止日期的待办、保存备忘或删除。',
      inputSchema:{type:'object',additionalProperties:false,properties:{itemId:nonEmptyString,command:nonEmptyString,targetProjectId:nullableString},required:['itemId','command']},
      requiresConfirmation:true,
      execute:async(context,args)=>{
        const input=requireObject(args);return processInbox({store:context.store,itemId:requireString(input,'itemId'),command:requireString(input,'command'),targetProjectId:input.targetProjectId===null||input.targetProjectId===undefined?null:requireString(input,'targetProjectId')});
      }
    }),
    descriptor({
      name:'project_list',
      description:'读取项目列表及其当前进度，不触发新的进度分析。',
      inputSchema:{type:'object',additionalProperties:false,properties:{includeArchived:{type:'boolean'}},required:[]},
      readOnly:true,
      execute:async(context,args)=>{
        const input=requireObject(args);const current=stateResult(context);return current.projects.filter(project=>input.includeArchived===true||!project.archived);
      }
    }),
    descriptor({
      name:'project_create',
      description:'从已有收件箱来源创建项目；必须有明确计划结束日期，不会绕过收件箱。',
      inputSchema:{type:'object',additionalProperties:false,properties:{description:nonEmptyString,endDate:dateString,sourceInboxId:nonEmptyString,businessId:nullableString},required:['description','endDate','sourceInboxId']},
      requiresConfirmation:true,
      execute:async(context,args)=>{
        const input=requireObject(args);return createProject({appRoot:context.appRoot,store:context.store,description:requireString(input,'description'),endDate:requireDate(input,'endDate','计划结束日期'),businessId:input.businessId===null||input.businessId===undefined?null:requireString(input,'businessId'),sourceInboxId:requireString(input,'sourceInboxId')});
      }
    }),
    descriptor({
      name:'project_classify',
      description:'把待归类项目放入用户指定业务板块，并创建对应真实本地目录。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:nonEmptyString,businessId:nonEmptyString},required:['projectId','businessId']},
      requiresConfirmation:true,
      execute:async(context,args)=>{const input=requireObject(args);return assignProjectBusiness({appRoot:context.appRoot,store:context.store,projectId:requireString(input,'projectId'),businessId:requireString(input,'businessId')});}
    }),
    descriptor({
      name:'project_update',
      description:'更新项目介绍、链接、结束日期或完成/归档状态；只接受白名单字段。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:nonEmptyString,intro:{type:'string'},git:{type:'string'},feishu:{type:'string'},completed:{type:'boolean'},archived:{type:'boolean'},endDate:dateString},required:['projectId']},
      requiresConfirmation:true,
      execute:async(context,args)=>{
        const input=requireObject(args);const patch={};for(const key of ['intro','git','feishu','completed','archived','endDate'])if(Object.hasOwn(input,key))patch[key]=key==='endDate'?requireDate(input,key):input[key];
        return updateProject({appRoot:context.appRoot,store:context.store,projectId:requireString(input,'projectId'),patch});
      }
    }),
    descriptor({
      name:'project_sync',
      description:'用户确认后主动同步一个项目的本地文件/Git 证据并读回进度。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:nonEmptyString},required:['projectId']},
      requiresConfirmation:true,
      execute:async(context,args)=>syncProject({appRoot:context.appRoot,store:context.store,projectId:requireString(requireObject(args),'projectId')})
    }),
    descriptor({
      name:'projects_sync_all',
      description:'用户确认后主动同步所有可访问项目的进度。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      requiresConfirmation:true,
      execute:async context=>syncAllProjects({appRoot:context.appRoot,store:context.store})
    }),
    descriptor({
      name:'todo_list',
      description:'读取待办及今日计划状态；不会自动把任何待办加入今日。',
      inputSchema:{type:'object',additionalProperties:false,properties:{includeDone:{type:'boolean'}},required:[]},
      readOnly:true,
      execute:async(context,args)=>{const input=requireObject(args);const current=stateResult(context);return {todos:current.todos.filter(todo=>input.includeDone===true||!todo.done),todayPlan:current.todayPlan,todayPlanDate:current.todayPlanDate};}
    }),
    descriptor({
      name:'todo_update',
      description:'更新已有待办；截止日期仍然必须合法，完成待办会从今日计划移除。',
      inputSchema:{type:'object',additionalProperties:false,properties:{todoId:nonEmptyString,title:{type:'string'},context:{type:'string'},dueDate:dateString,done:{type:'boolean'}},required:['todoId']},
      requiresConfirmation:true,
      execute:async(context,args)=>{const input=requireObject(args);const patch={};for(const key of ['title','context','dueDate','done'])if(Object.hasOwn(input,key))patch[key]=key==='dueDate'?requireDate(input,key,'截止日期'):input[key];return updateTodo({store:context.store,todoId:requireString(input,'todoId'),patch});}
    }),
    descriptor({
      name:'todo_today',
      description:'在用户明确确认后把待办加入或移出今日工作台。',
      inputSchema:{type:'object',additionalProperties:false,properties:{todoId:nonEmptyString,add:{type:'boolean'}},required:['todoId','add']},
      requiresConfirmation:true,
      execute:async(context,args)=>{const input=requireObject(args);return setToday({store:context.store,todoId:requireString(input,'todoId'),add:requireBoolean(input,'add')});}
    }),
    descriptor({
      name:'feishu_inbox_sync',
      description:'读取飞书每日工作日记中的收件箱章节并同步到左侧收件箱缓存。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      requiresConfirmation:true,
      execute:async context=>syncFeishuInbox({store:context.store})
    }),
    descriptor({
      name:'journal_read',
      description:'读取工作日志，帮助 AI 恢复最近工作现场。',
      inputSchema:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100}},required:[]},
      readOnly:true,
      execute:async(context,args)=>{const input=requireObject(args);const limit=Number.isInteger(input.limit)?Math.min(100,Math.max(1,input.limit)):30;return context.state.activities.slice(0,limit);}
    }),
    descriptor({
      name:'confirmation_list',
      description:'读取待确认事项；AI 判断不准的内容统一在这里。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      readOnly:true,
      execute:async context=>context.state.confirmations
    }),
    descriptor({
      name:'confirmation_clear',
      description:'用户明确表示已处理后清除一条待确认事项。',
      inputSchema:{type:'object',additionalProperties:false,properties:{id:nonEmptyString},required:['id']},
      requiresConfirmation:true,
      execute:async(context,args)=>{const id=requireString(requireObject(args),'id');let removed=false;await context.store.updateState(state=>{const before=state.confirmations.length;state.confirmations=state.confirmations.filter(item=>item.id!==id);removed=before!==state.confirmations.length;});return {ok:removed};}
    }),
    descriptor({
      name:'business_list',
      description:'读取业务板块及其项目数量。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      readOnly:true,
      execute:async context=>stateResult(context).businesses.map(business=>({...business,projectCount:context.state.projects.filter(project=>project.businessId===business.id&&!project.archived).length}))
    }),
    descriptor({
      name:'business_create',
      description:'创建一个业务板块并建立对应的一级本地目录。',
      inputSchema:{type:'object',additionalProperties:false,properties:{name:nonEmptyString},required:['name']},
      requiresConfirmation:true,
      execute:async(context,args)=>createBusiness({appRoot:context.appRoot,store:context.store,name:requireString(requireObject(args),'name')})
    }),
    descriptor({
      name:'business_rename',
      description:'重命名业务板块并同步本地一级目录。',
      inputSchema:{type:'object',additionalProperties:false,properties:{businessId:nonEmptyString,name:nonEmptyString},required:['businessId','name']},
      requiresConfirmation:true,
      execute:async(context,args)=>{const input=requireObject(args);return renameBusiness({appRoot:context.appRoot,store:context.store,businessId:requireString(input,'businessId'),name:requireString(input,'name')});}
    }),
    descriptor({
      name:'business_delete',
      description:'删除没有项目的业务板块配置；不会删除原有本地目录。',
      inputSchema:{type:'object',additionalProperties:false,properties:{businessId:nonEmptyString},required:['businessId']},
      requiresConfirmation:true,
      execute:async(context,args)=>deleteBusiness({store:context.store,businessId:requireString(requireObject(args),'businessId')})
    }),
    descriptor({
      name:'config_read',
      description:'读取工作区、数据源和工作台设置；不返回凭证。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      readOnly:true,
      execute:async context=>context.config
    }),
    descriptor({
      name:'config_update',
      description:'在白名单范围内更新工作区路径、设置或飞书数据源。',
      inputSchema:{type:'object',additionalProperties:false,properties:{workspaceRoot:{type:'string'},settings:{type:'object'},dataSource:{type:['object','null']}},required:[]},
      requiresConfirmation:true,
      execute:async(context,args)=>{const input=requireObject(args);return updateWorkbenchConfig({appRoot:context.appRoot,store:context.store,workspaceRoot:input.workspaceRoot,settings:input.settings,dataSource:input.dataSource});}
    }),
    descriptor({
      name:'backup_create',
      description:'创建一份本机状态与配置备份。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      requiresConfirmation:true,
      execute:async context=>({file:await context.store.backupNow()})
    })
  ];
}

export function publicTool(tool){
  const {execute:_,...meta}=tool;return meta;
}

export function findTool(tools,name){return tools.find(tool=>tool.name===name)||null;}

export function contextFrom({appRoot,store,state,config,aiEnabled=false}){return {appRoot,store,state,config,aiEnabled};}

function findInboxItem(state,text){
  const needle=String(text||'').trim().toLowerCase();if(!needle)return null;
  return state.inbox.find(item=>item.text.toLowerCase()===needle)||state.inbox.find(item=>item.text.toLowerCase().includes(needle))||null;
}

function findByTitle(items,text){
  const needle=String(text||'').replace(/[“”"']/g,'').trim().toLowerCase();if(!needle)return null;
  return items.find(item=>String(item.title||item.name||'').toLowerCase()===needle)||items.find(item=>String(item.title||item.name||'').toLowerCase().includes(needle))||null;
}

/**
 * Small deterministic command-to-tool planner used by the local AI console.
 * A future model can replace only this planner; execution and safety remain
 * in the same registry. Unknown or ambiguous commands stay read-only.
 */
export function planWorkbenchMessage({message,state}){
  const text=String(message||'').trim();
  const normalized=text.replace(/\s/g,'');
  if(!text)return {kind:'clarification',message:'告诉我你想查看什么，或明确说出一个动作。我不会替你安排今日任务。'};
  if(/新建项目|创建项目|设置|打开设置/.test(text)){
    if(/新建项目|创建项目/.test(text))return {kind:'tool',toolName:'panel_navigate',args:{view:'today',id:null,modal:'new_project'},reason:'打开左侧新建项目弹层，后续仍需你确认截止日期。'};
    return {kind:'tool',toolName:'panel_navigate',args:{view:'today',id:null,modal:'settings'},reason:'打开左侧工作台设置弹层。'};
  }
  if(/打开|进入|切换到|去/.test(text)){
    const destinations=[
      [/收件箱/,'inbox'],[/待办|任务/,'tasks'],[/工作日志|日志/,'journal'],[/待确认/,'confirm'],[/待归类/,'unclassified'],[/逾期/,'overdue'],[/已归档|归档/,'archived'],[/今日|今天/,'today']
    ];
    const destination=destinations.find(([pattern])=>pattern.test(text));
    if(destination)return {kind:'tool',toolName:'panel_navigate',args:{view:destination[1],id:null,modal:'none'},reason:`切换左侧到${destination[1]==='today'?'今日工作台':destination[1]}。`};
    const project=findByTitle(state.projects,text.replace(/打开|进入|切换到|去|项目|页面|看一下|请|帮我/g,''));
    if(project)return {kind:'tool',toolName:'panel_navigate',args:{view:'project',id:project.id,modal:'none'},reason:`打开左侧项目「${project.name}」。`};
    const business=findByTitle(state.businesses,text.replace(/打开|进入|切换到|去|业务板块|板块|页面|看一下|请|帮我/g,''));
    if(business)return {kind:'tool',toolName:'panel_navigate',args:{view:'business',id:business.id,modal:'none'},reason:`打开左侧业务板块「${business.name}」。`};
  }
  if(/同步飞书|读回飞书|飞书收件箱/.test(text))return {kind:'tool',toolName:'feishu_inbox_sync',args:{},reason:'读取飞书收件箱来源并刷新左侧缓存。'};
  if(/同步所有项目|全部项目进度/.test(text))return {kind:'tool',toolName:'projects_sync_all',args:{},reason:'按你的明确指令主动同步所有项目进度。'};
  if(/同步.*项目|项目.*同步/.test(text)){
    const project=findByTitle(state.projects,text.replace(/同步|项目|进度|一下|请|帮我/g,''));
    if(project)return {kind:'tool',toolName:'project_sync',args:{projectId:project.id},reason:`主动读取「${project.name}」的本地文件和 Git 证据。`};
  }
  if(/加入今日|放进今日|移出今日|取消今日/.test(text)){
    const add=!/移出|取消/.test(text);const todo=findByTitle(state.todos,text.replace(/加入今日|放进今日|移出今日|取消今日|请|帮我/g,''));
    if(!todo)return {kind:'clarification',message:'我需要你指出具体待办标题；今日任务只能由你明确加入。'};
    return {kind:'tool',toolName:'todo_today',args:{todoId:todo.id,add},reason:`${add?'加入':'移出'}今日工作台「${todo.title}」；这一步需要你的确认。`};
  }
  if(/完成|标记完成|勾掉/.test(text)&&/待办|任务/.test(text)){
    const todo=findByTitle(state.todos,text.replace(/完成|标记完成|勾掉|待办|任务|请|帮我/g,''));
    if(todo)return {kind:'tool',toolName:'todo_update',args:{todoId:todo.id,done:true},reason:`把已有待办「${todo.title}」标记完成。`};
  }
  if(/做成待办|变成待办|创建待办|独立待办/.test(text)){
    const due=parseDateLike(text);const inbox=state.inbox.find(item=>text.includes(item.text)||normalized.includes(item.text.replace(/\s/g,'')));
    if(!inbox)return {kind:'clarification',message:'请指出要处理的收件箱事项；新待办必须从收件箱产生。'};
    if(!due)return {kind:'clarification',message:`「${compactText(inbox.text,60)}」可以做成待办，但还缺少明确截止日期。`};
    return {kind:'tool',toolName:'inbox_process',args:{itemId:inbox.id,command:text},reason:`从收件箱「${compactText(inbox.text,60)}」创建有截止日期的待办；不会自动加入今日。`};
  }
  if(/归入|放到|放进/.test(text)&&/项目/.test(text)){
    const inbox=state.inbox.find(item=>text.includes(item.text)||normalized.includes(item.text.replace(/\s/g,'')));
    if(inbox)return {kind:'tool',toolName:'inbox_process',args:{itemId:inbox.id,command:text},reason:`按你的明确指令处理收件箱事项「${compactText(inbox.text,60)}」。`};
  }
  if(/收件箱|新事项|最近记下/.test(text))return {kind:'tool',toolName:'inbox_search',args:{query:'',limit:20},reason:'读取左侧收件箱，不做分类。'};
  if(/待办|任务|今日/.test(text))return {kind:'tool',toolName:'todo_list',args:{includeDone:false},reason:'读取待办和今日计划；不自动改动今日计划。'};
  if(/项目|进度/.test(text))return {kind:'tool',toolName:'project_list',args:{includeArchived:false},reason:'读取项目当前状态，不触发后台同步。'};
  if(/日志|工作现场|最近做了什么/.test(text))return {kind:'tool',toolName:'journal_read',args:{limit:30},reason:'读取最近工作日志。'};
  return {kind:'clarification',message:'我还不能安全地把这句话映射成唯一工具。你可以说“查看收件箱”“查看待办”“同步飞书”，或明确一个待办/项目动作。'};
}
