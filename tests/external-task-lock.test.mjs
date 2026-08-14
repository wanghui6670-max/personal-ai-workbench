import test from 'node:test';
import assert from 'node:assert/strict';
import { withExternalTaskWriteLease } from '../src/mcp/external-task-tools.mjs';

test('external task pipeline permits one mutation at a time and releases the lease after completion',async()=>{
  let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const first=withExternalTaskWriteLease('同步滴答待办',async()=>{
    await blocked;
    return 'done';
  });

  await assert.rejects(
    withExternalTaskWriteLease('沉淀每日总结',async()=>true),
    error=>error.statusCode===409&&error.code==='EXTERNAL_TASK_PIPELINE_BUSY'&&/同步滴答待办/.test(error.message)
  );

  release();
  assert.equal(await first,'done');
  assert.equal(await withExternalTaskWriteLease('更新集成设置',async()=>42),42);
});

test('external task pipeline releases the lease when a mutation fails',async()=>{
  await assert.rejects(
    withExternalTaskWriteLease('失败操作',async()=>{throw new Error('boom');}),
    /boom/
  );
  assert.equal(await withExternalTaskWriteLease('后续操作',async()=>true),true);
});
