const POLICIES=Object.freeze({
  read:Object.freeze({mode:'auto'}),
  'local-write':Object.freeze({mode:'auto'}),
  'external-write':Object.freeze({mode:'confirm'}),
  destructive:Object.freeze({mode:'explicit'})
});

export function createApprovalEngine({policies=POLICIES}={}){
  const supported=new Set(Object.keys(policies));
  return Object.freeze({
    supportedRisks(){return [...supported];},
    policyFor(target){
      const risk=target?.risk;
      if(!supported.has(risk))throw new Error(`unsupported risk: ${risk}`);
      return policies[risk];
    },
    authorize(target,{confirmed=false,explicit=false}={}){
      const policy=this.policyFor(target);
      if(policy.mode==='auto')return {allowed:true,policy};
      if(policy.mode==='confirm'&&confirmed===true)return {allowed:true,policy};
      if(policy.mode==='explicit'&&explicit===true)return {allowed:true,policy};
      return {allowed:false,policy};
    }
  });
}
