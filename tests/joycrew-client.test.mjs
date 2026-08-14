import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { JoycrewClient, JoycrewClientError, resolveJoycrewConfig } from '../src/joycrew-client.mjs';

async function withServer(handler,run){
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try{return await run(server.address().port);}finally{await new Promise(resolve=>server.close(resolve));}
}

test('resolveJoycrewConfig stays disabled by default and does not expose tokens',()=>{
  assert.deepEqual(resolveJoycrewConfig({}),{enabled:false,ok:false,reason:'disabled'});
  const config=resolveJoycrewConfig({
    JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:'http://127.0.0.1:4000',JOYCREW_NETWORK_ZONE:'local_loopback',
    JOYCREW_AUTH_MODE:'trusted_proxy',JOYCREW_TRUSTED_PROXY_TOKEN:'x'.repeat(24),JOYCREW_USER_ID:'chris',JOYCREW_WORKSPACE_ID:'ws',JOYCREW_ROLE:'admin'
  });
  assert.equal(config.ok,true);
  const status=new JoycrewClient({env:{
    JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:'http://127.0.0.1:4000',JOYCREW_NETWORK_ZONE:'local_loopback',
    JOYCREW_AUTH_MODE:'trusted_proxy',JOYCREW_TRUSTED_PROXY_TOKEN:'x'.repeat(24),JOYCREW_USER_ID:'chris',JOYCREW_WORKSPACE_ID:'ws',JOYCREW_ROLE:'admin'
  }}).status();
  assert.equal(Object.hasOwn(status,'proxyToken'),false);
  assert.equal(Object.hasOwn(status,'sessionToken'),false);
  assert.equal(Object.hasOwn(status,'baseUrl'),false,'browser-visible status must not disclose internal service topology');
  assert.equal(Object.hasOwn(status,'userId'),false);
  assert.equal(JSON.stringify(status).includes('x'.repeat(24)),false);
});

test('JoycrewClient sends trusted proxy identity and reads bounded JSON',async()=>{
  await withServer((req,res)=>{
    assert.equal(req.headers['x-joycrew-proxy-token'],'p'.repeat(24));
    assert.equal(req.headers['x-user-id'],'user-chris');
    assert.equal(req.headers['x-workspace-id'],'ws-dongjue');
    assert.equal(req.headers['x-role'],'admin');
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({service:'joycrew-api',status:'ok'}));
  },async port=>{
    const client=new JoycrewClient({env:{
      JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:`http://127.0.0.1:${port}`,JOYCREW_NETWORK_ZONE:'local_loopback',
      JOYCREW_AUTH_MODE:'trusted_proxy',JOYCREW_TRUSTED_PROXY_TOKEN:'p'.repeat(24),JOYCREW_USER_ID:'user-chris',JOYCREW_WORKSPACE_ID:'ws-dongjue',JOYCREW_ROLE:'admin'
    }});
    assert.deepEqual(await client.health(),{service:'joycrew-api',status:'ok'});
  });
});


test('JoycrewClient treats a disabled upstream feature flag as unavailable',async()=>{
  await withServer((_req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({service:'joycrew-api',status:'ok',featureEnabled:false}));
  },async port=>{
    const client=new JoycrewClient({env:{
      JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:`http://127.0.0.1:${port}`,JOYCREW_NETWORK_ZONE:'local_loopback',
      JOYCREW_AUTH_MODE:'fixture',NODE_ENV:'test'
    }});
    const probe=await client.probe();
    assert.equal(probe.available,false);
    assert.equal(probe.errorCode,'FEATURE_DISABLED');
  });
});

