import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { syncFeishuInbox } from '../src/inbox-domain.mjs';
import { inboxContentHash } from '../src/inbox-ack.mjs';
import { createFeishuJournalClient, parseFeishuDiaryXml, parseFeishuTodoXml } from '../src/feishu.mjs';

function mixedXml(){
  return [
    '<title id="doc">我的工作日记</title>',
    '<h1 id="d1">2026-08-16</h1>',
    '<p id="a1">上午复盘：最近工作台的信息层级需要继续优化。</p>',
    '<checkbox id="t1">联系客户确认明天方案</checkbox>',
    '<checkbox id="done1" checked="true">已经完成的旧待办</checkbox>',
    '<h2 id="h2">项目思考</h2>',
    '<p id="p1">项目 A 当前卡在飞书同步规则，需要调整。</p>',
    '<p id="i1">[INBOX] 这一条在普通日记里，不应被待办同步读取</p>',
    '<h1 id="wb">Workbench 收件箱</h1>',
    '<p id="wb1">[INBOX] 周一前完成报价表</p>'
  ].join('');
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-feishu-todo-only-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  const config=await store.readConfig();
  await store.writeConfig({
    ...config,
    dataSource:{
      provider:'feishu_doc',
      documentUrl:'https://example.feishu.cn/wiki/test',
      inboxHeading:'收件箱',
      inboxPrefix:'[INBOX]',
      lastRevisionId:null,
      lastSyncAt:null,
      lastSyncStatus:'ok',
      lastSyncError:null,
      lastImportedCount:0
    }
  });
  return store;
}

test('legacy mixed diary parser may remain for compatibility but todo parser ignores ordinary diary content',()=>{
  const legacy=parseFeishuDiaryXml(mixedXml());
  assert.ok(legacy.items.some(item=>item.blockId==='a1'));
  assert.ok(legacy.items.some(item=>item.blockId==='p1'));

  const parsed=parseFeishuTodoXml(mixedXml(),{heading:'收件箱',prefix:'[INBOX]'});
  assert.equal(parsed.mode,'todo_only');
  assert.deepEqual(parsed.items.map(item=>item.blockId).sort(),['t1','wb1']);
  assert.ok(parsed.items.every(item=>item.explicitTodo===true));
  assert.equal(parsed.items.some(item=>item.blockId==='a1'),false,'ordinary diary paragraph must never enter todo sync');
  assert.equal(parsed.items.some(item=>item.blockId==='p1'),false,'project progress paragraph must never enter todo sync');
  assert.equal(parsed.items.some(item=>item.blockId==='i1'),false,'[INBOX] outside an explicit inbox section is not enough');
  assert.equal(parsed.items.some(item=>item.blockId==='done1'),false,'completed native todo must not import as a new todo');
});

test('journal client always returns todo_only instead of falling back to the whole diary',async()=>{
  const fakeExec=async (_command,args)=>{
    assert.ok(args.includes('+fetch'));
    return{stdout:JSON.stringify({data:{document:{content:mixedXml(),revision_id:9,document_id:'doc'}}})};
  };
  const client=createFeishuJournalClient({exec:fakeExec});
  const result=await client.fetch({documentUrl:'https://example.feishu.cn/wiki/test',inboxHeading:'收件箱',inboxPrefix:'[INBOX]'});
  assert.equal(result.mode,'todo_only');
  assert.deepEqual(result.items.map(item=>item.blockId).sort(),['t1','wb1']);
});

test('todo sync imports only explicit todos and never queues ordinary diary blocks',async t=>{
  const store=await fixture(t);
  const client={fetch:async()=>({
    mode:'todo_only',sectionFound:true,revisionId:1,
    items:[
      {blockId:'t1',text:'联系客户确认明天方案',tag:'checkbox',explicitTodo:true,todoKind:'native_todo',headingPath:['2026-08-16']},
      {blockId:'wb1',text:'周一前完成报价表',tag:'p',explicitTodo:true,explicitInbox:true,todoKind:'inbox_marker',headingPath:['Workbench 收件箱']}
    ]
  })};
  const result=await syncFeishuInbox({store,client});
  assert.equal(result.mode,'todo_only');
  assert.equal(result.imported,2);
  const state=await store.readState();
  assert.deepEqual(state.inbox.map(item=>item.source),['feishu_todo','feishu_todo']);
  assert.deepEqual(new Set(state.inbox.map(item=>item.feishuBlockId)),new Set(['t1','wb1']));
  assert.ok(state.inbox.every(item=>item.feishuExplicitTodo===true));
});

