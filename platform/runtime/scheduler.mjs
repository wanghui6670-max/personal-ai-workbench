function nextDaily(time,from){
  const [hour,minute]=time.split(':').map(Number);
  const next=new Date(from);next.setSeconds(0,0);next.setHours(hour,minute,0,0);
  if(next<=from)next.setDate(next.getDate()+1);
  return next;
}

export function nextRunAt(schedule,from=new Date()){
  if(schedule.enabled===false)return null;
  if(schedule.type==='interval')return new Date(from.getTime()+schedule.everyMs);
  if(schedule.type==='once'){
    const at=new Date(schedule.at);return at>from?at:null;
  }
  if(schedule.type==='daily')return nextDaily(schedule.time,from);
  throw new Error(`unsupported schedule type: ${schedule.type}`);
}

export class Scheduler{
  #registry;
  constructor({registry}){this.#registry=registry;}
  list(from=new Date()){
    return this.#registry.listSchedules().map(schedule=>({...schedule,nextRunAt:nextRunAt(schedule,from)?.toISOString()??null}));
  }
}