test('JoycrewClient maps upstream errors without leaking arbitrary response shapes',async()=>{
  await withServer((_req,res)=>{
    res.writeHead(409,{'content-type':'application/json'});
    res.end(JSON.stringify({errorCode:'SOURCE_CONFLICT',message:'Source changed',retryable:false,details:{field:'next_action'}}));
  },async port=>{
    const client=new JoycrewClient({env:{
      JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:`http://127.0.0.1:${port}`,JOYCREW_NETWORK_ZONE:'local_loopback',
      JOYCREW_AUTH_MODE:'fixture',NODE_ENV:'test',JOYCREW_USER_ID:'user-chris',JOYCREW_WORKSPACE_ID:'ws-dongjue',JOYCREW_ROLE:'admin'
    }});
    await assert.rejects(()=>client.approve('approval-1'),error=>{
      assert.ok(error instanceof JoycrewClientError);
      assert.equal(error.code,'SOURCE_CONFLICT');
      assert.equal(error.statusCode,409);
      return true;
    });
  });
});


test('JoycrewClient redacts credential-shaped response fields',async()=>{
  await withServer((_req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({status:'ok',debugToken:'must-not-cross',nested:{apiKey:'also-secret',value:'safe'}}));
  },async port=>{
    const client=new JoycrewClient({env:{
      JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:`http://127.0.0.1:${port}`,JOYCREW_NETWORK_ZONE:'local_loopback',
      JOYCREW_AUTH_MODE:'fixture',NODE_ENV:'test'
    }});
    const result=await client.health();
    assert.equal(result.debugToken,'[redacted]');
    assert.equal(result.nested.apiKey,'[redacted]');
    assert.equal(result.nested.value,'safe');
  });
});

test('JoycrewClient rejects unsafe public HTTP configuration',()=>{
  const config=resolveJoycrewConfig({
    JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:'http://example.com:4000',JOYCREW_NETWORK_ZONE:'public_https',
    JOYCREW_AUTH_MODE:'fixture',NODE_ENV:'test'
  });
  assert.equal(config.ok,false);
  assert.equal(config.reason,'https_required');
});

test('JoycrewClient enforces response size and timeout limits',async()=>{
  await withServer((_req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({payload:'x'.repeat(20_000)}));
  },async port=>{
    const client=new JoycrewClient({env:{
      JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:`http://127.0.0.1:${port}`,JOYCREW_NETWORK_ZONE:'local_loopback',
      JOYCREW_AUTH_MODE:'fixture',NODE_ENV:'test',JOYCREW_MAX_RESPONSE_BYTES:'16384'
    }});
    await assert.rejects(()=>client.health(),error=>error.code==='JOYCREW_RESPONSE_TOO_LARGE');
  });
  await withServer(async(_req,res)=>{
    await new Promise(resolve=>setTimeout(resolve,1100));
    if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end('{}');}
  },async port=>{
    const client=new JoycrewClient({env:{
      JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:`http://127.0.0.1:${port}`,JOYCREW_NETWORK_ZONE:'local_loopback',
      JOYCREW_AUTH_MODE:'fixture',NODE_ENV:'test',JOYCREW_TIMEOUT_MS:'1000'
    }});
    await assert.rejects(()=>client.health(),error=>error.code==='JOYCREW_TIMEOUT'&&error.retryable===true);
  });
  await withServer(async(_req,res)=>{
    res.writeHead(200,{'content-type':'application/json','transfer-encoding':'chunked'});
    res.write('{"status":"');
    await new Promise(resolve=>setTimeout(resolve,1100));
    if(!res.destroyed)res.end('ok"}');
  },async port=>{
    const client=new JoycrewClient({env:{
      JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:`http://127.0.0.1:${port}`,JOYCREW_NETWORK_ZONE:'local_loopback',
      JOYCREW_AUTH_MODE:'fixture',NODE_ENV:'test',JOYCREW_TIMEOUT_MS:'1000'
    }});
    await assert.rejects(()=>client.health(),error=>error.code==='JOYCREW_TIMEOUT'&&error.retryable===true);
  });
});


test('private_http network zone never permits a public HTTPS host',()=>{
  const config=resolveJoycrewConfig({
    JOYCREW_ENABLED:'1',JOYCREW_BASE_URL:'https://public.example.com',JOYCREW_NETWORK_ZONE:'private_http',
    JOYCREW_AUTH_MODE:'trusted_proxy',JOYCREW_TRUSTED_PROXY_TOKEN:'x'.repeat(24)
  });
  assert.equal(config.ok,false);
  assert.equal(config.reason,'private_host_required');
});
