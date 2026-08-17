import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessRuntime} from '../platform/index.mjs';
import {AihotClient,AIHOT_BASE_URL} from '../plugins/aihot/client.mjs';
import {createAihotPack} from '../plugins/aihot/manifest.mjs';

function response({status=200,body=null,etag=null}={}){
  return {ok:status>=200&&status<300,status,headers:{get:name=>name.toLowerCase()==='etag'?etag:null},async json(){return body;}};
}

test('AIHot client uses the fixed official v1 read endpoint and bounded query parameters',async()=>{
  const calls=[];
  const client=new AihotClient({fetchImpl:async(url,options)=>{calls.push({url,options});return response({body:{items:[{id:1}]},etag:'"v1"'});}});
  const body=await client.latest({limit:20,window:'24h',mode:'selected'});
  assert.deepEqual(body,{items:[{id:1}]});
  const parsed=new URL(calls[0].url);
  assert.equal(parsed.origin,AIHOT_BASE_URL);
  assert.equal(parsed.pathname,'/api/v1/items');
  assert.equal(parsed.searchParams.get('mode'),'selected');
  assert.equal(parsed.searchParams.get('window'),'24h');
  assert.equal(parsed.searchParams.get('limit'),'20');
  assert.equal(calls[0].options.method,'GET');
});

test('AIHot client reuses cached payload on ETag 304',async()=>{
  const calls=[];
  let count=0;
  const client=new AihotClient({fetchImpl:async(url,options)=>{
    calls.push({url,options});count+=1;
    if(count===1)return response({body:{items:['cached']},etag:'"abc"'});
    return response({status:304});
  }});
  assert.deepEqual(await client.latest(),{items:['cached']});
  assert.deepEqual(await client.latest(),{items:['cached']});
  assert.equal(calls[1].options.headers['If-None-Match'],'"abc"');
});

test('real AIHot pack installs without modifying Harness core and remains read-only',async()=>{
  const client={latest:async input=>({items:[input.limit??20]})};
  const runtime=new HarnessRuntime();
  runtime.install(createAihotPack({client}));
  const result=await runtime.invoke('aihot.latest',{limit:5},{agentId:'research-agent'});
  assert.equal(result.ok,true);
  assert.deepEqual(result.result,{items:[5]});
  assert.equal(runtime.registry.getTool('aihot.latest').risk,'read');
});
