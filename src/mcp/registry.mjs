import { aiEnabled, aiRuntimeConfig, planAIConsole } from '../ai.mjs';
import { matchesSchema } from '../ai/schema-validation.mjs';
import { deriveState } from '../domain.mjs';
import { enforceInboxReviewPlan, inboxReviewPlannerMessage, isInboxReviewRoute, scopedInboxReviewState, scopedInboxReviewTools } from '../ai-review-scope.mjs';
import { localDiaryReviewPlan, planDiaryReviewAI } from '../diary-review-planner.mjs';
import { createWorkbenchTools, contextFrom, findTool, planWorkbenchMessage, publicTool } from './tools.mjs';
import { createProjectRecordTools, planProjectRecordMessage } from './project-record-tools.mjs';
import { createContentTools, planContentMessage } from './content-tools.mjs';
import { createJoycrewTools, planJoycrewMessage } from './joycrew-tools.mjs';

function mcpError(message,code='MCP_INVALID_REQUEST',statusCode=400){
  return Object.assign(new Error(message),{code,statusCode});
}

function normalizedAllowedNames(value){
  if(value===undefined||value===null)return null;
  const values=Array.isArray(value)?value:value instanceof Set?[...value]:[];
  return new Set(values.filter(name=>typeof name==='string'&&name));
}

function toolAllowed(tool,{readOnlyOnly=false,allowedNames=null}={}){
  if(!tool)return false;
  if(readOnlyOnly&&tool.readOnly!==true)return false;
  const names=normalizedAllowedNames(allowedNames);
  return names===null||names.has(tool.name);
}

function planGuard(tool,args,state){
  if(tool?.name!=='todo_today'||args?.add!==true)return null;
  const todo=state.todos.find(candidate=>candidate.id===args.todoId);
  if(!todo){
    return {message:'目标待办不存在，我没有生成加入今日的操作预览。',reason:'todo_today 预检未找到目标待办。'};
  }
  if(todo.done){
    return {message:`「${todo.title}」已经完成，不能加入今日工作台。请先恢复为未完成，再由你决定是否加入今日。`,reason:'已完成待办被今日计划领域规则排除。'};
  }
  return null;
}

