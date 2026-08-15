import test from 'node:test';
import assert from 'node:assert/strict';
import {getnoteCliEnv,larkCliEnv} from '../src/external-cli-env.mjs';

test('GetNote CLI env keeps only runtime/auth necessities',()=>{
  const env=getnoteCliEnv({
    HOME:'/Users/test',PATH:'/opt/homebrew/bin:/usr/bin',LANG:'zh_CN.UTF-8',HTTPS_PROXY:'http://127.0.0.1:7897',
    GETNOTE_API_KEY:'getnote-secret',GETNOTE_CLIENT_ID:'client-id',DATA_DIR:'/private/data',WORKSPACE_ROOT:'/private/workspace',
    AI_PROVIDER_API_KEY:'ai-secret',JOYCREW_TRUSTED_PROXY_TOKEN:'joy-secret',SESSION_SECRET:'session-secret',
    GETNOTE_RUNTIME_SERVICE_TOKEN:'runtime-secret',WORKBENCH_PASSWORD:'password'
  });
  assert.equal(env.HOME,'/Users/test');
  assert.equal(env.PATH,'/opt/homebrew/bin:/usr/bin');
  assert.equal(env.GETNOTE_API_KEY,'getnote-secret');
  assert.equal(env.GETNOTE_CLIENT_ID,'client-id');
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7897');
  for(const key of ['DATA_DIR','WORKSPACE_ROOT','AI_PROVIDER_API_KEY','JOYCREW_TRUSTED_PROXY_TOKEN','SESSION_SECRET','GETNOTE_RUNTIME_SERVICE_TOKEN','WORKBENCH_PASSWORD']){
    assert.equal(Object.hasOwn(env,key),false,key);
  }
});

test('Lark CLI env is allowlist-only: runtime/network plus LARK_/FEISHU_ settings',()=>{
  const env=larkCliEnv({
    HOME:'/Users/test',PATH:'/opt/homebrew/bin:/usr/bin',HTTPS_PROXY:'http://127.0.0.1:7897',
    LARK_APP_ID:'cli-id',LARK_APP_SECRET:'lark-secret',FEISHU_ACCESS_TOKEN:'feishu-token',
    DATA_DIR:'/private/data',WORKSPACE_ROOT:'/private/workspace',OPENAI_MODEL:'gpt-secret-context',
    AI_PROVIDER_API_KEY:'ai-secret',JOYCREW_TRUSTED_PROXY_TOKEN:'joy-secret',SESSION_SECRET:'session-secret',
    GETNOTE_API_KEY:'getnote-secret',GETNOTE_CLIENT_ID:'getnote-client',GETNOTE_RUNTIME_SERVICE_TOKEN:'runtime-secret',WORKBENCH_PASSWORD:'password'
  });
  assert.equal(env.HOME,'/Users/test');
  assert.equal(env.PATH,'/opt/homebrew/bin:/usr/bin');
  assert.equal(env.LARK_APP_ID,'cli-id');
  assert.equal(env.LARK_APP_SECRET,'lark-secret');
  assert.equal(env.FEISHU_ACCESS_TOKEN,'feishu-token');
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7897');
  for(const key of ['DATA_DIR','WORKSPACE_ROOT','OPENAI_MODEL','AI_PROVIDER_API_KEY','JOYCREW_TRUSTED_PROXY_TOKEN','SESSION_SECRET','GETNOTE_API_KEY','GETNOTE_CLIENT_ID','GETNOTE_RUNTIME_SERVICE_TOKEN','WORKBENCH_PASSWORD']){
    assert.equal(Object.hasOwn(env,key),false,key);
  }
});
