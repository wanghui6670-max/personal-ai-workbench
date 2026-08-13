import { aiProviderError } from '../errors.mjs';
import { postProviderJson } from '../http.mjs';

function assistantText(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  const parts=[];
  for(const item of content){
    if(item?.type!=='text'||typeof item.text!=='string')return '';
    parts.push(item.text);
  }
  return parts.join('\n');
}

function normalizeChoice(payload){
  if(!payload||typeof payload!=='object'||payload.error)throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','AI Provider 返回格式无效');
  if(!Array.isArray(payload.choices)||payload.choices.length!==1)throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','Chat Completions Adapter 只接受一个候选结果');
  const choice=payload.choices[0];
  const finishReason=choice?.finish_reason;
  if(finishReason==='length')return {state:'incomplete'};
  if(finishReason==='content_filter')return {state:'refused'};
  if(finishReason!=='stop')return {state:'failed'};
  const message=choice?.message;
  if(!message||(message.role&&message.role!=='assistant'))return {state:'failed'};
  if(typeof message.refusal==='string'&&message.refusal)return {state:'refused'};
  if(Array.isArray(message.tool_calls)&&message.tool_calls.length)return {state:'failed'};
  const outputText=assistantText(message.content);
  return outputText?{state:'completed',outputText}:{state:'failed'};
}

function responseFormat(request,profile){
  if(profile.structuredOutput.mode==='strict_native'){
    return {type:'json_schema',json_schema:{name:request.schemaName,description:request.schemaDescription,strict:true,schema:request.schema}};
  }
  if(profile.structuredOutput.mode==='json_object_local_validate')return {type:'json_object'};
  throw aiProviderError('AI_PROVIDER_CAPABILITY_MISMATCH','Chat Completions Adapter 的结构化输出模式无效',{profileId:profile.id,adapterId:profile.adapter});
}

function buildBody(request,profile){
  const body={
    model:profile.model,
    messages:[
      {role:'system',content:request.instructions},
      {role:'user',content:request.input}
    ],
    response_format:responseFormat(request,profile)
  };
  body[profile.chatTokenField]=request.maxOutputTokens;
  if(profile.retention.sendNoStore)body.store=false;
  if(profile.reasoning.mode==='xhigh')body.reasoning_effort=profile.reasoning.requestedLevel;
  return body;
}

export const openAIChatCompletionsCompatibleAdapter={
  id:'openai_chat_completions_compatible',
  apiStyle:'chat_completions',
  validateProfile(profile){
    if(!profile.model)throw aiProviderError('AI_PROVIDER_NOT_CONFIGURED','AI Provider model 尚未配置',{profileId:profile.id,adapterId:this.id});
    if(!['strict_native','json_object_local_validate'].includes(profile.structuredOutput.mode))throw aiProviderError('AI_PROVIDER_CAPABILITY_MISMATCH','Chat Completions Adapter 不支持该结构化输出模式',{profileId:profile.id,adapterId:this.id});
  },
  describeCapabilities(profile){
    return {
      nativeJsonSchema:profile.structuredOutput.mode==='strict_native',jsonObjectMode:true,
      reasoningLevels:profile.reasoning.mode==='xhigh'?[profile.reasoning.requestedLevel]:[],noStoreControl:profile.retention.sendNoStore,
      refusalSignal:true,incompleteSignal:true,providerRequestId:true,usage:true,idempotency:false
    };
  },
  async invokeStructured(request,{profile,fetchImpl}){
    const headers=profile.credential?{Authorization:`Bearer ${profile.credential}`}:{ };
    const payload=await postProviderJson({
      url:`${profile.endpoint.baseUrl.replace(/\/$/,'')}/chat/completions`,headers,body:buildBody(request,profile),
      timeoutMs:profile.timeoutMs,maxResponseBytes:profile.maxResponseBytes,fetchImpl,profileId:profile.id,adapterId:this.id
    });
    const normalized=normalizeChoice(payload);
    return {
      ...normalized,
      providerRequestId:typeof payload.id==='string'?payload.id:null,
      usage:{inputTokens:Number(payload.usage?.prompt_tokens)||0,outputTokens:Number(payload.usage?.completion_tokens)||0}
    };
  }
};
