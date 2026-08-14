import test from 'node:test';
import assert from 'node:assert/strict';
import { JoycrewActionBroker } from '../src/joycrew-actions.mjs';

function fakeClient(){
  const calls=[];
  return{
    calls,
    async createRun(projectId,input){calls.push(['run',projectId,input]);return{run:{id:'run-1',projectId,status:'succeeded'}};},
    async createDeliverable(runId,title){calls.push(['deliverable',runId,title]);return{deliverable:{id:'del-1',runId,title}};},
    async approve(id){calls.push(['approve',id]);return{approval:{id,status:'executed'}};},
    async reject(id){calls.push(['reject',id]);return{approval:{id,status:'rejected'}};}
  };
}

test('action broker prepares without calling Joycrew and executes once after confirmation',async()=>{
  const client=fakeClient();
  const broker=new JoycrewActionBroker({client,now:()=>Date.parse('2026-08-14T00:00:00Z')});
  const action=broker.prepare('run.create',{
    projectId:'project-1',task:'读取当前资料并形成证据化下一步',employeeId:'employee-coordinator',
    sources:[{kind:'records',sourceId:'src-feishu-business',entity:'Project',filters:[]}]
  },{source:'test'});
  assert.equal(client.calls.length,0);
  assert.equal(action.status,'pending');
  await assert.rejects(()=>broker.execute(action.id,{confirmed:false}),/必须先确认/);
  const executed=await broker.execute(action.id,{confirmed:true});
  assert.equal(executed.status,'executed');
  assert.equal(client.calls.length,1);
  const replay=await broker.execute(action.id,{confirmed:true});
  assert.equal(replay.result.run.id,'run-1');
  assert.equal(client.calls.length,1);
});

test('action broker rejects path traversal and supports cancellation',()=>{
  const broker=new JoycrewActionBroker({client:fakeClient()});
  assert.throws(()=>broker.prepare('run.create',{
    projectId:'p',task:'abc',employeeId:'e',sources:[{kind:'file',sourceId:'local',relativePath:'../.env'}]
  }),/目录穿越/);
  const action=broker.prepare('approval.decide',{approvalId:'a-1',decision:'reject'});
  const cancelled=broker.cancel(action.id);
  assert.equal(cancelled.status,'cancelled');
});


test('action broker expires pending previews with an explicit 410 and never calls Joycrew',async()=>{
  const client=fakeClient();
  let now=Date.parse('2026-08-14T00:00:00Z');
  const broker=new JoycrewActionBroker({client,now:()=>now,ttlMs:1000});
  const action=broker.prepare('approval.decide',{approvalId:'a-expired',decision:'approve'});
  now+=1001;
  await assert.rejects(()=>broker.execute(action.id,{confirmed:true}),error=>error.code==='JOYCREW_ACTION_EXPIRED'&&error.statusCode===410);
  assert.equal(client.calls.length,0);
});


test('uncertain upstream results are not retryable with the same action preview',async()=>{
  const client=fakeClient();
  client.createRun=async()=>{client.calls.push(['run-uncertain']);throw Object.assign(new Error('connection lost after send'),{code:'JOYCREW_UNREACHABLE'});};
  const broker=new JoycrewActionBroker({client});
  const action=broker.prepare('run.create',{
    projectId:'project-uncertain',task:'执行可能已经到达上游的任务',employeeId:'employee-coordinator',
    sources:[{kind:'records',sourceId:'src-feishu-business',entity:'Project',filters:[]}]
  });
  await assert.rejects(()=>broker.execute(action.id,{confirmed:true}),/connection lost/);
  const listed=broker.list();
  assert.equal(listed[0].status,'uncertain');
  assert.equal(listed[0].error.retryable,false);
  await assert.rejects(()=>broker.execute(action.id,{confirmed:true}),error=>error.code==='JOYCREW_ACTION_UNCERTAIN');
  assert.equal(client.calls.length,1,'the same uncertain action must never be retried');
  assert.throws(()=>broker.cancel(action.id),error=>error.code==='JOYCREW_ACTION_UNCERTAIN');
});
