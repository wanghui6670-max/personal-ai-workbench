export function createAihotProofPack({latest=async()=>[]}={}){
  return {
    id:'aihot',name:'AIHot',version:'0.1.0',
    capabilities:[{id:'aihot.intelligence',kind:'information_source',description:'Read-only AI trend intelligence'}],
    tools:[{
      name:'aihot.latest',description:'Get latest AIHot items',risk:'read',idempotent:true,
      validateInput:input=>input&&typeof input==='object'&&(!('limit' in input)||(Number.isInteger(input.limit)&&input.limit>0&&input.limit<=100)),
      execute:async input=>latest({limit:input.limit??20})
    }],
    agents:[{id:'research-agent',name:'Research Agent',skills:['ai-trend-research'],methods:[],allowedTools:['aihot.latest']}],
    schedules:[{id:'aihot.daily-scan',type:'daily',time:'08:00',agentId:'research-agent'}],
    skills:['ai-trend-research'],views:[{id:'aihot.feed',optional:true}]
  };
}
