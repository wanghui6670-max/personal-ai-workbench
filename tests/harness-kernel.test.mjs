import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventStore } from '../platform/kernel/event-store.mjs';
import { createStateProjector } from '../platform/kernel/state-projector.mjs';
import { createTraceStore } from '../platform/kernel/trace-store.mjs';

test('event store is append-only and idempotent by event id', async () => {
  const events=createEventStore();
  const first=await events.append({id:'evt-1',type:'session.created',stream:'session:demo',data:{goal:'demo'}});
  const replay=await events.append({id:'evt-1',type:'session.created',stream:'session:demo',data:{goal:'demo'}});
  assert.equal(first.id,'evt-1');
  assert.equal(replay.replayed,true);
  assert.equal((await events.readStream('session:demo')).length,1);
  await assert.rejects(()=>events.append({id:'evt-1',type:'different',stream:'session:demo',data:{}}),/event id conflict/i);
});

test('state projector rebuilds deterministic state from events', async () => {
  const projector=createStateProjector({initialState:()=>({count:0}),reduce:(state,event)=>({count:state.count+(event.type==='inc'?1:0)})});
  const state=projector.project([{id:'1',type:'inc'},{id:'2',type:'inc'},{id:'3',type:'noop'}]);
  assert.deepEqual(state,{count:2});
});

test('trace store records agent tool approval lifecycle without hidden reasoning', async () => {
  const traces=createTraceStore();
  await traces.append('run-1',{type:'agent.start',data:{agentId:'research'}});
  await traces.append('run-1',{type:'tool.call',data:{name:'aihot.latest',args:{}}});
  await traces.append('run-1',{type:'tool.result',data:{name:'aihot.latest',ok:true}});
  const trace=await traces.read('run-1');
  assert.equal(trace.length,3);
  assert.equal(JSON.stringify(trace).includes('chain_of_thought'),false);
});
