import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENAI_DEFAULT_MODEL,
  aiRuntimeConfig,
  runStructuredDecision
} from '../src/ai/index.mjs';
import { fileContentOutboundEnabled } from '../src/ai/config.mjs';

const schema={
  type:'object',additionalProperties:false,
  properties:{
    analysis:{
      type:'object',additionalProperties:false,
      properties:{
        evidence:{
          type:'array',minItems:1,maxItems:3,
          items:{
            type:'object',additionalProperties:false,
            properties:{id:{type:'string',enum:['source_1']},observation:{type:'string',minLength:1,maxLength:80}},
            required:['id','observation']
          }
        },
        conflicts:{type:'array',maxItems:2,items:{type:'string'}},
        gaps:{type:'array',maxItems:2,items:{type:'string'}}
      },
      required:['evidence','conflicts','gaps']
    },
    decision:{
      type:'object',additionalProperties:false,
      properties:{answer:{type:'string',enum:['ok']}},
      required:['answer']
    }
  },
  required:['analysis','decision']
};

const validResult={
  analysis:{evidence:[{id:'source_1',observation:'verified'}],conflicts:[],gaps:[]},
  decision:{answer:'ok'}
};

function responsePayload(result=validResult){
  return {
    status:'completed',
    id:'response-unit',
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],
    usage:{input_tokens:11,output_tokens:7}
  };
}

function localEnv(profile){
  return {
    AI_PROVIDER_PROFILE:profile,
    AI_PROVIDER_ENABLED:'1',
    AI_PROVIDER_BASE_URL:'http://127.0.0.1:11434/v1',
    AI_PROVIDER_ALLOWED_ORIGINS:'http://127.0.0.1:11434',
    AI_PROVIDER_NETWORK_ZONE:'local_loopback',
    AI_PROVIDER_MODEL:'unit-model',
    AI_PROVIDER_ALLOW_ANONYMOUS:'1'
  };
}

function fakeJsonFetch(payload,onRequest=()=>{}){
  return async (url,options)=>{
    onRequest(url,options);
    return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});
  };
}

function invokeOptions(env,fetchImpl){
  return {
    workflow:'project_creation',
    schemaName:'unit_contract',
    schemaDescription:'Unit provider contract.',
    schema,
    instructions:'Return the contract.',
    input:'[source_1] input',
    env,
    fetchImpl
  };
}

test('legacy OpenAI configuration remains the default Luna profile',()=>{
  const config=aiRuntimeConfig({OPENAI_API_KEY:['con','figured'].join('')});
  assert.equal(config.profileId,'openai_luna');
  assert.equal(config.adapter,'openai_responses');
  assert.equal(config.model,OPENAI_DEFAULT_MODEL);
  assert.equal(config.reasoningEffort,'xhigh');
  assert.equal(config.enabled,true);
  assert.equal(config.degraded,false);
});

test('Responses-compatible profile maps the strict schema contract',async()=>{
  let captured;
  const outcome=await runStructuredDecision(invokeOptions(
    localEnv('third_party_responses'),
    fakeJsonFetch(responsePayload(),(url,options)=>{captured={url,options};})
  ));
  assert.equal(captured.url,'http://127.0.0.1:11434/v1/responses');
  const body=JSON.parse(captured.options.body);
  assert.equal(body.model,'unit-model');
  assert.equal(body.reasoning.effort,'xhigh');
  assert.equal(body.store,false);
  assert.equal(body.text.format.type,'json_schema');
  assert.equal(body.text.format.strict,true);
  assert.deepEqual(outcome.decision,{answer:'ok'});
  assert.equal(outcome.execution.adapter,'openai_responses_compatible');
  assert.equal(outcome.execution.providerRequestId,'response-unit');
});

