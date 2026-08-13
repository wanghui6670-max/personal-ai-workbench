import { createSyncCoordinator } from './rate-limit.mjs';

const coordinator=createSyncCoordinator();

function busyError(){
  return Object.assign(new Error('项目同步正在进行，请等待当前同步完成。'),{
    statusCode:409,
    code:'PROJECT_SYNC_BUSY',
    retryAfter:1
  });
}

export async function withProjectSyncLease(projectId,work){
  const lease=coordinator.tryAcquireProject(projectId);
  if(!lease)throw busyError();
  try{return await work();}
  finally{lease.release();}
}

export async function withAllProjectSyncLease(work){
  const lease=coordinator.tryAcquireAll();
  if(!lease)throw busyError();
  try{return await work();}
  finally{lease.release();}
}

export function projectSyncCoordinatorState(){
  return {activeCount:coordinator.activeCount};
}
