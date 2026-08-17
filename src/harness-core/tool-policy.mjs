const SAFE_EFFECTS=new Set(['read','local_ephemeral']);
const WRITE_EFFECTS=new Set(['local_write','external_write','destructive','write_unknown']);

function decision(tool,mode,value,reason){
  return Object.freeze({
    decision:value,
    reason,
    effect:String(tool.effect||'write_unknown'),
    mode
  });
}

function allowedNames(value){
  if(value===undefined||value===null)return null;
  if(Array.isArray(value))return new Set(value.filter(name=>typeof name==='string'&&name));
  if(value instanceof Set)return new Set([...value].filter(name=>typeof name==='string'&&name));
  throw new TypeError('ToolPolicy options.allowedNames must be an array or Set');
}

export class ToolPolicy{
  constructor({mode='shadow'}={}){
    if(mode!=='shadow')throw new TypeError('ToolPolicy currently supports shadow mode only');
    this.mode=mode;
  }

  evaluate({tool,options={}}={}){
    if(!tool||typeof tool!=='object'||Array.isArray(tool)||typeof tool.name!=='string'||!tool.name.trim()){
      throw new TypeError('ToolPolicy.evaluate requires a Tool descriptor');
    }
    if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('ToolPolicy options must be an object');

    const names=allowedNames(options.allowedNames);
    if(names&&!names.has(tool.name))return decision(tool,this.mode,'DENY','tool_not_allowlisted');
    if(options.readOnlyOnly===true&&tool.readOnly!==true)return decision(tool,this.mode,'DENY','read_only_surface');

    if(tool.requiresConfirmation===true){
      if(options.confirmed===true)return decision(tool,this.mode,'ALLOW','legacy_confirmation_satisfied');
      return decision(tool,this.mode,'APPROVAL_REQUIRED','legacy_confirmation_required');
    }

    const effect=String(tool.effect||'write_unknown');
    if(SAFE_EFFECTS.has(effect))return decision(tool,this.mode,'ALLOW','effect_safe');
    if(WRITE_EFFECTS.has(effect))return decision(tool,this.mode,'DENY','unapproved_write_effect');
    return decision(tool,this.mode,'DENY','unsupported_effect');
  }
}