test('Chat-Completions-compatible profile maps system, user and schema separately',async()=>{
  let captured;
  const payload={
    id:'chat-unit',
    choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(validResult)}}],
    usage:{prompt_tokens:9,completion_tokens:5}
  };
  const outcome=await runStructuredDecision(invokeOptions(
    localEnv('third_party_chat_completions'),
    fakeJsonFetch(payload,(url,options)=>{captured={url,options};})
  ));
  assert.equal(captured.url,'http://127.0.0.1:11434/v1/chat/completions');
  const body=JSON.parse(captured.options.body);
  assert.equal(body.messages[0].role,'system');
  assert.equal(body.messages[1].role,'user');
  assert.equal(body.response_format.type,'json_schema');
  assert.equal(body.reasoning_effort,'xhigh');
  assert.equal(body.max_completion_tokens,32000);
  assert.deepEqual(outcome.analysis,validResult.analysis);
  assert.equal(outcome.execution.adapter,'openai_chat_completions_compatible');
});

test('disabled third-party profile performs no network request and returns local fallback signal',async()=>{
  const env={...localEnv('third_party_responses'),AI_PROVIDER_ENABLED:'0'};
  let called=false;
  const outcome=await runStructuredDecision(invokeOptions(env,async()=>{called=true;}));
  assert.equal(outcome,null);
  assert.equal(called,false);
});

test('third-party endpoint must match the explicit allowed origin',async()=>{
  const env={...localEnv('third_party_responses'),AI_PROVIDER_ALLOWED_ORIGINS:'http://127.0.0.1:11435'};
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
});

test('duplicate evidence references are rejected after provider output',async()=>{
  const duplicate={
    analysis:{
      evidence:[
        {id:'source_1',observation:'first'},
        {id:'source_1',observation:'second'}
      ],
      conflicts:[],gaps:[]
    },
    decision:{answer:'ok'}
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_responses'),fakeJsonFetch(responsePayload(duplicate)))),
    error=>error?.code==='AI_PROVIDER_RESULT_OUT_OF_SCOPE'
  );
});

test('schema-invalid provider output fails closed',async()=>{
  const invalid={...validResult,decision:{answer:'outside'}};
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_responses'),fakeJsonFetch(responsePayload(invalid)))),
    error=>error?.code==='AI_PROVIDER_SCHEMA_INVALID'
  );
});

test('provider refusal fails closed',async()=>{
  const payload={
    status:'completed',
    output:[{type:'message',content:[{type:'refusal',refusal:'blocked'}]}]
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_responses'),fakeJsonFetch(payload))),
    error=>error?.code==='AI_PROVIDER_REFUSED'
  );
});

