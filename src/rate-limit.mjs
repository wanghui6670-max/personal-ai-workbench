import { boundedInteger } from './utils.mjs';

const RATE_LIMIT_DEFAULTS=Object.freeze({
  windowMs:60_000,
  maxClients:1_000,
  limits:Object.freeze({capture:60,sync:12,morning:20,navigator:20,joycrew:30,crew:30})
});

const RATE_LIMIT_CAPS=Object.freeze({
  windowMs:3_600_000,
  maxClients:5_000,
  limits:Object.freeze({capture:600,sync:120,morning:120,navigator:120,joycrew:180,crew:120})
});

export function endpointRateLimitConfig(env=process.env){
  return{
    windowMs:boundedInteger(env.WORKBENCH_RATE_LIMIT_WINDOW_MS,RATE_LIMIT_DEFAULTS.windowMs,{min:10_000,max:RATE_LIMIT_CAPS.windowMs}),
    maxClients:boundedInteger(env.WORKBENCH_RATE_LIMIT_MAX_CLIENTS,RATE_LIMIT_DEFAULTS.maxClients,{min:10,max:RATE_LIMIT_CAPS.maxClients}),
    limits:{
      capture:boundedInteger(env.WORKBENCH_CAPTURE_RATE_LIMIT,RATE_LIMIT_DEFAULTS.limits.capture,{max:RATE_LIMIT_CAPS.limits.capture}),
      sync:boundedInteger(env.WORKBENCH_SYNC_RATE_LIMIT,RATE_LIMIT_DEFAULTS.limits.sync,{max:RATE_LIMIT_CAPS.limits.sync}),
      morning:boundedInteger(env.WORKBENCH_MORNING_RATE_LIMIT,RATE_LIMIT_DEFAULTS.limits.morning,{max:RATE_LIMIT_CAPS.limits.morning}),
      navigator:boundedInteger(env.WORKBENCH_HARNESS_RATE_LIMIT,RATE_LIMIT_DEFAULTS.limits.navigator,{max:RATE_LIMIT_CAPS.limits.navigator}),
      joycrew:boundedInteger(env.WORKBENCH_JOYCREW_RATE_LIMIT,RATE_LIMIT_DEFAULTS.limits.joycrew,{max:RATE_LIMIT_CAPS.limits.joycrew}),
      crew:boundedInteger(env.WORKBENCH_CREW_RATE_LIMIT,RATE_LIMIT_DEFAULTS.limits.crew,{max:RATE_LIMIT_CAPS.limits.crew})
    }
  };
}

export function createEndpointRateLimiter({limits=RATE_LIMIT_DEFAULTS.limits,windowMs=RATE_LIMIT_DEFAULTS.windowMs,maxClients=RATE_LIMIT_DEFAULTS.maxClients,now=Date.now}={}){
  const clients=new Map();
  const safeWindow=boundedInteger(windowMs,RATE_LIMIT_DEFAULTS.windowMs,{min:1,max:RATE_LIMIT_CAPS.windowMs});
  const safeMaxClients=boundedInteger(maxClients,RATE_LIMIT_DEFAULTS.maxClients,{min:1,max:RATE_LIMIT_CAPS.maxClients});
  const safeLimits=Object.fromEntries(Object.entries(RATE_LIMIT_DEFAULTS.limits).map(([scope,fallback])=>[
    scope,boundedInteger(limits?.[scope],fallback,{min:1,max:RATE_LIMIT_CAPS.limits[scope]})
  ]));

  function consume(scope,clientKey){
    const limit=safeLimits[scope];
    if(!limit)throw new Error(`未知限流范围：${scope}`);
    const at=now();
    const client=String(clientKey||'unknown').slice(0,128);
    let clientEntry=clients.get(client);
    if(!clientEntry){
      while(clients.size>=safeMaxClients){const oldest=clients.keys().next().value;if(oldest===undefined)break;clients.delete(oldest);}
      clientEntry={windows:Object.create(null)};
    }else clients.delete(client);
    let entry=clientEntry.windows[scope];
    if(!entry||at-entry.windowStartedAt>=safeWindow)entry={count:0,windowStartedAt:at};
    const retryAfterMs=Math.max(1,safeWindow-(at-entry.windowStartedAt));
    const allowed=entry.count<limit;
    if(allowed)entry.count+=1;
    clientEntry.windows[scope]=entry;
    clients.set(client,clientEntry);
    return{allowed,limit,remaining:Math.max(0,limit-entry.count),retryAfterMs:allowed?0:retryAfterMs};
  }
  return{consume,get size(){return clients.size;}};
}

export function requestClientKey(req){
  const raw=String(req?.socket?.remoteAddress||'unknown').toLowerCase();
  return raw.startsWith('::ffff:')?raw.slice(7):raw;
}

function lease(onRelease){let released=false;return{release(){if(released)return;released=true;onRelease();}};}
export function createSyncCoordinator(){
  let allActive=false;const activeProjects=new Set();
  return{
    tryAcquireAll(){if(allActive||activeProjects.size)return null;allActive=true;return lease(()=>{allActive=false;});},
    tryAcquireProject(projectId){const key=String(projectId);if(allActive||activeProjects.has(key))return null;activeProjects.add(key);return lease(()=>{activeProjects.delete(key);});},
    get activeCount(){return activeProjects.size+(allActive?1:0);}
  };
}
export { RATE_LIMIT_DEFAULTS, RATE_LIMIT_CAPS };