test('first todo-only sync removes legacy diary queue and reimports only legacy blocks that are actually explicit todos',async t=>{
  const store=await fixture(t);
  await store.updateState(state=>{
    state.inbox.push(
      {id:'legacy-p',text:'普通复盘',source:'feishu_doc',feishuBlockId:'a1',feishuMode:'mixed_diary',createdAt:'2026-08-16T01:00:00.000Z'},
      {id:'legacy-checkbox',text:'联系客户确认明天方案',source:'feishu_doc',feishuBlockId:'t1',feishuMode:'mixed_diary',feishuTag:'checkbox',createdAt:'2026-08-16T01:01:00.000Z'},
      {id:'legacy-extracted',text:'AI 从普通日记猜出的动作',source:'feishu_todo_candidate',feishuSourceBlockId:'p1',createdAt:'2026-08-16T01:02:00.000Z'}
    );
    state.confirmations.push({id:'c1',type:'inbox',text:'旧确认',inboxId:'legacy-p',createdAt:'2026-08-16T01:03:00.000Z'});
    state.inboxAcks.push(
      {blockId:'a1',contentHash:inboxContentHash('普通复盘'),acknowledgedAt:'2026-08-16T01:00:00.000Z'},
      {blockId:'t1',contentHash:inboxContentHash('联系客户确认明天方案'),acknowledgedAt:'2026-08-16T01:01:00.000Z'},
      {blockId:'p1',contentHash:inboxContentHash('AI 从普通日记猜出的动作'),acknowledgedAt:'2026-08-16T01:02:00.000Z'}
    );
  });
  const client={fetch:async()=>({
    mode:'todo_only',sectionFound:false,revisionId:2,
    items:[{blockId:'t1',text:'联系客户确认明天方案',tag:'checkbox',explicitTodo:true,todoKind:'native_todo',headingPath:['2026-08-16']}]
  })};
  const result=await syncFeishuInbox({store,client});
  assert.equal(result.cleanedLegacy,3);
  assert.equal(result.imported,1);
  const state=await store.readState();
  assert.deepEqual(state.inbox.map(item=>item.feishuBlockId),['t1']);
  assert.equal(state.inbox[0].source,'feishu_todo');
  assert.equal(state.confirmations.some(item=>item.inboxId==='legacy-p'),false);
  assert.ok(state.inboxAcks.some(item=>item.blockId==='a1'),'ordinary diary ACK remains so old history cannot re-enter');
  assert.ok(state.inboxAcks.some(item=>item.blockId==='p1'),'old non-todo source ACK remains');
  assert.ok(state.inboxAcks.some(item=>item.blockId==='t1'),'explicit todo source gets a fresh ACK after reimport');
});

test('Workbench capture remains an explicit [INBOX] todo in Workbench 收件箱',async()=>{
  let content='<title id="doc">我的工作日记</title><h1 id="d1">2026-08-16</h1><p id="a1">普通日记</p>';
  let revision=1;
  const fakeExec=async (_command,args)=>{
    if(args.includes('+fetch'))return{stdout:JSON.stringify({data:{document:{content,revision_id:revision,document_id:'doc'}}})};
    const payload=args[args.indexOf('--content')+1];
    if(payload.includes('Workbench 收件箱'))content+='<h1 id="wb">Workbench 收件箱</h1>';
    else if(payload.includes('[INBOX] 新事项'))content+='<p id="new">[INBOX] 新事项</p>';
    else throw new Error(`unexpected update payload: ${payload}`);
    revision+=1;
    return{stdout:JSON.stringify({ok:true})};
  };
  const client=createFeishuJournalClient({exec:fakeExec});
  const result=await client.appendAndFetch({documentUrl:'https://example.feishu.cn/wiki/test',inboxHeading:'收件箱',inboxPrefix:'[INBOX]'},'新事项');
  assert.equal(result.mode,'todo_only');
  assert.equal(result.item.text,'新事项');
  assert.equal(result.item.explicitTodo,true);
  assert.match(content,/Workbench 收件箱/);
  assert.match(content,/\[INBOX\] 新事项/);
});