test('explicit reasoning downgrade is visible and requires approval',async()=>{
  const rejected={...localEnv('third_party_responses'),AI_PROVIDER_REASONING_MODE:'approved_downgrade'};
  await assert.rejects(
    runStructuredDecision(invokeOptions(rejected,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_CAPABILITY_MISMATCH'
  );
  const approved={...rejected,AI_PROVIDER_ALLOW_REASONING_DOWNGRADE:'1'};
  let body;
  const outcome=await runStructuredDecision(invokeOptions(
    approved,
    fakeJsonFetch(responsePayload(),(_url,options)=>{body=JSON.parse(options.body);})
  ));
  assert.equal(Object.hasOwn(body,'reasoning'),false);
  assert.equal(outcome.execution.degraded,true);
});

test('default OpenAI request keeps Responses, xhigh, strict schema and store false',async()=>{
  let captured;
  const env={OPENAI_API_KEY:['con','figured'].join('')};
  const outcome=await runStructuredDecision(invokeOptions(
    env,
    fakeJsonFetch(responsePayload(),(url,options)=>{captured={url,options};})
  ));
  assert.equal(captured.url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(captured.options.body);
  assert.equal(body.model,OPENAI_DEFAULT_MODEL);
  assert.deepEqual(body.reasoning,{effort:'xhigh'});
  assert.equal(body.store,false);
  assert.equal(body.text.format.strict,true);
  assert.equal(outcome.execution.providerProfileId,'openai_luna');
});

test('untrusted input is redacted before it reaches any adapter',async()=>{
  let body;
  await runStructuredDecision({
    ...invokeOptions(localEnv('third_party_responses'),fakeJsonFetch(responsePayload(),(_url,options)=>{body=JSON.parse(options.body);})),
    input:['Authorization:', ['Bear','er'].join(''), ['unit','value'].join(''), `${['api','token'].join('_')}=${['unit','value'].join('')}`].join(' ')
  });
  const sent=body.input[0].content[0].text;
  assert.equal(sent.includes([['Bear','er'].join(''),['unit','value'].join('')].join(' ')),false);
  assert.equal(sent.includes(`${['api','token'].join('_')}=${['unit','value'].join('')}`),false);
  assert.equal(sent.includes('[REDACTED]'),true);
});

test('workflow allowlist blocks an unapproved workflow before network access',async()=>{
  const env={...localEnv('third_party_responses'),AI_PROVIDER_WORKFLOWS:'morning_dialogue'};
  let called=false;
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,async()=>{called=true;})),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
  assert.equal(called,false);
});

test('public profile rejects loopback IP even when it is origin-allowlisted',async()=>{
  const env={
    ...localEnv('third_party_responses'),
    AI_PROVIDER_BASE_URL:'https://127.0.0.1/v1',
    AI_PROVIDER_ALLOWED_ORIGINS:'https://127.0.0.1',
    AI_PROVIDER_NETWORK_ZONE:'public_https',
    AI_PROVIDER_ALLOW_ANONYMOUS:'0',
    AI_PROVIDER_API_KEY:['con','figured'].join('')
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
});

test('invalid timeout configuration fails closed instead of being silently clamped',async()=>{
  const env={...localEnv('third_party_responses'),AI_PROVIDER_TIMEOUT_MS:'not-an-integer'};
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
});

test('HTTP 429 is normalized without exposing the provider response body',async()=>{
  const fetchImpl=async()=>new Response('provider detail that must not escape',{status:429});
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_responses'),fetchImpl)),
    error=>error?.code==='AI_PROVIDER_RATE_LIMITED'&&!error.message.includes('provider detail')
  );
});

test('oversized provider response is rejected before JSON processing',async()=>{
  const env={...localEnv('third_party_responses'),AI_PROVIDER_MAX_RESPONSE_BYTES:'16384'};
  const oversized={...responsePayload(),padding:'x'.repeat(20000)};
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,fakeJsonFetch(oversized))),
    error=>error?.code==='AI_PROVIDER_RESPONSE_TOO_LARGE'
  );
});

test('Chat JSON-object downgrade requires approval and still uses local schema validation',async()=>{
  const env={
    ...localEnv('third_party_chat_completions'),
    AI_PROVIDER_STRUCTURED_OUTPUT_MODE:'json_object_local_validate',
    AI_PROVIDER_ALLOW_SCHEMA_DOWNGRADE:'1'
  };
  let body;
  const payload={choices:[{finish_reason:'stop',message:{content:JSON.stringify(validResult)}}]};
  const outcome=await runStructuredDecision(invokeOptions(env,fakeJsonFetch(payload,(_url,options)=>{body=JSON.parse(options.body);})));
  assert.deepEqual(body.response_format,{type:'json_object'});
  assert.equal(outcome.execution.degraded,true);
  assert.deepEqual(outcome.decision,{answer:'ok'});
});


test('legacy OPENAI_SEND_FILE_CONTENT does not carry into a third-party profile',()=>{
  assert.equal(fileContentOutboundEnabled({OPENAI_SEND_FILE_CONTENT:'1'}),true);
  assert.equal(fileContentOutboundEnabled({...localEnv('third_party_responses'),OPENAI_SEND_FILE_CONTENT:'1'}),false);
  assert.equal(fileContentOutboundEnabled({...localEnv('third_party_responses'),OPENAI_SEND_FILE_CONTENT:'1',AI_SEND_FILE_CONTENT:'1'}),true);
});

