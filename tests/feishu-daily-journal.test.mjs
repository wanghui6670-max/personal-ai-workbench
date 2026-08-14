import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuDailyJournalClient, parseFeishuDailyJournalXml } from '../src/feishu-daily-journal.mjs';

const xml='<title id="t1">日记</title><h1 id="h1">每日工作日记</h1><p id="p1">[WORKBENCH_DAILY_TODOS] [WORKBENCH_OP:tasks-2026-08-14-abc] 日期：2026-08-14</p><p id="p2">普通文字</p>';

function fakeExec(calls){
  return async(command,args)=>{
    calls.push([command,...args]);
    return{stdout:JSON.stringify({data:{document:{content:xml,revision_id:'r1',document_id:'d1'}}})};
  };
}

test('Feishu daily journal parser isolates fixed Workbench record types and block IDs',()=>{
  const parsed=parseFeishuDailyJournalXml(xml);
  assert.equal(parsed.sectionFound,true);
  assert.equal(parsed.headingBlockId,'h1');
  assert.equal(parsed.items.length,1);
  assert.equal(parsed.items[0].blockId,'p1');
  assert.equal(parsed.items[0].kind,'tasks');
  assert.equal(parsed.items[0].operationId,'tasks-2026-08-14-abc');
  assert.equal(parsed.items[0].text,'日期：2026-08-14');
});

test('Feishu daily journal append is idempotent by operationId before issuing a write',async()=>{
  const calls=[];
  const client=createFeishuDailyJournalClient({exec:fakeExec(calls)});
  const result=await client.appendTasks('https://example.feishu.cn/wiki/abc','日期：2026-08-14',{operationId:'tasks-2026-08-14-abc'});
  assert.equal(result.replayed,true);
  assert.equal(result.item.blockId,'p1');
  assert.equal(calls.length,1);
  assert.equal(calls[0][1],'docs');
  assert.equal(calls[0][2],'+fetch');
});

test('same operationId with different text fails closed instead of accepting a false replay',async()=>{
  const calls=[];
  const client=createFeishuDailyJournalClient({exec:fakeExec(calls)});
  await assert.rejects(
    client.appendTasks('https://example.feishu.cn/wiki/abc','日期：2026-08-14\n不同正文',{operationId:'tasks-2026-08-14-abc'}),
    error=>error.code==='FEISHU_DAILY_JOURNAL_OPERATION_CONFLICT'&&error.statusCode===409
  );
  assert.equal(calls.length,1);
});
