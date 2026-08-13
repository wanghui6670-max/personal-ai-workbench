import { aiProviderError } from '../errors.mjs';
import { postProviderJson } from '../http.mjs';

function responseText(payload){
  if(!payload||typeof payload!=='object')throw aiProviderError('AI_PROVIDER_BAD_RESPONSE','AI Provider 返回格式无效');
  if(payload.error)return {state:'failed'};
  if(payload.status==='incomplete')return {state:'incomplete'};
  if(payload.status&&payload.status!=='completed')return {state:'failed'};
  const parts=[];
  let refused=false;
  for(const item of payload.output||[]){
    if(item?.type!=='message')continue;
    for(const content of item.content||[]){
      if(content?.type==='refusal'||typeof content?.refusal==='string'){refused=true;continue;}
      if(content?.type==='output_text'&&typeof content.text==='string')parts.push(content.text);
    }
  }
  if(refused)return {state:'refused'};
  if(!parts.length&&typeof payload.output_text==='string')parts.push(payload.output_text);
  if(!parts.length)return {state:'failed'};
  return {state:'completed',outputText:parts.join('\n')};
}

function buildBody(request,profile){
  const body={
    model:profile.model,
    max_output_tokens:request.maxOutputTokens,
    instructions:request.instructions,
    input:[{role:'user',content:[{type:'input_text',text:request.input}]}],
    text:{format:{type:'json_schema',name:request.schemaName,description:request.schemaDescription,strict:true,schema:request.schema}}
  };
  if(profile.retention.sendNoStore)body.store=false;
  if(profile.reasoning.mode==='xhigh')body.reasoning={effort:profile.reasoning.requestedLevel};
  return body;
}

export function createOpenAIResponsesAdapter(id='openai_responses'){
  return {
    id,
    apiStyle:'responses',
    validateProfile(profile){
      if(profile.structuredOutput.mode!=='strict_native')throw aiProviderError('AI_PROVIDER_CAPABILITY_MISMATCH','Responses Adapter 需要原生 strict JSON Schema',{profileId:profile.id,adapterId:id});
      if(!profile.model)throw aiProviderError('AI_PROVIDER_NOT_CONFIGURED','AI Provider model 尚未配置',{profileId:profile.id,adapterId:id});
    },
    describeCapabilities(profile){
      return {
        nativeJsonSchema:true,jsonObjectMode:false,reasoningLevels:profile.reasoning.mode==='xhigh'?[profile.reasoning.requestedLevel]:[],
        noStoreControl:profile.retention.sendNoStore,refusalSignal:true,incompleteSignal:true,providerRequestId:true,usage:true,idempotency:false
      };
    },
    async invokeStructured(request,{profile,fetchImpl}){
      const headers=profile.credential?{Authorization:`Bearer ${profile.credential}`}:{ };
      const payload=await postProviderJson({
        url:`${profile.endpoint.baseUrl.replace(/\/$/,'')}/responses`,headers,body:buildBody(request,profile),
        timeoutMs:profile.timeoutMs,maxResponseBytes:profile.maxResponseBytes,fetchImpl,profileId:profile.id,adapterId:id
      });
      const normalized=responseText(payload);
      return {
        ...normalized,
        providerRequestId:typeof payload.id==='string'?payload.id:null,
        usage:{inputTokens:Number(payload.usage?.input_tokens)||0,outputTokens:Number(payload.usage?.output_tokens)||0}
      };
    }
  };
}

export const openAIResponsesAdapter=createOpenAIResponsesAdapter('openai_responses');
export const openAIResponsesCompatibleAdapter=createOpenAIResponsesAdapter('openai_responses_compatible');
