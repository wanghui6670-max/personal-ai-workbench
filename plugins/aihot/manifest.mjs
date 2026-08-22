import {AihotClient} from './client.mjs';

export function createAihotPack({client=new AihotClient()}={}){
  return {
    id:'aihot',
    name:'AIHot Intelligence',
    version:'1.0.0',
    capabilities:[{id:'aihot.intelligence',kind:'information_source',description:'Read-only AI industry intelligence from AIHot'}],
    tools:[{
      name:'aihot.latest',
      description:'Read recent AIHot items through the official anonymous v1 API.',
      risk:'read',
      idempotent:true,
      reversible:true,
      validateInput:input=>input&&typeof input==='object'&&!Array.isArray(input),
      execute:input=>client.latest(input)
    }],
    agents:[{
      id:'research-agent',
      name:'Research Agent',
      instructions:'Use installed read-only intelligence capabilities to collect evidence before synthesis.',
      skills:['ai-trend-research'],
      methods:[],
      allowedTools:['aihot.latest']
    }],
    schedules:[{id:'aihot.daily-scan',type:'daily',time:'08:00',agentId:'research-agent',metadata:{purpose:'daily-ai-intelligence'}}],
    skills:['ai-trend-research'],
    views:[{id:'aihot.feed',optional:true}],
    metadata:{readOnly:true,provider:'aihot',apiVersion:'v1'}
  };
}
