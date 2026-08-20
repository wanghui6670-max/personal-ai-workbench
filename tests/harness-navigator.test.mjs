import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessNavigatorRuntime,
  buildHarnessChildEnv,
  harnessNodeSupported,
  resolveHarnessProviderConfig,
  routeContext,
  summarizeHarnessEvents
} from '../src/harness-navigator.mjs';

test('Harness Node support follows the pinned runtime engine contract',()=>{
  assert.equal(harnessNodeSupported('22.18.0'),false);
  assert.equal(harnessNodeSupported('22.19.0'),true);
  assert.equal(harnessNodeSupported('23.9.0'),false);
  assert.equal(harnessNodeSupported('24.0.0'),true);
});

test('provider configuration is explicit, bounded, and HTTPS by default',()=>{
  let config=resolveHarnessProviderConfig({OPENAI_MODEL:'gpt-test',OPENAI_API_KEY:'secret'});
  assert.equal(config.ok,true);
  assert.equal(config.api,'openai-responses');
  assert.equal(config.baseUrl,'https://api.openai.com/v1');
  assert.equal(config.maxTokens,4096);

  config=resolveHarnessProviderConfig({
    HARNESS_PROVIDER_MODEL:'local',HARNESS_PROVIDER_API_KEY:'secret',
    HARNESS_PROVIDER_BASE_URL:'http://127.0.0.1:11434/v1',HARNESS_PROVIDER_NETWORK_ZONE:'public_https'
  });
  assert.deepEqual(config,{ok:false,reason:'provider_https_required'});

  config=resolveHarnessProviderConfig({
    HARNESS_PROVIDER_MODEL:'local',HARNESS_PROVIDER_API_KEY:'secret',
    HARNESS_PROVIDER_BASE_URL:'http://127.0.0.1:11434/v1',HARNESS_PROVIDER_NETWORK_ZONE:'local_loopback',
    HARNESS_PROVIDER_API:'openai-completions',HARNESS_PROVIDER_MAX_TOKENS:'999999'
  });
  assert.equal(config.ok,true);
  assert.equal(config.maxTokens,32768);
});

test('sidecar child environment is a replacement allow-list, not the parent environment',()=>{
  const provider={key:'provider-secret',model:'gpt-test',api:'openai-responses',baseUrl:'https://example.test/v1',contextWindow:100000,maxTokens:4096};
  const child=buildHarnessChildEnv({
    env:{PATH:'/bin',HOME:'/home/test',SESSION_SECRET:'must-not-cross',CAPTURE_TOKEN:'must-not-cross'},
    provider,bridgeUrl:'http://127.0.0.1:4173/api/harness/mcp',bridgeToken:'bridge-secret'
  });
  assert.equal(child.PATH,'/bin');
  assert.equal(child.HARNESS_PROVIDER_API_KEY,'provider-secret');
  assert.equal(child.JOYCREW_BRIDGE_TOKEN,'bridge-secret');
  assert.equal('SESSION_SECRET' in child,false);
  assert.equal('CAPTURE_TOKEN' in child,false);
});

test('event projection exposes tool facts and navigation but drops reasoning chunks',()=>{
  const events=[
    {type:'assistant/chunk',data:{chunk:{type:'reasoning-delta',text:'private reasoning'}}},
    {type:'tool/call',data:{callId:'c1',name:'joycrew__panel_navigate',arguments:'{"view":"project","id":"p1","modal":"none"}'}},
    {type:'tool/result',data:{
      message:{source:{kind:'tool',callId:'c1'},content:[{type:'tool-result',toolCallId:'c1',isError:false,content:[{type:'text',text:'{"result":{"navigation":{"view":"project","id":"p1","modal":"none"}},"readback":true}'}]}]}
    }},
    {type:'turn/end',data:{reason:{kind:'completed'}}}
  ];
  const summary=summarizeHarnessEvents(events);
  assert.deepEqual(summary.navigation,{view:'project',id:'p1',modal:'none'});
  assert.equal(summary.trajectory.some(item=>JSON.stringify(item).includes('private reasoning')),false);
  assert.equal(summary.trajectory[0].name,'panel_navigate');
  assert.equal(summary.trajectory.at(-1).status,'completed');
});

test('route context keeps hydrated project working facts for DSH',()=>{
  const context=routeContext({
    view:'project',
    id:'p1',
    working:{
      authority:'live',
      session:{id:'sess_1',checkpoint:{note:'停在 Slice 7'}},
      project:{id:'p1',name:'Personal AI Workbench',git:'ssh://user:demo-token@example.invalid/workbench.git?token=secret#fragment',feishu:''},
      live:{git:{head:'live-head',remote:'ssh://user:demo-token@example.invalid/workbench.git?token=secret#fragment',dirty:false},feishu:{documentUrl:''},executions:[{executionId:'ex_1',tool:'project_list',status:'ok',resultSummary:'project_list:1'}]},
      conflicts:[]
    }
  });
  assert.equal(context.view,'project');
  assert.equal(context.id,'p1');
  assert.equal(context.working.authority,'live');
  assert.equal(context.working.project.id,'p1');
  assert.equal(context.working.live.gitHead,'live-head');
  assert.equal(context.working.checkpointNote,'停在 Slice 7');
  assert.equal(context.working.project.git,'ssh://example.invalid/workbench.git');
  assert.equal(context.working.live.gitRemote,'ssh://example.invalid/workbench.git');
  assert.equal(JSON.stringify(context).includes('demo-token'),false);
});

test('disabled runtime is inert and never attempts to load sidecar packages',async()=>{
  const runtime=new HarnessNavigatorRuntime({appRoot:process.cwd(),bridgeUrl:'http://127.0.0.1:4173',env:{HARNESS_ENABLED:'0'}});
  const status=runtime.status();
  assert.equal(status.available,false);
  assert.equal(status.reason,'disabled');
  await assert.rejects(runtime.run({message:'hello'}),error=>error?.code==='HARNESS_UNAVAILABLE');
  await runtime.close();
});
