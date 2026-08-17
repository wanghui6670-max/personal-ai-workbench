import {CapabilityRegistry} from '../registry/capability-registry.mjs';
import {ApprovalEngine} from './approval-engine.mjs';
import {InMemoryEventStore} from '../kernel/event-store.mjs';
import {Scheduler} from './scheduler.mjs';

export class HarnessRuntime{
  constructor({registry=new CapabilityRegistry(),approval=new ApprovalEngine(),events=new InMemoryEventStore(),sessions=null}={}){
    this.registry=registry;this.approval=approval;this.events=events;this.sessions=sessions;this.scheduler=new Scheduler({registry});
  }
  install(pack){return this.registry.install(pack);}
  async invoke(toolName,input={},context={}){
    const tool=this.registry.getTool(toolName);if(!tool)throw new Error(`unknown tool: ${toolName}`);
    if(context.agentId){
      const agent=this.registry.getAgent(context.agentId);if(!agent)throw new Error(`unknown agent: ${context.agentId}`);
      if(agent.allowedTools.length&&!agent.allowedTools.includes(toolName))throw new Error(`tool not allowed for agent ${agent.id}: ${toolName}`);
    }
    if(tool.validateInput&&!tool.validateInput(input))throw new TypeError(`invalid input for tool: ${toolName}`);
    const authorization=this.approval.authorize(tool,{approved:context.approved===true,explicit:context.explicit===true});
    const baseEvent={sessionId:context.sessionId??null,agentId:context.agentId??null,toolName,risk:tool.risk,approval:authorization.requirement};
    await this.events.append({type:'tool.requested',...baseEvent,input});
    if(!authorization.allowed){
      await this.events.append({type:'tool.blocked',...baseEvent});
      return {ok:false,status:'approval_required',approval:authorization.requirement,risk:tool.risk};
    }
    const result=await tool.execute(input,{...context,runtime:this});
    await this.events.append({type:'tool.completed',...baseEvent,result});
    if(context.sessionId&&this.sessions)await this.sessions.appendEvent(context.sessionId,{type:'tool.completed',toolName,result});
    return {ok:true,result,readback:true};
  }
  describe(){
    return Object.freeze({packs:this.registry.listPacks().map(item=>item.id),capabilities:this.registry.listCapabilities().map(item=>item.id),tools:this.registry.listTools().map(item=>item.name),agents:this.registry.listAgents().map(item=>item.id),schedules:this.registry.listSchedules().map(item=>item.id)});
  }
}
