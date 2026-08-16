import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuDailyJournalClient, parseFeishuDailyJournalXml } from '../src/feishu-daily-journal.mjs';

const xml='<title id="t1">日记</title><h1 id="h1">每日工作日记</h1><p id="p1">[WORKBENCH_DAILY_TODOS] [WORKBENCH_OP:tasks-2026-08-14-abc] 日期：2026-08-14</p><p id="p2">普通文字</p>';

function documentResult(content){
  return{stdout:JSON.stringify({data:{document:{content,revision_id:'r1',document_id:'d1'}}})};
}
function fakeExec(calls){
  return async(command,args)=>{
    calls.push([command,...args]);
    return documentResult(xml);
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

test('same operationId accepts a Feishu readback that flattened paragraph line breaks',async()=>{
  const calls=[];
  const flattened='<title id="t1">日记</title><h1 id="h1">每日工作日记</h1><p id="p1">[WORKBENCH_DAILY_TODOS] [WORKBENCH_OP:tasks-2026-08-15-flat] 日期：2026-08-15来源：得到大脑 CLI（getnote）扫描最近笔记：91；解析待办：0</p>';
  const exec=async(command,args)=>{calls.push([command,...args]);return documentResult(flattened);};
  const client=createFeishuDailyJournalClient({exec});
  const result=await client.appendTasks(
    'https://example.feishu.cn/wiki/abc',
    '日期：2026-08-15\n来源：得到大脑 CLI（getnote）\n扫描最近笔记：91；解析待办：0',
    {operationId:'tasks-2026-08-15-flat'}
  );
  assert.equal(result.replayed,true);
  assert.equal(result.item.blockId,'p1');
  assert.equal(calls.length,1);
});

test('new journal write accepts flattened line breaks on immediate readback',async()=>{
  const calls=[];
  const empty='<title id="t1">日记</title><h1 id="h1">每日工作日记</h1>';
  const flattened='<title id="t1">日记</title><h1 id="h1">每日工作日记</h1><p id="p9">[WORKBENCH_DAILY_TODOS] [WORKBENCH_OP:tasks-2026-08-15-new] 日期：2026-08-15来源：得到大脑 CLI（getnote）</p>';
  const exec=async(command,args)=>{
    calls.push([command,...args]);
    if(calls.length===1)return documentResult(empty);
    if(calls.length===2)return{stdout:'{}'};
    return documentResult(flattened);
  };
  const client=createFeishuDailyJournalClient({exec});
  const result=await client.appendTasks(
    'https://example.feishu.cn/wiki/abc',
    '日期：2026-08-15\n来源：得到大脑 CLI（getnote）',
    {operationId:'tasks-2026-08-15-new'}
  );
  assert.equal(result.replayed,false);
  assert.equal(result.item.blockId,'p9');
  assert.equal(calls.length,3);
  assert.equal(calls[1].includes('block_insert_after'),true);
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
