import { readJsonBody, sendJson } from './http.mjs';
import { validateRequestBody, requestSchemas } from './request-validation.mjs';
import { harnessBridgeAuthorized } from './harness-auth.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from './harness-policy.mjs';
import { PRODUCT_VERSION } from './product.mjs';

function jsonRpcResult(id,result){return {jsonrpc:'2.0',id,result};}
function jsonRpcErrorCode(error){
  switch(error?.code){
    case 'MCP_CONFIRMATION_REQUIRED':
      return -32001;
    case 'MCP_TOOL_NOT_FOUND':
      return -32601;
    case 'MCP_TOOL_NOT_ALLOWED':
      return -32003;
    default:
      return -32602;
  }
}
function jsonRpcError(id,error){
  return {
    jsonrpc:'2.0',
    id,
    error:{
      code:jsonRpcErrorCode(error),
      message:error?.message||'MCP 请求失败'
    }
  };
}

async function requestBody(req,schema){
  return validateRequestBody(await readJsonBody(req),schema);
}

function methodNotAllowed(res,allowed){
  return sendJson(res,405,{error:'Method not allowed'},{Allow:allowed});
}

function validatedSessionRef(value){
  if(value===undefined||value===null)return null;
  const sessionRef=String(value);
  if(!/^sess_[a-f0-9]{32}$/.test(sessionRef)){
    throw Object.assign(new Error('sessionRef 格式无效。'),{code:'MCP_INVALID_PARAMS'});
  }
  return sessionRef;
}

function resolveSessionRef(params={},sessionRefResolver=null){
  const explicitSessionRef=validatedSessionRef(params?._meta?.sessionRef);
  const trustedSessionRef=validatedSessionRef(sessionRefResolver?.());
  if(explicitSessionRef&&trustedSessionRef&&explicitSessionRef!==trustedSessionRef){
    throw Object.assign(new Error('sessionRef 与当前可信会话不一致。'),{code:'MCP_INVALID_PARAMS'});
  }
  return trustedSessionRef||explicitSessionRef;
}

