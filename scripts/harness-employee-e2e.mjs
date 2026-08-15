import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {harnessNodeSupported} from '../src/harness-navigator.mjs';
import {buildEmployeeSystemPrompt,buildEmployeeUserInput,employeeCompositionDigest,parseEmployeeRuntimeOutput} from '../harness/employee-runtime-server.mjs';

if(!harnessNodeSupported())throw new Error('Employee Harness E2E requires Node 22.19+ or Node 24+');
const root=path.resolve('.');
const harnessDir=path.join(root,'harness');
const require=createRequire(path.join(harnessDir,'package.json'));
const sdkEntry=require.resolve('@deepseek-ai/dsh-sdk-client');
require.resolve('@deepseek-ai/dsh-llm-replay/package.json');
const {DeepSeekHarness}=await import(pathToFileURL(sdkEntry).href);

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
  protocol:'joycrew.deepseek-harness.v1',requestId:'employee-e2e',task:'分析项目并给出下一步',
  project:{id:'prj-joycrew',workspaceId:'ws-dongjue',title:'Joycrew',stage:'Pilot',status:'active',nextAction:'确认项目下一步',blocker:''},
  employee:{id:'employee-project-coordinator',version:'1.0.0',name:'项目协调员工',role:'project_coordinator',skillVersions:[...composition.pluginRefs]},
  employeeComposition:composition,compositionDigest:employeeCompositionDigest(composition),
  evidence:{facts:['项目状态为 active'],missingInformation:[],qualityWarnings:[]},responseSchema:'joycrew.runtime-output.v1'
};
const childEnv={
  PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp',
  EMPLOYEE_SYSTEM_PROMPT:buildEmployeeSystemPrompt(composition),
  DSH_SNAPSHOT_FILE:path.join(harnessDir,'fixtures','employee-runtime-session.jsonl'),
  DSH_SNAPSHOT_OVERRIDE:path.join(harnessDir,'fixtures','employee-runtime-replay.override.json'),
  DSH_TELEMETRY_DISABLED:'1',NO_COLOR:'1'
};
const harness=new DeepSeekHarness({
  launch:{
    command:process.execPath,
    args:[path.join(harnessDir,'runtime-bin.mjs'),path.join(harnessDir,'employee.test.cordis.yml')],
    cwd:harnessDir,env:childEnv,requestTimeoutMs:30_000,shutdownTimeoutMs:1500,disposeEofGraceMs:6000,disposeGraceMs:3000
  },
  cwd:root,provider:'employee',model:'employee-replay',maxTokens:512
});
try{
  const result=await harness.run(buildEmployeeUserInput(request));
  const output=parseEmployeeRuntimeOutput(result.finalResponse);
  assert.deepEqual(output,{
    summary:'项目 Evidence 已完成受控分析。',
    recommendations:['由用户确认下一步后再执行'],
    proposedNextAction:'确认项目下一步',
    proposedStatus:'active'
  });
  assert.equal(result.events.some(event=>event.type==='tool/call'),false,'evidence-only employee runtime must not invent a tool call');
  console.log('Employee Harness E2E passed: Joycrew evidence input -> DSH Agent Loop -> bounded RuntimeOutput JSON.');
}finally{
  await harness.close().catch(()=>undefined);
}
