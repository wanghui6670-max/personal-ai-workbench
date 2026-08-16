import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { syncFeishuInbox } from '../src/inbox-domain.mjs';
import { createFeishuJournalClient, parseFeishuDiaryXml } from '../src/feishu.mjs';

function mixedXml(){
  return [
    '<title id="doc">我的工作日记</title>',
    '<h1 id="d1">2026-08-16</h1>',
    '<p id="a1">上午复盘：最近工作台的信息层级需要继续优化。</p>',
    '<checkbox id="t1">联系客户确认明天方案</checkbox>',
    '<h2 id="h2">项目思考</h2>',
    '<p id="p1">项目 A 当前卡在飞书同步规则，需要调整。</p>',
    '<p id="i1">[INBOX] 周一前完成报价表</p>'
  ].join('');
}

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-feishu-mixed-'));
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
      lastSyncStatus:'error',
      lastSyncError:'旧格式错误',
      lastImportedCount:0
    }
  });
  return store;
}

test('mixed diary parser keeps heading context and does not require 收件箱 section',()=>{
  const parsed=parseFeishuDiaryXml(mixedXml());
  assert.equal(parsed.mode,'mixed_diary');
  assert.equal(parsed.sectionFound,false);
  assert.deepEqual(parsed.items.map(item=>item.blockId),['a1','t1','p1','i1']);
  assert.deepEqual(parsed.items[0].headingPath,['2026-08-16']);
  assert.deepEqual(parsed.items[2].headingPath,['2026-08-16','项目思考']);
  assert.equal(parsed.items[3].text,'周一前完成报价表');
  assert.equal(parsed.items[3].explicitInbox,true);
});

test('journal client falls back to mixed diary instead of returning format 502',async()=>{
  const fakeExec=async (_command,args)=>{
    assert.ok(args.includes('+fetch'));
    return{stdout:JSON.stringify({data:{document:{content:mixedXml(),revision_id:9,document_id:'doc'}}})};
  };
  const client=createFeishuJournalClient({exec:fakeExec});
  const result=await client.fetch({documentUrl:'https://example.feishu.cn/wiki/test',inboxHeading:'收件箱',inboxPrefix:'[INBOX]'});
  assert.equal(result.mode,'mixed_diary');
  assert.equal(result.items.length,4);
});

test('first mixed sync baselines middle history and later ignores edits to every already-seen block',async t=>{
  const store=await fixture(t);
  let revision=1;
  let items=Array.from({length:70},(_,index)=>({
    blockId:`b${index}`,
    text:`日记内容 ${index}`,
    rawText:`日记内容 ${index}`,
    tag:'p',
    headingPath:['2026-08-16'],
    explicitInbox:false,
    order:index
  }));
  const client={fetch:async()=>({mode:'mixed_diary',sectionFound:false,revisionId:revision,items})};
  const first=await syncFeishuInbox({store,client});
  assert.equal(first.imported,60);
  assert.equal(first.baselined,10);
  assert.equal(first.firstMixedSync,true);
  let state=await store.readState();
  assert.equal(state.inbox.length,60);
  assert.equal(state.inboxAcks.length,70);
  assert.equal(state.inbox.some(item=>item.feishuBlockId==='b35'),false);

  revision=2;
  items=items.map(item=>item.blockId==='b35'?{...item,text:'日记内容 35 已修改'}:item);
  const second=await syncFeishuInbox({store,client});
  assert.equal(second.firstMixedSync,false);
  assert.equal(second.imported,0);
  assert.equal(second.updated,0);
  state=await store.readState();
  assert.equal(state.inbox.some(item=>item.feishuBlockId==='b35'),false);
});

test('after an initial sync only a newly appended block enters the next Workbench sync',async t=>{
  const store=await fixture(t);
  let revision=1;
  let items=[
    {blockId:'old-1',text:'旧记录一',tag:'p',headingPath:['今天'],explicitInbox:false,order:0},
    {blockId:'old-2',text:'旧记录二',tag:'p',headingPath:['今天'],explicitInbox:false,order:1}
  ];
  const client={fetch:async()=>({mode:'mixed_diary',sectionFound:false,revisionId:revision,items})};
  const first=await syncFeishuInbox({store,client});
  assert.equal(first.imported,2);
  await store.updateState(state=>{state.inbox=[];});

  revision=2;
  items=[
    {...items[0],text:'旧记录一被编辑'},
    items[1],
    {blockId:'new-3',text:'这才是新增加的记录',tag:'checkbox',headingPath:['今天'],explicitInbox:false,order:2}
  ];
  const second=await syncFeishuInbox({store,client});
  assert.equal(second.imported,1);
  assert.equal(second.updated,0);
  const state=await store.readState();
  assert.deepEqual(state.inbox.map(item=>item.feishuBlockId),['new-3']);
});

test('mixed diary capture auto-creates a Workbench 收件箱 section for writes',async()=>{
  let content='<title id="doc">我的工作日记</title><h1 id="d1">2026-08-16</h1><p id="a1">普通日记</p>';
  let revision=1;
  const fakeExec=async (_command,args)=>{
    if(args.includes('+fetch')){
      return{stdout:JSON.stringify({data:{document:{content,revision_id:revision,document_id:'doc'}}})};
    }
    const payload=args[args.indexOf('--content')+1];
    if(payload.includes('Workbench 收件箱')){
      content+='<h1 id="wb">Workbench 收件箱</h1>';
    }else if(payload.includes('[INBOX] 新事项')){
      content+='<p id="new">[INBOX] 新事项</p>';
    }else throw new Error(`unexpected update payload: ${payload}`);
    revision+=1;
    return{stdout:JSON.stringify({ok:true})};
  };
  const client=createFeishuJournalClient({exec:fakeExec});
  const result=await client.appendAndFetch({documentUrl:'https://example.feishu.cn/wiki/test',inboxHeading:'收件箱',inboxPrefix:'[INBOX]'},'新事项');
  assert.equal(result.mode,'mixed_diary');
  assert.equal(result.item.text,'新事项');
  assert.match(content,/Workbench 收件箱/);
  assert.match(content,/\[INBOX\] 新事项/);
});
