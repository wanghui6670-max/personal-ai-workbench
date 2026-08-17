import { defineRuntimeAdapter } from './runtime-adapter.mjs';

export function contextToRoute(context={}){
  return {
    view:context.view||context.route?.view||'today',
    id:context.projectId||context.id||context.route?.id||null
  };
}

export function createDshRuntimeAdapter({navigator}={}){
  if(!navigator)throw new Error('createDshRuntimeAdapter requires navigator');
  return defineRuntimeAdapter({
    name:'dsh',
    status:()=>navigator.status(),
    async run({message,sessionId=null,context={}}={}){
      const result=await navigator.run({message,sessionId,route:contextToRoute(context)});
      return {
        sessionId:String(result.sessionId||''),
        reply:result.reply,
        trajectory:result.trajectory||[],
        navigation:result.navigation??null,
        source:result.source||'deepseek_harness',
        readOnly:true
      };
    }
  });
}
