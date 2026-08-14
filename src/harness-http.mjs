import { readJsonBody, sendJson } from './http.mjs';
import { validateRequestBody, requestSchemas } from './request-validation.mjs';
import { harnessBridgeAuthorized } from './harness-auth.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from './harness-policy.mjs';


function jsonRpcResult(id,result){return {jsonrpc:'2.0',id,result};}
function jsonRpcError(id,error){
  const code=error?.code==='MCP_CONFIRMATION_REQUIRED'?-32001:error?.code==='MCP_TOOL_NOT_FOUND'?-32601:error?.code==='MCP_TOOL_NOT_ALLOWED'?-32003:-32602;
  return {jsonrpc:'2.0',id,error:{code,message:error?.message||'MCP 请求失败'}};
}

async function requestBody(req,schema){
  return validateRequestBody(await readJsonBody(req),schema);
}

function methodNotAllowed(res,allowed){
  return sendJson(res,405,{error:'Method not allowed'},{Allow:allowed});
}

export function createHarnessHttp({navigator,mcpRegistry}={}){
  if(!navigator||!mcpRegistry)throw new Error('createHarnessHttp requires navigator and mcpRegistry');
  const toolOptions={readOnlyOnly:true,allowedNames:HARNESS_NAVIGATOR_TOOL_ALLOWLIST};

  async function handleBridge(req,res,pathname){
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
          serverInfo:{name:'personal-ai-workbench-navigator-readonly',version:'1.2.0'}
        }));
        return true;
      }
      if(body.method==='notifications/initialized'){
        sendJson(res,200,jsonRpcResult(id,{}));
        return true;
      }
      if(body.method==='tools/list'){
        sendJson(res,200,jsonRpcResult(id,{tools:mcpRegistry.list(toolOptions)}));
        return true;
      }
      if(body.method==='tools/call'){
        if(typeof params.name!=='string'||!params.name.trim()){
          throw Object.assign(new Error('tools/call 需要 name。'),{code:'MCP_INVALID_PARAMS'});
        }
        const outcome=await mcpRegistry.call(params.name,params.arguments||{},toolOptions);
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

  async function handleUser(req,res,pathname,{rateLimit}={}){
    if(pathname==='/api/harness/status'){
      if(req.method!=='GET'){methodNotAllowed(res,'GET');return true;}
      sendJson(res,200,{navigator:navigator.status()});
      return true;
    }
    if(pathname==='/api/harness/navigator'){
      if(req.method!=='POST'){methodNotAllowed(res,'POST');return true;}
      const body=await requestBody(req,requestSchemas.harnessNavigator);
      if(typeof rateLimit==='function'&&rateLimit())return true;
      const result=await navigator.run({
        message:body.message,
        sessionId:body.sessionId??null,
        route:{view:body.view||'today',id:body.id??null}
      });
      sendJson(res,200,{ok:true,navigator:result,status:navigator.status()});
      return true;
    }
    return false;
  }

  return Object.freeze({handleBridge,handleUser});
}