export function createHarnessHttp({
  navigator,
  mcpRegistry,
  toolBroker=null,
  driver=null,
  sessionRefResolver=null,
  /**
   * Per-user harness context resolver.
   * If provided, called as resolveUserDriver(userId) to return a {driver,sessionManager} object.
   * Falls back to the shared driver if userId is null or resolveUserDriver returns null.
   */
  resolveUserDriver=null
}={}){
  if(!navigator||!mcpRegistry)throw new Error('createHarnessHttp requires navigator and mcpRegistry');
  // inbox_add 是写入工具（requiresConfirmation），需要 confirmed 才能执行；
  // 其余工具仍为只读。readOnlyOnly=false 让 inbox_add 通过 toolAllowed 过滤。
  const toolOptions={readOnlyOnly:false,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST,confirmed:true};

  async function checkedStatus(){
    if(typeof navigator.checkedStatus==='function')return navigator.checkedStatus();
    return navigator.status();
  }

  async function callTool(params,scopedStore=null){
    if(typeof params.name!=='string'||!params.name.trim()){
      throw Object.assign(new Error('tools/call 需要 name。'),{code:'MCP_INVALID_PARAMS'});
    }
    const args=params.arguments||{};
    const opts={...toolOptions};
    if(scopedStore)opts.store=scopedStore;
    if(!toolBroker)return mcpRegistry.call(params.name,args,opts);
    return toolBroker.call({
      name:params.name,
      arguments:args,
      options:opts,
      trigger:'harness-http',
      sessionRef:resolveSessionRef(params,sessionRefResolver)
    });
  }

  async function handleBridge(req,res,pathname,bridgeStore=null){
    if(pathname!=='/api/harness/mcp')return false;
    if(req.method!=='POST'){methodNotAllowed(res,'POST');return true;}
    if(!harnessBridgeAuthorized(req,navigator.bridgeToken)){
      sendJson(res,403,{error:'Harness bridge denied'});
      return true;
    }
    const body=await requestBody(req,requestSchemas.mcp);
    const id=Object.hasOwn(body,'id')?body.id:null;
    try{
      if(body.jsonrpc!=='2.0')throw Object.assign(new Error('jsonrpc 必须是 2.0。'),{code:'MCP_INVALID_REQUEST'});
      const params=body.params&&typeof body.params==='object'?body.params:{};
      if(body.method==='initialize'){
        sendJson(res,200,jsonRpcResult(id,{
          protocolVersion:'2025-06-18',
          capabilities:{tools:{listChanged:false}},
          serverInfo:{name:'personal-ai-workbench-unified-copilot',version:PRODUCT_VERSION}
        }));
        return true;
      }
      if(body.method==='notifications/initialized'){
        sendJson(res,200,jsonRpcResult(id,{}));
        return true;
      }
      if(body.method==='tools/list'){
        const tools=toolBroker?toolBroker.list(toolOptions):mcpRegistry.list(toolOptions);
        sendJson(res,200,jsonRpcResult(id,{tools}));
        return true;
      }
      if(body.method==='tools/call'){
        const outcome=await callTool(params,bridgeStore);
        sendJson(res,200,jsonRpcResult(id,{
          content:[{type:'text',text:JSON.stringify(outcome.result)}],
          structuredContent:{result:outcome.result,readback:true}
        }));
        return true;
      }
      throw Object.assign(new Error(`未知 MCP 方法：${body.method}`),{code:'MCP_METHOD_NOT_FOUND'});
    }catch(error){
      sendJson(res,200,jsonRpcError(id,error));
      return true;
    }
  }

  async function handleUser(req,res,pathname,{rateLimit}={},userId=null,scopedStore=null,sessionUser=null){
    if(pathname==='/api/harness/status'){
      if(req.method!=='GET'){methodNotAllowed(res,'GET');return true;}
      sendJson(res,200,{navigator:await checkedStatus(),capabilityMode:'read_and_preview'});
      return true;
    }
    if(pathname==='/api/harness/navigator'){
      if(req.method!=='POST'){methodNotAllowed(res,'POST');return true;}
      const body=await requestBody(req,requestSchemas.harnessNavigator);
      if(typeof rateLimit==='function'&&rateLimit())return true;
      const route={view:body.view||'today',id:body.id??null};
      // 注入当前用户上下文，供 Copilot 系统提示词感知多用户
      if(sessionUser){
        route.user={
          username:sessionUser.username||sessionUser.name||sessionUser.uid||'',
          displayName:sessionUser.name||'',
          role:sessionUser.role||''
        };
      }
      // Resolve per-user driver if available
      let activeDriver=driver;
      if(userId&&resolveUserDriver){
        const userCtx=resolveUserDriver(userId);
        if(userCtx?.driver)activeDriver=userCtx.driver;
      }
      const result=activeDriver
        ?await activeDriver.run({message:body.message,sessionId:body.sessionId??null,route,userId})
        :await navigator.run({message:body.message,sessionId:body.sessionId??null,route,userId});
      sendJson(res,200,{ok:true,navigator:result,status:await checkedStatus(),capabilityMode:'read_and_preview'});
      return true;
    }
    if(pathname==='/api/harness/switch-model'){
      if(req.method!=='POST'){methodNotAllowed(res,'POST');return true;}
      const body=await requestBody(req,requestSchemas.harnessSwitchModel);
      if(typeof rateLimit==='function'&&rateLimit())return true;
      try{
        // 多用户模式下，模型切换为 per-user 偏好，不影响其他用户
        const result=await navigator.switchModel(body.model, userId||null);
        sendJson(res,200,{ok:true,result,status:await checkedStatus(),capabilityMode:'read_and_preview'});
      }catch(error){
        const statusCode=error?.statusCode||400;
        sendJson(res,statusCode,{ok:false,error:String(error?.message||'模型切换失败'),code:String(error?.code||'SWITCH_MODEL_FAILED')});
      }
      return true;
    }
    return false;
  }

  return Object.freeze({handleBridge,handleUser});
}