export function createWorkbenchRegistry({appRoot,store,joycrewClient=null,joycrewActions=null}={}){
  if(!appRoot||!store)throw new Error('MCP registry requires appRoot and store');
  // Feishu inbox/diary is the primary personal intake surface. Legacy GetNote
  // task tools stay only for compatibility/migration and are not registered
  // into the interactive AI/MCP capability surface anymore.
  const workbenchTools=createWorkbenchTools();
  const joycrewTools=joycrewClient&&joycrewActions?createJoycrewTools({client:joycrewClient,actions:joycrewActions}):[];
  const tools=[...workbenchTools,...createProjectRecordTools(),...createContentTools(),...joycrewTools];

  async function context(){
    const [state,config]=await Promise.all([store.readState(),store.readConfig()]);
    return {...contextFrom({appRoot,store,state,config,aiEnabled:aiEnabled()}),joycrewClient,joycrewActions};
  }

  function list(options={}){
    return tools.filter(tool=>toolAllowed(tool,options)).map(publicTool);
  }

  function validateArguments(tool,args){
    const input=args===undefined?{}:args;
    if(!matchesSchema(input,tool.inputSchema)){
      throw mcpError(`工具 ${tool.name} 的参数未通过本地 schema 校验。请重新描述，或补齐必填字段。`,'MCP_INVALID_PARAMS',400);
    }
    return input;
  }

  async function call(name,args={},options={}){
    const tool=findTool(tools,name);
    if(!tool)throw mcpError(`未知 MCP 工具：${name}`,'MCP_TOOL_NOT_FOUND',404);
    if(!toolAllowed(tool,options))throw mcpError(`工具 ${name} 不在本次调用的能力白名单中。`,'MCP_TOOL_NOT_ALLOWED',403);
    if(tool.requiresConfirmation&&!options.confirmed){
      throw mcpError(`工具 ${name} 会改变工作台状态，必须先展示影响范围并获得确认。`,'MCP_CONFIRMATION_REQUIRED',409);
    }
    const input=validateArguments(tool,args);
    const result=await tool.execute(await context(),input);
    const after=await context();
    return {result,state:deriveState(after.appRoot,after.state,after.config,after.aiEnabled),tool:publicTool(tool)};
  }

  async function plan(message,route={}){
    const current=await context();
    const derived=deriveState(current.appRoot,current.state,current.config,current.aiEnabled);
    const modelState=scopedInboxReviewState(derived,route);
    const modelTools=scopedInboxReviewTools(list(),route);
    const plannerMessage=inboxReviewPlannerMessage(derived,route,message);
    const diaryReview=isInboxReviewRoute(route)&&modelState.inbox?.[0]?.text?.startsWith('[飞书混合日记');
    let planned=null;
    let planner='local_fallback';
    let plannerModel=null;
    if(current.aiEnabled){
      try{
        const runtime=aiRuntimeConfig();
        plannerModel=runtime.model||null;
        planned=diaryReview
          ?await planDiaryReviewAI({state:modelState,route})
          :await planAIConsole({message:plannerMessage,state:modelState,tools:modelTools,route});
        if(planned)planner='model';
      }catch(error){console.warn('[AI console planner fallback]',error.message);}
    }
    if(!planned&&diaryReview)planned=localDiaryReviewPlan({state:modelState,route});
    if(!planned)planned=planJoycrewMessage({message:plannerMessage,state:modelState});
    if(!planned)planned=planContentMessage({message:plannerMessage,state:modelState});
    if(!planned)planned=planProjectRecordMessage({message:plannerMessage,state:modelState});
    if(!planned)planned=planWorkbenchMessage({message:plannerMessage,state:modelState});
    planned=enforceInboxReviewPlan(planned,route);
    const tool=planned.toolName?findTool(tools,planned.toolName):null;
    if(planned.toolName&&!tool){
      return {kind:'clarification',message:'这个入口当前不可用。个人工作事项主来源是飞书日记；得到大脑只保留“自媒体”内容采集；企业 AI 员工能力需要先配置 Joycrew。',toolName:null,args:{},reason:'目标工具未在当前白名单中注册。',tool:null,state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null,category:planned.category||null,destination:planned.destination||null,confidence:planned.confidence??null};
    }
    let input=planned.args||{};
    if(tool){
      try{input=validateArguments(tool,input);}catch(error){
        return {kind:'clarification',message:'模型提出的参数未通过本地校验，我没有执行。请补齐或改写明确参数。',toolName:null,args:{},reason:error.message,tool:null,state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null,category:planned.category||null,destination:planned.destination||null,confidence:planned.confidence??null};
      }
      const guarded=planGuard(tool,input,derived);
      if(guarded){
        return {kind:'clarification',message:guarded.message,toolName:null,args:{},reason:guarded.reason,tool:null,state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null,category:planned.category||null,destination:planned.destination||null,confidence:planned.confidence??null};
      }
    }
    return {...planned,args:input,tool:tool?publicTool(tool):null,state:derived,confirmationRequired:Boolean(tool?.requiresConfirmation),planner,plannerModel,analysis:planned.analysis||null};
  }

  return Object.freeze({list,call,plan,tools});
}

export function jsonRpcResult(id,result){return {jsonrpc:'2.0',id,result};}
export function jsonRpcError(id,error){
  const code=error?.code==='MCP_CONFIRMATION_REQUIRED'?-32001:error?.code==='MCP_TOOL_NOT_FOUND'?-32601:error?.code==='MCP_TOOL_NOT_ALLOWED'?-32003:-32602;
  return {jsonrpc:'2.0',id,error:{code,message:error?.message||'MCP 请求失败'}};
}
