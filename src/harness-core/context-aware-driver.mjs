export function createContextAwareDriver({sessionManager,runtime}={}){
  if(!sessionManager||!runtime)throw new Error('createContextAwareDriver requires sessionManager and runtime');

  async function run({message,sessionId=null,route={}}={}){
    let working=null;
    let context={...route};
    if(route.view==='project'&&route.id){
      const session=await sessionManager.openProject({projectId:route.id});
      working=await sessionManager.hydrate(session.id);
      context={...route,projectId:route.id,sessionId:session.id,working};
    }
    const result=await runtime.run({message,sessionId,context});
    return {...result,readOnly:true,working};
  }

  return Object.freeze({run});
}
