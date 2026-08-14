import path from 'node:path';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import * as SdkServer from '@deepseek-ai/dsh-sdk-jsonrpc-server';

export const name='joycrew-sdk-server';
export const inject=['agents','tools'];
export const Config=SdkServer.Config;

function requiredEnv(name){
  const value=String(process.env[name]||'').trim();
  if(!value)throw new Error(`${name} is required for the Joycrew Navigator bridge`);
  return value;
}

/**
 * Gate the SDK protocol on MCP readiness. The parent SDK cannot complete its
 * initialize handshake until the official MCP client has connected, listed the
 * fixed Workbench tools, and published them into the Harness registry.
 */
export async function apply(ctx,config){
  const cwd=process.cwd();
  await McpClient.apply(ctx,{
    serverName:'joycrew',
    transport:'stdio',
    command:process.execPath,
    args:[path.join(cwd,'joycrew-mcp-server.mjs')],
    cwd,
    env:{
      JOYCREW_BRIDGE_URL:requiredEnv('JOYCREW_BRIDGE_URL'),
      JOYCREW_BRIDGE_TOKEN:requiredEnv('JOYCREW_BRIDGE_TOKEN')
    },
    toolCallTimeoutMs:60_000,
    failOnStartupError:true,
    reconnect:{enabled:false,initialDelayMs:500,maxDelayMs:5000,maxAttempts:1}
  });
  SdkServer.apply(ctx,config);
}
