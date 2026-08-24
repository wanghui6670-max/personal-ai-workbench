export function createScheduler({dispatch}={}){
  if(typeof dispatch!=='function')throw new Error('dispatch is required');
  const jobs=new Map();
  return Object.freeze({
    register(job){
      if(!job||typeof job.id!=='string'||!job.id.trim())throw new Error('job id is required');
      if(jobs.has(job.id))throw new Error(`job already registered: ${job.id}`);
      if(typeof job.agentId!=='string'||!job.agentId.trim())throw new Error('agentId is required');
      if(typeof job.sessionId!=='string'||!job.sessionId.trim())throw new Error('sessionId is required');
      const value=Object.freeze({...job});
      jobs.set(value.id,value);
      return value;
    },
    get(id){return jobs.get(id)||null;},
    list(){return [...jobs.values()];},
    async trigger(id,context={}){
      const job=jobs.get(id);
      if(!job)throw new Error(`job not found: ${id}`);
      return dispatch({
        jobId:job.id,
        agentId:job.agentId,
        sessionId:job.sessionId,
        schedule:job.schedule||null,
        context
      });
    }
  });
}
