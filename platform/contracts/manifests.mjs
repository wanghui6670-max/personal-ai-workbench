const SAFE_ID=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION=/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SECRET_KEYS=/token|secret|password|api[_-]?key|credential/i;

function result(ok,errors=[]){return {ok,errors};}

function validateBase(manifest){
  const errors=[];
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))return result(false,['manifest must be an object']);
  if(typeof manifest.id!=='string'||!SAFE_ID.test(manifest.id))errors.push('id must be a safe lowercase identifier');
  if(typeof manifest.version!=='string'||!VERSION.test(manifest.version))errors.push('version must be semver');
  for(const key of Object.keys(manifest))if(FORBIDDEN_SECRET_KEYS.test(key))errors.push(`secret-like field is forbidden: ${key}`);
  return result(errors.length===0,errors);
}

export function validatePluginManifest(manifest){
  const base=validateBase(manifest);
  if(!base.ok)return base;
  const errors=[...base.errors];
  if(typeof manifest.adapter!=='string'||!/^\.\/[A-Za-z0-9_./-]+\.mjs$/.test(manifest.adapter)||manifest.adapter.includes('..')){
    errors.push('adapter must be a relative in-package .mjs path');
  }
  return result(errors.length===0,errors);
}

export function validateCapabilityManifest(manifest){
  const base=validateBase(manifest);
  if(!base.ok)return base;
  const errors=[...base.errors];
  if(typeof manifest.kind!=='string'||!manifest.kind.trim())errors.push('kind is required');
  return result(errors.length===0,errors);
}

export function assertPluginManifest(manifest){
  const checked=validatePluginManifest(manifest);
  if(!checked.ok)throw new Error(`invalid plugin manifest: ${checked.errors.join('; ')}`);
  return Object.freeze({...manifest});
}

export function assertCapabilityManifest(manifest){
  const checked=validateCapabilityManifest(manifest);
  if(!checked.ok)throw new Error(`invalid capability manifest: ${checked.errors.join('; ')}`);
  return Object.freeze({...manifest});
}
