import { aiProviderError } from './errors.mjs';
import { openAIResponsesAdapter, openAIResponsesCompatibleAdapter } from './adapters/openai-responses.mjs';
import { openAIChatCompletionsCompatibleAdapter } from './adapters/openai-chat-completions.mjs';

const adapters=new Map([
  [openAIResponsesAdapter.id,openAIResponsesAdapter],
  [openAIResponsesCompatibleAdapter.id,openAIResponsesCompatibleAdapter],
  [openAIChatCompletionsCompatibleAdapter.id,openAIChatCompletionsCompatibleAdapter]
]);

export function providerAdapter(adapterId){
  const adapter=adapters.get(adapterId);
  if(!adapter)throw aiProviderError('AI_PROVIDER_PROFILE_INVALID',`未注册的 AI Provider Adapter：${adapterId}`);
  return adapter;
}

export function registeredProviderAdapters(){
  return [...adapters.values()].map(adapter=>({id:adapter.id,apiStyle:adapter.apiStyle}));
}
