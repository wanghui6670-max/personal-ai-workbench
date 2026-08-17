const DEFAULT_POLICY=Object.freeze({
  read:'auto',
  local_write:'auto',
  external_write:'confirm',
  destructive:'explicit'
});

export class ApprovalEngine{
  constructor({policy=DEFAULT_POLICY}={}){this.policy=Object.freeze({...DEFAULT_POLICY,...policy});}
  requirementFor(tool){
    if(tool.approval)return tool.approval;
    return this.policy[tool.risk]??'explicit';
  }
  authorize(tool,{approved=false,explicit=false}={}){
    const requirement=this.requirementFor(tool);
    const allowed=requirement==='auto'||(requirement==='confirm'&&approved)||(requirement==='explicit'&&explicit);
    return Object.freeze({allowed,requirement,risk:tool.risk});
  }
}

export const DEFAULT_APPROVAL_POLICY=DEFAULT_POLICY;
