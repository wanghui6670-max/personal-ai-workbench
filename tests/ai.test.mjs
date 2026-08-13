import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProjectWithAI, askStructured, classifyProjectDescription, morningConversation } from '../src/ai.mjs';

const successfulProgress={percent:42,summary:'ok',resume:'ok',blocker:'none',status:'进行中',confidence:.8};
const schema={type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']};

function firstAllowedEvidenceId(body){
  return body.text?.format?.schema?.properties?.analysis?.properties?.evidence?.items?.properties?.id?.enum?.[0]||'input_1';
}

function analysisEnvelope(decision,analysis={},evidenceId='input_1'){
  return {
    analysis:{evidence:[{id:evidenceId,observation:'本地证据已读取'}],conflicts:[],gaps:[],...analysis},
    decision
  };
}

function responseEnvelope(body,decision,analysis={}){
  return analysisEnvelope(decision,analysis,firstAllowedEvidenceId(body));
}

function rawStructuredResponse(value,{status='completed'}={}){
  return{
    status,
    output:[
      {type:'reasoning',summary:[]},
      {type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value),annotations:[]}]}
    ]
  };
}

function requestInputText(body){
  return body.input?.[0]?.content?.[0]?.text||'';
}

function installAiTestEnvironment(t,fetchImpl,{sendFileContent,model='gpt-test'}={}) {
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.OPENAI_API_KEY;
  const originalModel=process.env.OPENAI_MODEL;
  const originalSend=process.env.OPENAI_SEND_FILE_CONTENT;
  globalThis.fetch=fetchImpl;
  process.env.OPENAI_API_KEY='test-api-key-not-a-real-secret';
  if(model===null)delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL=model;
  if(sendFileContent===undefined)delete process.env.OPENAI_SEND_FILE_CONTENT;
  else process.env.OPENAI_SEND_FILE_CONTENT=sendFileContent;
  t.after(()=>{
    globalThis.fetch=originalFetch;
    if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;
    if(originalModel===undefined)delete process.env.OPENAI_MODEL;else process.env.OPENAI_MODEL=originalModel;
    if(originalSend===undefined)delete process.env.OPENAI_SEND_FILE_CONTENT;else process.env.OPENAI_SEND_FILE_CONTENT=originalSend;
  });
}

function progressInput(overrides={}) {
  return {
    project:{name:'Privacy test',intro:'benign-description API_KEY=description-secret',startDate:'2026-08-01',endDate:'2026-08-31',completed:false},
    projectMd:'PROJECT_BODY_SENTINEL password=project-secret',
    files:[{mtime:'2026-08-12T00:00:00.000Z',path:'notes.md'}],
    git:{remote:'https://git-user:git-password@example.com/repo.git',commits:[{date:'2026-08-12',hash:'abc123',subject:'Bearer bearer-secret-value'}]},
    snippets:['SNIPPET_BODY_SENTINEL ghp_1234567890abcdefghijklmnop'],
    fallback:{summary:'safe fallback'},
    ...overrides
  };
}

