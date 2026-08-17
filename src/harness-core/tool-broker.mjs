function defaultPolicy(){
  return {decide(){return {decision:'ALLOW',reason:'slice-2-passthrough',delegate:null};}};
}

function summarizeResult(name,outcome){
  const result=outcome?.result;
  if(Array.isArray(result))return `${name}:${result.length}`;
  return name;
}

export function createToolBroker({registry,policy=null,execution=null}={}){
  if(!registry)throw new Error('createToolBroker requires registry');
  const gate=policy||defaultPolicy();

  function resolveProvider(name){
    for(const cap of registry.listCapabilities()){
      if(cap.toolNames.includes(name)){
        const provider=registry.getProvider(cap.providerId);
        if(provider)return provider;
      }
    }
    return null;
  }

  function list(options={}){
    const names=options.allowedNames
      ?(Array.isArray(options.allowedNames)?new Set(options.allowedNames):options.allowedNames)
      :null;
    return registry.listTools().filter(tool=>{
      if(options.readOnlyOnly&&tool.readOnly!==true)return false;
      if(names&&!names.has(tool.name))return false;
      return true;
    });
  }

  async function call(input={}){
    const name=input.name;
    const args=input.arguments||{};
    const options=input.options||{};
    const provider=resolveProvider(name);
    if(!provider){
      throw Object.assign(new Error(`未知 MCP 工具：${name}`),{code:'MCP_TOOL_NOT_FOUND',statusCode:404});
    }
    const decision=gate.decide({
      actor:input.actor||'harness',
      session:input.sessionRef||null,
      tool:name,
      effect:options.readOnlyOnly?'read':'unknown',
      risk:options.readOnlyOnly?'read':'unknown'
    });
    if(decision.decision==='DENY'){
      throw Object.assign(new Error(`工具 ${name} 不在本次调用的能力白名单中。`),{code:'MCP_TOOL_NOT_ALLOWED',statusCode:403});
    }
    const receipt=execution?.begin?await execution.begin({
      trigger:input.trigger||'broker',
      sessionRef:input.sessionRef||null,
      actor:input.actor||'harness',
      tool:name
    }):null;
    try{
      if(decision.decision==='APPROVAL_REQUIRED'&&!options.confirmed){
        const error=Object.assign(new Error(`工具 ${name} 会改变工作台状态，必须先展示影响范围并获得确认。`),{code:'MCP_CONFIRMATION_REQUIRED',statusCode:409});
        if(execution?.finish)await execution.finish(receipt,{status:'approval_required',errorCode:'MCP_CONFIRMATION_REQUIRED',resultSummary:'approval required'});
        throw error;
      }
      const outcome=await provider.call(name,args,options);
      if(execution?.finish)await execution.finish(receipt,{status:'ok',errorCode:null,resultSummary:summarizeResult(name,outcome)});
      return {...outcome,executionId:receipt?.executionId,decision};
    }catch(error){
      if(error?.code!=='MCP_CONFIRMATION_REQUIRED'){
        if(execution?.finish)await execution.finish(receipt,{
          status:error?.code==='MCP_TOOL_NOT_ALLOWED'?'denied':'error',
          errorCode:error?.code||'ERROR',
          resultSummary:String(error?.message||'error').slice(0,160)
        });
      }
      throw error;
    }
  }

  return Object.freeze({list,call});
}
