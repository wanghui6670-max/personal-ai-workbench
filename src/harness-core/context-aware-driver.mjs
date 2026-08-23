export function createHarnessRunScope(){
  let active=null;

  function enter(sessionRef=null,userId=null){
    if(active){
      throw Object.assign(new Error('已有 Navigator 任务正在执行，请等待本轮结束。'),{
        code:'HARNESS_RUN_BUSY',
        statusCode:409
      });
    }
    const token=Symbol('harness-run');
    active={token,sessionRef,userId};
    return token;
  }

  function leave(token){
    if(active?.token===token)active=null;
  }

  function currentSessionRef(){
    return active?.sessionRef??null;
  }

  function currentUserId(){
    return active?.userId??null;
  }

  return Object.freeze({enter,leave,currentSessionRef,currentUserId});
}

export function createContextAwareDriver({sessionManager,runtime,runScope=null,userId=null}={}){
  if(!sessionManager||!runtime)throw new Error('createContextAwareDriver requires sessionManager and runtime');

  async function run({message,sessionId=null,route={}}={}){
    let working=null;
    let context={...route};
    let trustedSessionRef=null;
    if(route.view==='project'&&route.id){
      const projectSession=await sessionManager.openProject({projectId:route.id});
      trustedSessionRef=projectSession.id;
      working=await sessionManager.hydrate(trustedSessionRef);
      context={...route,projectId:route.id,sessionId:trustedSessionRef,working};
    }
    const scopeToken=runScope?.enter(trustedSessionRef,userId)??null;
    try{
      const result=await runtime.run({message,sessionId,context,userId});
      return {...result,readOnly:true,working};
    }finally{
      if(scopeToken)runScope.leave(scopeToken);
    }
  }

  return Object.freeze({run});
}