test('Chat adapter requires an explicit stop finish reason',async()=>{
  const payload={choices:[{message:{role:'assistant',content:JSON.stringify(validResult)}}]};
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_chat_completions'),fakeJsonFetch(payload))),
    error=>error?.code==='AI_PROVIDER_BAD_RESPONSE'
  );
});

test('Chat adapter rejects tool-call output in a structured decision',async()=>{
  const payload={
    choices:[{
      finish_reason:'stop',
      message:{role:'assistant',content:JSON.stringify(validResult),tool_calls:[{id:'call-unit',type:'function'}]}
    }]
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_chat_completions'),fakeJsonFetch(payload))),
    error=>error?.code==='AI_PROVIDER_BAD_RESPONSE'
  );
});

test('Chat JSON object downgrade requires approval and remains visible',async()=>{
  const rejected={...localEnv('third_party_chat_completions'),AI_PROVIDER_STRUCTURED_OUTPUT_MODE:'json_object_local_validate'};
  await assert.rejects(
    runStructuredDecision(invokeOptions(rejected,fakeJsonFetch({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(validResult)}}]}))),
    error=>error?.code==='AI_PROVIDER_CAPABILITY_MISMATCH'
  );
  const approved={...rejected,AI_PROVIDER_ALLOW_SCHEMA_DOWNGRADE:'1'};
  let body;
  const outcome=await runStructuredDecision(invokeOptions(
    approved,
    fakeJsonFetch({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(validResult)}}]},(_url,options)=>{body=JSON.parse(options.body);})
  ));
  assert.deepEqual(body.response_format,{type:'json_object'});
  assert.equal(outcome.execution.degraded,true);
});

test('no-store downgrade requires explicit approval',async()=>{
  const rejected={...localEnv('third_party_responses'),AI_PROVIDER_NO_STORE_MODE:'approved_unsupported'};
  await assert.rejects(
    runStructuredDecision(invokeOptions(rejected,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_CAPABILITY_MISMATCH'
  );
  const approved={...rejected,AI_PROVIDER_ALLOW_NO_STORE_DOWNGRADE:'1'};
  let body;
  const outcome=await runStructuredDecision(invokeOptions(
    approved,
    fakeJsonFetch(responsePayload(),(_url,options)=>{body=JSON.parse(options.body);})
  ));
  assert.equal(Object.hasOwn(body,'store'),false);
  assert.equal(outcome.execution.degraded,true);
});

test('429 and authentication failures use stable error codes',async()=>{
  const rateLimited=async()=>new Response('',{status:429});
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_responses'),rateLimited)),
    error=>error?.code==='AI_PROVIDER_RATE_LIMITED'
  );
  const unauthorized=async()=>new Response('',{status:401});
  await assert.rejects(
    runStructuredDecision(invokeOptions(localEnv('third_party_responses'),unauthorized)),
    error=>error?.code==='AI_PROVIDER_AUTH_FAILED'
  );
});

test('provider response body is bounded before JSON parsing',async()=>{
  const env={...localEnv('third_party_responses'),AI_PROVIDER_MAX_RESPONSE_BYTES:'16384'};
  const oversized='x'.repeat(17_000);
  const fetchImpl=async()=>new Response(oversized,{status:200,headers:{'Content-Length':String(oversized.length)}});
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,fetchImpl)),
    error=>error?.code==='AI_PROVIDER_RESPONSE_TOO_LARGE'
  );
});