test('project analysis defaults to Luna xhigh with the bounded deep-analysis request',async t=>{
  let request;
  let timeoutMs;
  const originalTimeout=AbortSignal.timeout;
  AbortSignal.timeout=milliseconds=>{
    timeoutMs=milliseconds;
    return originalTimeout(milliseconds);
  };
  t.after(()=>{AbortSignal.timeout=originalTimeout;});
  installAiTestEnvironment(t,async(url,options)=>{
    request={url,options};
    const body=JSON.parse(options.body);
    return{ok:true,status:200,json:async()=>rawStructuredResponse(responseEnvelope(body,successfulProgress))};
  },{model:null});

  const result=await analyzeProjectWithAI(progressInput());
  assert.deepEqual(result,successfulProgress,'the wrapper must expose only the decision, not chain-of-thought fields');
  assert.equal(request.url,'https://api.openai.com/v1/responses');
  assert.equal(request.options.method,'POST');
  assert.ok(request.options.signal instanceof AbortSignal,'OpenAI request must have a timeout signal');
  assert.equal(timeoutMs,120_000);
  const body=JSON.parse(request.options.body);
  assert.equal(body.model,'gpt-5.6-luna');
  assert.deepEqual(body.reasoning,{effort:'xhigh'});
  assert.equal(body.store,false);
  assert.equal(body.max_output_tokens,32_000);
  assert.equal(body.text.format.type,'json_schema');
  assert.deepEqual(body.text.format.schema.required,['analysis','decision']);
  assert.equal(body.text.format.schema.additionalProperties,false);
  assert.equal(body.text.format.schema.properties.analysis.properties.evidence.minItems,1);
  assert.equal(body.text.format.schema.properties.analysis.properties.evidence.items.type,'object');
  assert.deepEqual(body.text.format.schema.properties.analysis.properties.evidence.items.required,['id','observation']);
  assert.ok(body.text.format.schema.properties.analysis.properties.evidence.items.properties.id.enum.length>0);
  assert.equal(body.text.format.schema.properties.analysis.properties.conflicts.type,'array');
  assert.equal(body.text.format.schema.properties.analysis.properties.gaps.type,'array');
  assert.deepEqual(body.text.format.schema.properties.decision.required,['percent','summary','resume','blocker','status','confidence']);
  assert.equal(body.input[0].role,'user');
  assert.equal(body.input[0].content[0].type,'input_text');
  assert.match(body.instructions,/不能替用户安排工作/);
  assert.doesNotMatch(body.instructions,/benign-description|PROJECT_BODY_SENTINEL/,'project data must not be elevated into developer instructions');
  const input=requestInputText(body);
  assert.match(input,/benign-description/,'project descriptions remain available to AI');
  assert.doesNotMatch(input,/PROJECT_BODY_SENTINEL|SNIPPET_BODY_SENTINEL/);
  assert.doesNotMatch(input,/description-secret|bearer-secret-value/);
  assert.match(input,/\[REDACTED\]/);
  assert.doesNotMatch(request.options.body,/test-api-key-not-a-real-secret/,'API key belongs only in the authorization header');
});

test('explicit file-content opt-in still redacts common credential forms',async t=>{
  let input;
  installAiTestEnvironment(t,async(_url,options)=>{
    const body=JSON.parse(options.body);
    input=requestInputText(body);
    return{ok:true,status:200,json:async()=>rawStructuredResponse(responseEnvelope(body,successfulProgress))};
  },{sendFileContent:'1'});
  const privateKey='-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----';
  await analyzeProjectWithAI(progressInput({
    projectMd:`PROJECT_BODY_SENTINEL https://alice:url-password@example.com/repo OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz`,
    snippets:[`SNIPPET_BODY_SENTINEL github_pat_abcdefghijklmnopqrstuvwxyz0123456789 TOKEN="quoted-token" ${privateKey}`]
  }));

  assert.match(input,/PROJECT_BODY_SENTINEL/);
  assert.match(input,/SNIPPET_BODY_SENTINEL/);
  for(const secret of ['alice','url-password','sk-proj-abcdefghijklmnopqrstuvwxyz','github_pat_abcdefghijklmnopqrstuvwxyz0123456789','quoted-token','private-key-material'])assert.doesNotMatch(input,new RegExp(secret));
  assert.match(input,/https:\/\/\[REDACTED\]@example\.com\/repo/);
  assert.match(input,/\[REDACTED PRIVATE KEY\]/);
});

