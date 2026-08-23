import { defineRuntimeAdapter } from './runtime-adapter.mjs';

export function contextToRoute(context={}){
  const route={
    view:context.view||context.route?.view||'today',
    id:context.projectId||context.id||context.route?.id||null
  };
  if(context.working)route.working=context.working;
  // 透传多用户上下文
  if(context.user&&typeof context.user==='object')route.user=context.user;
  return route;
}

export function createDshRuntimeAdapter({navigator}={}){
  if(!navigator)throw new Error('createDshRuntimeAdapter requires navigator');
  return defineRuntimeAdapter({
    name:'dsh',
    status:()=>navigator.status(),
    async run({message,sessionId=null,context={},route=null,userId=null}={}){
      // contextAwareDriver 传的是 context（已包含 route 展开的字段）；
      // harness-http 直接传 route 的情况也兼容。
      const finalRoute=route||contextToRoute(context);
      const result=await navigator.run({message,sessionId,route:finalRoute,userId});
      return {
        sessionId:String(result.sessionId||''),
        reply:result.reply,
        trajectory:result.trajectory||[],
        navigation:result.navigation??null,
        thinkBlocks:result.thinkBlocks||[],
        skillCalls:result.skillCalls||[],
        contextInjections:result.contextInjections||[],
        metrics:result.metrics||null,
        source:result.source||'deepseek_harness',
        readOnly:true
      };
    }
  });
}