test('public third-party profile rejects a private IP endpoint',async()=>{
  const env={
    AI_PROVIDER_PROFILE:'third_party_responses',
    AI_PROVIDER_ENABLED:'1',
    AI_PROVIDER_BASE_URL:'https://127.0.0.1/v1',
    AI_PROVIDER_ALLOWED_ORIGINS:'https://127.0.0.1',
    AI_PROVIDER_NETWORK_ZONE:'public_https',
    AI_PROVIDER_MODEL:'unit-model',
    AI_PROVIDER_API_KEY:['unit','value'].join('-')
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
});


test('provider-neutral file-content switch supersedes the legacy OpenAI-only alias',()=>{
  assert.equal(fileContentOutboundEnabled({OPENAI_SEND_FILE_CONTENT:'1'}),true);
  assert.equal(fileContentOutboundEnabled({AI_PROVIDER_PROFILE:'third_party_responses',OPENAI_SEND_FILE_CONTENT:'1'}),false);
  assert.equal(fileContentOutboundEnabled({AI_PROVIDER_PROFILE:'third_party_responses',AI_SEND_FILE_CONTENT:'1'}),true);
  assert.equal(fileContentOutboundEnabled({AI_SEND_FILE_CONTENT:'0',OPENAI_SEND_FILE_CONTENT:'1'}),false);
});


test('runtime config never exposes endpoint or credential material',()=>{
  const env={...localEnv('third_party_responses'),AI_PROVIDER_ALLOW_ANONYMOUS:'0',AI_PROVIDER_API_KEY:['unit','configured'].join('-')};
  const config=aiRuntimeConfig(env);
  assert.equal(config.profileId,'third_party_responses');
  assert.equal(Object.hasOwn(config,'credential'),false);
  assert.equal(Object.hasOwn(config,'endpoint'),false);
  assert.equal(JSON.stringify(config).includes('unit-configured'),false);
  assert.equal(JSON.stringify(config).includes('127.0.0.1'),false);
});

test('third-party base URL rejects embedded credentials and query parameters',async()=>{
  const withCredentials={
    ...localEnv('third_party_responses'),
    AI_PROVIDER_BASE_URL:'http://user:pass@127.0.0.1:11434/v1',
    AI_PROVIDER_ALLOWED_ORIGINS:'http://127.0.0.1:11434'
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(withCredentials,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
  const withQuery={
    ...localEnv('third_party_responses'),
    AI_PROVIDER_BASE_URL:'http://127.0.0.1:11434/v1?api-version=unit'
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(withQuery,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
});

test('public third-party endpoint requires HTTPS',async()=>{
  const env={
    AI_PROVIDER_PROFILE:'third_party_responses',
    AI_PROVIDER_ENABLED:'1',
    AI_PROVIDER_BASE_URL:'http://203.0.113.10/v1',
    AI_PROVIDER_ALLOWED_ORIGINS:'http://203.0.113.10',
    AI_PROVIDER_NETWORK_ZONE:'public_https',
    AI_PROVIDER_MODEL:'unit-model',
    AI_PROVIDER_API_KEY:['unit','configured'].join('-')
  };
  await assert.rejects(
    runStructuredDecision(invokeOptions(env,fakeJsonFetch(responsePayload()))),
    error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
  );
});


test('public third-party profile rejects special-purpose IPv6 endpoints',async()=>{
  for(const address of ['::2','64:ff9b::7f00:1','2001:db8::1','2002:7f00:1::']){
    const origin=`https://[${address}]`;
    const env={
      AI_PROVIDER_PROFILE:'third_party_responses',
      AI_PROVIDER_ENABLED:'1',
      AI_PROVIDER_BASE_URL:`${origin}/v1`,
      AI_PROVIDER_ALLOWED_ORIGINS:origin,
      AI_PROVIDER_NETWORK_ZONE:'public_https',
      AI_PROVIDER_MODEL:'unit-model',
      AI_PROVIDER_API_KEY:['unit','configured'].join('-')
    };
    await assert.rejects(
      runStructuredDecision(invokeOptions(env,fakeJsonFetch(responsePayload()))),
      error=>error?.code==='AI_PROVIDER_PROFILE_INVALID'
    );
  }
});