test('OpenAI failures expose only status or a stable safe summary',async t=>{
  const providerSecret='PROVIDER_RESPONSE_BODY_SECRET';
  let bodyRead=false;
  installAiTestEnvironment(t,async()=>({
    ok:false,status:429,
    text:async()=>{bodyRead=true;return providerSecret;}
  }));
  await assert.rejects(
    askStructured({name:'project_progress',description:'test',schema,input:'safe'}),
    error=>{
      assert.equal(error.code,'AI_PROVIDER_RATE_LIMITED');
      assert.doesNotMatch(error.message,new RegExp(providerSecret));
      return true;
    }
  );
  assert.equal(bodyRead,false,'provider error bodies must not be read');

  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({output_text:`not-json-${providerSecret}`})});
  await assert.rejects(
    askStructured({name:'project_progress',description:'test',schema,input:'safe'}),
    error=>{
      assert.equal(error.code,'AI_PROVIDER_SCHEMA_INVALID');
      assert.doesNotMatch(error.message,new RegExp(providerSecret));
      return true;
    }
  );
});

test('raw Responses output rejects incomplete responses and explicit refusals',async t=>{
  installAiTestEnvironment(t,async()=>({
    ok:true,status:200,json:async()=>({
      ...rawStructuredResponse(analysisEnvelope({ok:true}),{status:'incomplete'}),
      incomplete_details:{reason:'max_output_tokens'}
    })
  }));
  await assert.rejects(
    askStructured({name:'project_progress',description:'test',schema,input:'safe'}),
    {code:'AI_PROVIDER_INCOMPLETE',message:'AI Provider 返回了不完整结果'}
  );

  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({
    status:'completed',
    output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'provider refusal details must stay private'}]}]
  })});
  await assert.rejects(
    askStructured({name:'morning_dialogue',description:'test',schema,input:'safe'}),
    error=>{
      assert.equal(error.code,'AI_PROVIDER_REFUSED');
      assert.doesNotMatch(error.message,/provider refusal details/);
      return true;
    }
  );
});

test('parsed JSON is checked locally against the requested schema',async t=>{
  installAiTestEnvironment(t,async(_url,options)=>{
    const body=JSON.parse(options.body);
    return{ok:true,status:200,json:async()=>rawStructuredResponse(responseEnvelope(body,{ok:'not-a-boolean'}))};
  });
  await assert.rejects(
    askStructured({name:'project_creation',description:'test',schema,input:'safe'}),
    {code:'AI_PROVIDER_SCHEMA_INVALID',message:'AI Provider 返回的结构化结果不符合约束'}
  );
});

test('all three AI judgment workflows require an analysis envelope and return only its decision',async t=>{
  const classification={name:'来源治理',intro:'补齐数据来源治理。',businessId:'biz_allowed',confidence:.84};
  const dialogue={reply:'先讨论候选项目。',mentionedIds:['p_allowed']};
  const requests=[];
  installAiTestEnvironment(t,async(_url,options)=>{
    const body=JSON.parse(options.body);
    requests.push(body);
    const decisions={project_creation:classification,project_progress:successfulProgress,morning_dialogue:dialogue};
    return{ok:true,status:200,json:async()=>rawStructuredResponse(responseEnvelope(body,decisions[body.text.format.name]))};
  });

  assert.deepEqual(
    await classifyProjectDescription('补齐数据来源',[{id:'biz_allowed',name:'客户业务'}]),
    classification
  );
  assert.deepEqual(await analyzeProjectWithAI(progressInput()),successfulProgress);
  assert.deepEqual(await morningConversation({
    recent:[],projects:[{id:'p_allowed',title:'候选项目'}],todos:[],message:'看看今天',history:[]
  }),dialogue);

  assert.deepEqual(requests.map(body=>body.text.format.name),['project_creation','project_progress','morning_dialogue']);
  for(const body of requests){
    const envelopeSchema=body.text.format.schema;
    assert.equal(envelopeSchema.type,'object');
    assert.equal(envelopeSchema.additionalProperties,false);
    assert.deepEqual(envelopeSchema.required,['analysis','decision']);
    assert.deepEqual(envelopeSchema.properties.analysis.required,['evidence','conflicts','gaps']);
    assert.equal(envelopeSchema.properties.analysis.properties.evidence.minItems,1);
    assert.equal(envelopeSchema.properties.analysis.properties.evidence.items.additionalProperties,false);
    assert.ok(envelopeSchema.properties.analysis.properties.evidence.items.properties.id.enum.length>0);
    assert.ok(envelopeSchema.properties.decision,'the original business schema must live under decision');
    assert.deepEqual(body.reasoning,{effort:'xhigh'});
  }
  assert.equal(requests[0].text.format.schema.properties.decision.properties.businessId.anyOf[0].enum[0],'biz_allowed');
  assert.equal(
    requests[1].text.format.schema.properties.decision.properties.status.enum.includes('已完成'),
    false,
    'an incomplete project must not offer AI the completed status'
  );
  assert.equal(requests[2].text.format.schema.properties.decision.properties.mentionedIds.items.enum[0],'p_allowed');
  assert.equal(Object.hasOwn(requests[2].text.format.schema.properties.decision.properties,'todayPlan'),false);
});

