export class AIProviderError extends Error {
  constructor(code,message,{cause,status,profileId,adapterId}={}){
    super(message,cause?{cause}:undefined);
    this.name='AIProviderError';
    this.code=code;
    if(Number.isInteger(status))this.status=status;
    if(profileId)this.profileId=profileId;
    if(adapterId)this.adapterId=adapterId;
  }
}

export function aiProviderError(code,message,options){
  return new AIProviderError(code,message,options);
}

export function isAbortError(error){
  return error?.name==='AbortError'||error?.name==='TimeoutError'||error?.code==='ABORT_ERR';
}

export function normalizeProviderFailure(error,{profileId,adapterId}={}){
  if(error instanceof AIProviderError)return error;
  if(isAbortError(error))return aiProviderError('AI_PROVIDER_TIMEOUT','AI Provider 请求超时',{cause:error,profileId,adapterId});
  return aiProviderError('AI_PROVIDER_NETWORK_ERROR','AI Provider 请求失败',{cause:error,profileId,adapterId});
}
