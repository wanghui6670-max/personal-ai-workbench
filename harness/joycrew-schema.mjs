const HARNESS_SCHEMA_KEYS=new Set([
  'type','oneOf','properties','required','additionalProperties','items',
  'enum','const','description','title','default','examples'
]);

function cloneJson(value){
  if(Array.isArray(value))return value.map(cloneJson);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,cloneJson(item)]));
  return value;
}

/**
 * Project the richer Workbench JSON Schema into the subset enforced by
 * Harness. The Workbench MCP registry still validates calls against the full
 * original schema, so this changes model presentation only, never authority.
 */
export function normalizeInputSchema(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  if(Object.hasOwn(value,'anyOf')&&Object.hasOwn(value,'oneOf')){
    throw new Error('Joycrew tool schema cannot declare both anyOf and oneOf');
  }
  const normalized={};
  for(const [sourceKey,item] of Object.entries(value)){
    const key=sourceKey==='anyOf'?'oneOf':sourceKey;
    if(!HARNESS_SCHEMA_KEYS.has(key))continue;
    if(key==='properties'){
      if(item&&typeof item==='object'&&!Array.isArray(item)){
        normalized.properties=Object.fromEntries(Object.entries(item).map(([name,schema])=>[name,normalizeInputSchema(schema)]));
      }
      continue;
    }
    if(key==='items'){
      normalized.items=normalizeInputSchema(item);
      continue;
    }
    if(key==='oneOf'){
      if(Array.isArray(item))normalized.oneOf=item.map(normalizeInputSchema);
      continue;
    }
    if(key==='default'||key==='examples'||key==='enum'||key==='required'){
      normalized[key]=cloneJson(item);
      continue;
    }
    normalized[key]=item;
  }
  return normalized;
}
