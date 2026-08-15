import * as SdkServer from '@deepseek-ai/dsh-sdk-jsonrpc-server';

export const name='joycrew-employee-sdk-server';
export const inject=['agents','tools'];
export const Config=SdkServer.Config;

/**
 * Employee Runtime intentionally mounts no MCP bridge in the first production
 * slice. Joycrew resolves authorized data through DataWeave before execution,
 * then supplies an Evidence draft to this runtime. This keeps the DSH process
 * unable to expand source scope or bypass Joycrew approvals.
 */
export function apply(ctx,config){
  SdkServer.apply(ctx,config);
}
