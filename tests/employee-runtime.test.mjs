import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {
  EMPLOYEE_RUNTIME_PROTOCOL,
  buildEmployeeSystemPrompt,
  createEmployeeRuntimeHttp,
  employeeCompositionDigest,
  parseEmployeeRuntimeOutput,
  validateExecuteRequest
} from '../harness/employee-runtime-server.mjs';

const composition={
  format:'joycrew.harness-composition.v1',
  compositionId:'project-coordinator',
  employeeId:'employee-project-coordinator',
  version:'1.0.0',
  systemPrompt:'你是项目协调数字员工，只根据 Evidence 工作。',
  pluginRefs:['project-context@1.0.0','evidence-summary@1.0.0'],
  toolAllowlist:['dataweave.records.read'],
  outputContract:'joycrew.runtime-output.v1',
  approvalPolicy:{externalMutation:'preview_confirm_execute',sourceExpansion:'explicit_only'},
  limits:{maxToolCalls:12,maxParallelToolCalls:1,timeoutMs:120000}
};
const request={
  protocol:EMPLOYEE_RUNTIME_PROTOCOL,
  requestId:'request-employee-1',
  task:'分析项目并给出下一步',
  project:{id:'prj-joycrew',workspaceId:'ws-dongjue',title:'Joycrew',stage:'Pilot',status:'active',nextAction:'继续 Pilot',blocker:''},
  employee:{id:'employee-project-coordinator',version:'1.0.0',name:'项目协调员工',role:'project_coordinator',skillVersions:[...composition.pluginRefs]},
  employeeComposition:composition,
  compositionDigest:employeeCompositionDigest(composition),
  evidence:{facts:['项目状态为 active'],missingInformation:[],qualityWarnings:[]},
  responseSchema:'joycrew.runtime-output.v1'
};
const output={summary:'项目 Evidence 已完成分析。',recommendations:['由用户确认下一步'],proposedNextAction:'继续 Pilot',proposedStatus:'active'};

test('employee runtime validates identity, plugin versions and canonical digest',()=>{
  const parsed=validateExecuteRequest(request);
  assert.equal(parsed.employeeComposition.compositionId,'project-coordinator');
  assert.match(parsed.compositionDigest,/^[a-f0-9]{64}$/);
  assert.throws(()=>validateExecuteRequest({...request,compositionDigest:'0'.repeat(64)}),error=>error?.code==='EMPLOYEE_COMPOSITION_DIGEST_MISMATCH');
  assert.throws(()=>validateExecuteRequest({...request,employee:{...request.employee,version:'2.0.0'}}),error=>error?.code==='EMPLOYEE_COMPOSITION_IDENTITY_MISMATCH');
});

test('employee system prompt preserves the no-source-expansion and no-mutation boundary',()=>{
  const prompt=buildEmployeeSystemPrompt(composition);
  assert.match(prompt,/只使用本轮输入中已经由 Joycrew\/DataWeave 授权并整理的 Evidence/);
  assert.match(prompt,/没有 Shell、终端、文件写入、任意 Web/);
  assert.match(prompt,/Preview → Confirm → Execute → Readback/);
  assert.match(prompt,/project-context@1\.0\.0/);
});

test('employee runtime output accepts bounded JSON and strips a single JSON fence',()=>{
  assert.deepEqual(parseEmployeeRuntimeOutput(JSON.stringify(output)),output);
  assert.deepEqual(parseEmployeeRuntimeOutput(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``),output);
  assert.throws(()=>parseEmployeeRuntimeOutput('{"summary":"missing fields"}'));
  assert.throws(()=>parseEmployeeRuntimeOutput(JSON.stringify({...output,proposedStatus:'cancelled'})),error=>error?.code==='EMPLOYEE_RUNTIME_OUTPUT_INVALID');
});

test('HTTP sidecar requires configured bearer token and returns composition attestation',async t=>{
  const calls=[];
  const pool={
    status:()=>({loadedCompositions:1,compositionIds:['project-coordinator']}),
    execute:async value=>{calls.push(value);return output;}
  };
  const token='employee-runtime-test-token-'.padEnd(40,'x');
  const server=createEmployeeRuntimeHttp({pool,env:{EMPLOYEE_HARNESS_SERVICE_TOKEN:token}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;

  let response=await fetch(`${base}/v1/execute`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
  assert.equal(response.status,403);
  assert.equal(calls.length,0);

  response=await fetch(`${base}/v1/execute`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(request)});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.protocol,EMPLOYEE_RUNTIME_PROTOCOL);
  assert.deepEqual(body.output,output);
  assert.deepEqual(body.attestation,{
    harnessVersion:'0.1.0-rc.6',
    compositionId:'project-coordinator',
    compositionVersion:'1.0.0',
    compositionDigest:request.compositionDigest
  });
  assert.equal(calls.length,1);

  const health=await fetch(`${base}/health`).then(value=>value.json());
  assert.equal(health.mode,'evidence_only');
  assert.equal(health.loadedCompositions,1);
});
