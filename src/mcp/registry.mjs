import { aiEnabled, aiRuntimeConfig, planAIConsole } from '../ai.mjs';
import { matchesSchema } from '../ai/schema-validation.mjs';
import { deriveState } from '../domain.mjs';
import { createWorkbenchTools, contextFrom, findTool, planWorkbenchMessage, publicTool } from './tools.mjs';
import { createProjectRecordTools } from './project-record-tools.mjs';

function mcpError(message,code='MCP_INVALID_REQUEST',statusCode=400){
  return Object.assign(new Error(message),{code,statusCode});
}

export function createWorkbenchRegistry({appRoot,store}={}){
  if(!appRoot||!store)throw new Error('MCP registry requires appRoot and store');
  const tools=[...createWorkbenchTools(),...createProjectRecordTools()];

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
    // A tool result is never treated as the canonical UI state. Always read
    // state again after execution so the two panels converge on persisted data.
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
        // A stale or invalid provider configuration must never make the
        // control plane unusable; the deterministic planner is the safe
        // local fallback and does not issue a network request.
        console.warn('[AI console planner fallback]',error.message);
      }
    }
    if(!planned)planned=planWorkbenchMessage({message,state:derived});
    const tool=planned.toolName?findTool(tools,planned.toolName):null;
    if(planned.toolName&&!tool){
      return {
        kind:'clarification',message:'模型提出的工具不在本工作台白名单中，我没有执行。请重新描述你的目标。',toolName:null,args:{},reason:'工具白名单校验未通过。',tool:null,
        state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null
      };
    }
    if(tool){
      try{validateArguments(tool,planned.args||{});}
      catch(error){
        return {
          kind:'clarification',message:'模型提出的参数未通过本地校验，我没有执行。请补齐或改写明确参数。',toolName:null,args:{},reason:error.message,tool:null,
          state:derived,confirmationRequired:false,planner,plannerModel,analysis:planned.analysis||null
        };
      }
    }
    return {
      ...planned,
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
