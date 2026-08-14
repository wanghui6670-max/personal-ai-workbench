import { aiEnabled, aiRuntimeConfig, planAIConsole } from '../ai.mjs';
import { matchesSchema } from '../ai/schema-validation.mjs';
import { deriveState } from '../domain.mjs';
import { createWorkbenchTools, contextFrom, findTool, planWorkbenchMessage, publicTool } from './tools.mjs';
import { createProjectRecordTools, planProjectRecordMessage } from './project-record-tools.mjs';
import { createExternalTaskTools, planExternalTaskMessage } from './external-task-tools.mjs';

function mcpError(message,code='MCP_INVALID_REQUEST',statusCode=400){
  return Object.assign(new Error(message),{code,statusCode});
}

function planGuard(tool,args,state){
  if(tool?.name!=='todo_today'||args?.add!==true)return null;
  const todo=state.todos.find(candidate=>candidate.id===args.todoId);
  if(!todo){
    return {
      message:'目标待办不存在，我没有生成加入今日的操作预览。',
      reason:'todo_today 预检未找到目标待办。'
    };
  }
  if(todo.done){
    return {
      message:`「${todo.title}」已经完成，不能加入今日工作台。请先恢复为未完成，再由你决定是否加入今日。`,
      reason:'已完成待办被今日计划领域规则排除。'
    };
  }
  return null;
}

export function createWorkbenchRegistry({appRoot,store}={}){
  if(!appRoot||!store)throw new Error('MCP registry requires appRoot and store');
  const workbenchTools=createWorkbenchTools().filter(tool=>tool.name!=='feishu_inbox_sync');
  const tools=[...workbenchTools,...createProjectRecordTools(),...createExternalTaskTools()];

  async function context(){
    const [state,config]=await Promise.all([store.readState(),store.readConfig()]);
    return contextFrom({appRoot,store,state,config,aiEnabled:aiEnabled()});
  }

  function list(){return tools.map(publicTool);}

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
    let planned=null;
    let planner='local_fallback';
    let plannerModel=null;
    if(current.aiEnabled){
      try{
        const runtime=aiRuntimeConfig();
        plannerModel=runtime.model||null;
        planned=await planAIConsole({message,state:derived,tools:list(),route});
        if(planned)planner='model';
      }catch(error){
        console.warn('[AI console planner fallback]',error.message);
      }
    }
    if(!planned)planned=planExternalTaskMessage({message,state:derived});
    if(!planned)planned=planProjectRecordMessage({message,state:derived});
    if(!planned)planned=planWorkbenchMessage({message,state:derived});
    const tool=planned.toolName?findTool(tools,planned.toolName):null;
    if(planned.toolName&&!tool){
      return {
        kind:'clarification',message:'这个入口已经停用，当前待办来源是滴答清单 CLI。请说“同步滴答待办”，或打开设置检查新管线。',toolName:null,args:{},reason:'旧飞书收件箱工具已从白名单移除。',tool:null,
        state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null
      };
    }
    let input=planned.args||{};
    if(tool){
      try{input=validateArguments(tool,input);}
      catch(error){
        return {
          kind:'clarification',message:'模型提出的参数未通过本地校验，我没有执行。请补齐或改写明确参数。',toolName:null,args:{},reason:error.message,tool:null,
          state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null
        };
      }
      const guarded=planGuard(tool,input,derived);
      if(guarded){
        return {
          kind:'clarification',message:guarded.message,toolName:null,args:{},reason:guarded.reason,tool:null,
          state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null
        };
      }
    }
    return {
      ...planned,
      args:input,
      tool:tool?publicTool(tool):null,
      state:derived,
      confirmationRequired:Boolean(tool?.requiresConfirmation),
      planner,
      plannerModel,
      analysis:planned.analysis||null
    };
  }

  return Object.freeze({list,call,plan,tools});
}

export function jsonRpcResult(id,result){return {jsonrpc:'2.0',id,result};}
export function jsonRpcError(id,error){
  const code=error?.code==='MCP_CONFIRMATION_REQUIRED'?-32001:error?.code==='MCP_TOOL_NOT_FOUND'?-32601:-32602;
  return {jsonrpc:'2.0',id,error:{code,message:error?.message||'MCP 请求失败'}};
}