test('missing or empty analysis evidence triggers each workflow fallback',async t=>{
  let responseFactory=()=>({ok:true});
  installAiTestEnvironment(t,async(_url,options)=>{
    const body=JSON.parse(options.body);
    return{ok:true,status:200,json:async()=>rawStructuredResponse(responseFactory(body))};
  });

  assert.equal(
    await classifyProjectDescription('缺少分析证据',[{id:'biz_allowed',name:'客户业务'}]),
    null,
    'legacy decision-only output must not bypass the analysis envelope'
  );
  assert.equal(await analyzeProjectWithAI(progressInput()),null);
  assert.equal(await morningConversation({recent:[],projects:[],todos:[],message:'看看今天',history:[]}),null);

  const decisions={
    project_creation:{name:'不应采用',intro:'没有证据。',businessId:null,confidence:.9},
    project_progress:successfulProgress,
    morning_dialogue:{reply:'不应采用',mentionedIds:[]}
  };
  responseFactory=body=>responseEnvelope(body,decisions[body.text.format.name],{evidence:[]});
  assert.equal(
    await classifyProjectDescription('空证据',[{id:'biz_allowed',name:'客户业务'}]),
    null
  );
  assert.equal(await analyzeProjectWithAI(progressInput()),null);
  assert.equal(await morningConversation({recent:[],projects:[],todos:[],message:'看看今天',history:[]}),null);
});

test('fabricated evidence references are rejected before a decision can be used',async t=>{
  installAiTestEnvironment(t,async(_url,options)=>{
    const body=JSON.parse(options.body);
    const decision={percent:88,summary:'不应采用',resume:'不应采用',blocker:'无',status:'进行中',confidence:.99};
    return{
      ok:true,status:200,
      json:async()=>rawStructuredResponse(analysisEnvelope(decision,{},'fabricated_source_id'))
    };
  });

  assert.equal(await analyzeProjectWithAI(progressInput()),null);
});

test('morning dialogue can only mention supplied candidate ids',async t=>{
  let requestBody;
  installAiTestEnvironment(t,async(_url,options)=>{
    requestBody=JSON.parse(options.body);
    return{ok:true,status:200,json:async()=>rawStructuredResponse(responseEnvelope(requestBody,{reply:'先讨论候选项目。',mentionedIds:['outside-id']}))};
  });
  const args={recent:[],projects:[{id:'p_allowed',title:'候选项目'}],todos:[{id:'td_allowed',title:'候选待办'}],message:'看看今天',history:[]};
  assert.equal(await morningConversation(args),null,'out-of-scope ids must trigger the local fallback');
  assert.deepEqual(requestBody.text.format.schema.properties.decision.properties.mentionedIds.items.enum,['p_allowed','td_allowed']);
  assert.equal(requestBody.text.format.schema.properties.decision.properties.reply.pattern,'^[\\s\\S]{1,1200}$');

  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    return{ok:true,status:200,json:async()=>rawStructuredResponse(responseEnvelope(body,{reply:'先讨论候选项目。',mentionedIds:['p_allowed']}))};
  };
  assert.deepEqual(await morningConversation(args),{reply:'先讨论候选项目。',mentionedIds:['p_allowed']});
});
