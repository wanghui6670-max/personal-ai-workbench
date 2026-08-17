export class AgentRuntime{
  constructor({registry,events,sessions=null,invokeTool}={}){
    if(!registry||!events||typeof invokeTool!=='function')throw new TypeError('AgentRuntime requires registry, events and invokeTool');
    this.registry=registry;this.events=events;this.sessions=sessions;this.invokeTool=invokeTool;
  }
  async run(agentId,{input='',sessionId=null,runner}={}){
    const agent=this.registry.getAgent(agentId);
    if(!agent)throw new Error(`unknown agent: ${agentId}`);
    if(typeof runner!=='function')throw new TypeError('agent runner must be a function');
    let session=null;
    if(sessionId){
      if(!this.sessions)throw new Error('session store is not configured');
      session=await this.sessions.load(sessionId);
      if(!session)throw new Error(`session not found: ${sessionId}`);
    }
    const base={agentId,sessionId};
    await this.events.append({type:'agent.requested',...base,input});
    try{
      const result=await runner({
        agent,input,session,
        invoke:(toolName,args={},options={})=>this.invokeTool(toolName,args,{...options,agentId,sessionId})
      });
      await this.events.append({type:'agent.completed',...base,result});
      if(sessionId&&this.sessions)await this.sessions.appendEvent(sessionId,{type:'agent.completed',agentId,result});
      return {ok:true,agentId,sessionId,result};
    }catch(error){
      await this.events.append({type:'agent.failed',...base,error:{name:error?.name||'Error',message:error?.message||String(error)}});
      if(sessionId&&this.sessions)await this.sessions.appendEvent(sessionId,{type:'agent.failed',agentId,error:{name:error?.name||'Error',message:error?.message||String(error)}});
      throw error;
    }
  }
}
