const ID_RE=/^[a-z0-9][a-z0-9._-]{1,127}$/;
const TOOL_RISKS=new Set(['read','local_write','external_write','destructive']);

function requiredString(value,name){
  const text=String(value??'').trim();
  if(!text)throw new TypeError(`${name} is required`);
  return text;
}

export function validateId(value,name='id'){
  const id=requiredString(value,name);
  if(!ID_RE.test(id))throw new TypeError(`${name} must match ${ID_RE}`);
  return id;
}

function namedContribution(value,kind){
  const raw=typeof value==='string'?{id:value}:value;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new TypeError(`${kind} manifest must be a string or object`);
  const id=validateId(raw.id,`${kind}.id`);
  return Object.freeze({
    id,
    name:String(raw.name??id),
    description:String(raw.description??''),
    contentRef:raw.contentRef?String(raw.contentRef):null,
    optional:raw.optional===true,
    metadata:Object.freeze({...raw.metadata})
  });
}

export function validateToolManifest(tool){
  if(!tool||typeof tool!=='object')throw new TypeError('tool manifest must be an object');
  const name=validateId(tool.name,'tool.name');
  const risk=tool.risk??'read';
  if(!TOOL_RISKS.has(risk))throw new TypeError(`unsupported tool risk: ${risk}`);
  if(typeof tool.execute!=='function')throw new TypeError(`tool ${name} must provide execute()`);
  return Object.freeze({
    name,
    description:String(tool.description??''),
    risk,
    reversible:tool.reversible!==false,
    idempotent:tool.idempotent===true,
    approval:tool.approval??null,
    validateInput:typeof tool.validateInput==='function'?tool.validateInput:null,
    execute:tool.execute,
    metadata:Object.freeze({...tool.metadata})
  });
}

export function validateAgentManifest(agent){
  if(!agent||typeof agent!=='object')throw new TypeError('agent manifest must be an object');
  const id=validateId(agent.id,'agent.id');
  const allowedTools=Array.from(new Set((agent.allowedTools??[]).map(value=>validateId(value,'agent.allowedTools[]'))));
  const toolAccess=String(agent.toolAccess??(allowedTools.length?'allowlist':'none'));
  if(!['none','allowlist','all'].includes(toolAccess))throw new TypeError(`unsupported agent toolAccess: ${toolAccess}`);
  if(toolAccess==='allowlist'&&!allowedTools.length)throw new TypeError('agent toolAccess allowlist requires allowedTools');
  return Object.freeze({
    id,
    name:requiredString(agent.name??id,'agent.name'),
    instructions:String(agent.instructions??''),
    modelProfile:String(agent.modelProfile??'default'),
    skills:Object.freeze([...(agent.skills??[])]),
    methods:Object.freeze([...(agent.methods??[])]),
    toolAccess,
    allowedTools:Object.freeze(allowedTools),
    metadata:Object.freeze({...agent.metadata})
  });
}

export function validateScheduleManifest(schedule){
  if(!schedule||typeof schedule!=='object')throw new TypeError('schedule manifest must be an object');
  const id=validateId(schedule.id,'schedule.id');
  const type=String(schedule.type??'').trim();
  if(!['interval','once','daily'].includes(type))throw new TypeError(`unsupported schedule type: ${type}`);
  const normalized={id,type,enabled:schedule.enabled!==false,agentId:schedule.agentId?validateId(schedule.agentId,'schedule.agentId'):null,metadata:Object.freeze({...schedule.metadata})};
  if(type==='interval'){
    const everyMs=Number(schedule.everyMs);
    if(!Number.isFinite(everyMs)||everyMs<60_000)throw new TypeError('interval schedule requires everyMs >= 60000');
    normalized.everyMs=Math.floor(everyMs);
  }
  if(type==='once'){
    const at=new Date(schedule.at);
    if(Number.isNaN(at.getTime()))throw new TypeError('once schedule requires a valid at date');
    normalized.at=at.toISOString();
  }
  if(type==='daily'){
    const match=/^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(String(schedule.time??''));
    if(!match)throw new TypeError('daily schedule requires HH:MM time');
    normalized.time=String(schedule.time);
  }
  return Object.freeze(normalized);
}

export function validatePackManifest(pack){
  if(!pack||typeof pack!=='object')throw new TypeError('pack manifest must be an object');
  const id=validateId(pack.id,'pack.id');
  return Object.freeze({
    id,
    name:requiredString(pack.name??id,'pack.name'),
    version:requiredString(pack.version??'0.0.0','pack.version'),
    capabilities:Object.freeze((pack.capabilities??[]).map(item=>Object.freeze({
      id:validateId(item.id,'capability.id'),
      kind:String(item.kind??'generic'),
      description:String(item.description??''),
      metadata:Object.freeze({...item.metadata})
    }))),
    tools:Object.freeze((pack.tools??[]).map(validateToolManifest)),
    agents:Object.freeze((pack.agents??[]).map(validateAgentManifest)),
    schedules:Object.freeze((pack.schedules??[]).map(validateScheduleManifest)),
    views:Object.freeze((pack.views??[]).map(item=>namedContribution(item,'view'))),
    skills:Object.freeze((pack.skills??[]).map(item=>namedContribution(item,'skill'))),
    methods:Object.freeze((pack.methods??[]).map(item=>namedContribution(item,'method'))),
    metadata:Object.freeze({...pack.metadata})
  });
}

export const TOOL_RISK_LEVELS=Object.freeze([...TOOL_RISKS]);
