import { aiProviderError } from './errors.mjs';

export function matchesSchema(value,schema){
  if(!schema||typeof schema!=='object')return false;
  if(Object.hasOwn(schema,'const')&&!Object.is(value,schema.const))return false;
  if(Array.isArray(schema.anyOf)&&!schema.anyOf.some(candidate=>matchesSchema(value,candidate)))return false;
  if(Array.isArray(schema.enum)&&!schema.enum.some(candidate=>Object.is(candidate,value)))return false;
  const declaredTypes=Array.isArray(schema.type)?schema.type:(schema.type?[schema.type]:[]);
  if(declaredTypes.length&&!declaredTypes.some(type=>{
    if(type==='null')return value===null;
    if(type==='array')return Array.isArray(value);
    if(type==='object')return value!==null&&typeof value==='object'&&!Array.isArray(value);
    if(type==='integer')return Number.isInteger(value);
    if(type==='number')return typeof value==='number'&&Number.isFinite(value);
    return typeof value===type;
  }))return false;
  if(value===null)return true;
  if(typeof value==='string'){
    if(Number.isInteger(schema.minLength)&&value.length<schema.minLength)return false;
    if(Number.isInteger(schema.maxLength)&&value.length>schema.maxLength)return false;
    if(typeof schema.pattern==='string'&&!new RegExp(schema.pattern,'u').test(value))return false;
  }
  if(typeof value==='number'){
    if(typeof schema.minimum==='number'&&value<schema.minimum)return false;
    if(typeof schema.maximum==='number'&&value>schema.maximum)return false;
  }
  if(Array.isArray(value)){
    if(Number.isInteger(schema.minItems)&&value.length<schema.minItems)return false;
    if(Number.isInteger(schema.maxItems)&&value.length>schema.maxItems)return false;
    if(schema.uniqueItems){
      const seen=new Set(value.map(item=>JSON.stringify(item)));
      if(seen.size!==value.length)return false;
    }
    if(schema.items&&!value.every(item=>matchesSchema(item,schema.items)))return false;
  }
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const properties=schema.properties||{};
    if((schema.required||[]).some(key=>!Object.hasOwn(value,key)))return false;
    if(schema.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(properties,key)))return false;
    for(const [key,childSchema] of Object.entries(properties)){
      if(Object.hasOwn(value,key)&&!matchesSchema(value[key],childSchema))return false;
    }
  }
  return true;
}

export function parseStructuredOutput(outputText,schema){
  if(typeof outputText!=='string'||!outputText.trim())throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','AI Provider 返回了空结果');
  let result;
  try{result=JSON.parse(outputText);}catch{throw aiProviderError('AI_PROVIDER_SCHEMA_INVALID','AI Provider 返回的 JSON 无效');}
  if(!matchesSchema(result,schema))throw aiProviderError('AI_PROVIDER_SCHEMA_INVALID','AI Provider 返回的结构化结果不符合约束');
  return result;
}

export function validateAnalysisEnvelope(result){
  const evidence=result?.analysis?.evidence;
  if(!Array.isArray(evidence)||!evidence.length)throw aiProviderError('AI_PROVIDER_RESULT_OUT_OF_SCOPE','AI Provider 未返回可审计证据');
  const ids=evidence.map(item=>item?.id);
  if(ids.some(id=>typeof id!=='string'||!id))throw aiProviderError('AI_PROVIDER_RESULT_OUT_OF_SCOPE','AI Provider 返回了无效证据 ID');
  if(new Set(ids).size!==ids.length)throw aiProviderError('AI_PROVIDER_RESULT_OUT_OF_SCOPE','AI Provider 重复引用了同一证据 ID');
  return result;
}
