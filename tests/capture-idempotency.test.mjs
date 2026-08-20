import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';
import { captureInbox } from '../src/capture-domain.mjs';
import { createFeishuCaptureClient } from '../src/feishu-capture.mjs';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-capture-idempotency-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));
  await store.ensure();
  return{root,store};
}

test('same captureId replays one local inbox item and a different body fails closed',async t=>{
  const {store}=await fixture(t);
  const first=await captureInbox({store,captureId:'capture-00000001',text:'同一条手机采集'});
  const replay=await captureInbox({store,captureId:'capture-00000001',text:'同一条手机采集'});
  assert.equal(first.replayed,false);
  assert.equal(replay.replayed,true);
  assert.equal(replay.captureId,'capture-00000001');
  const state=await store.readState();
  assert.equal(state.inbox.length,1);
  assert.equal(state.inbox[0].captureId,'capture-00000001');
  await assert.rejects(
    captureInbox({store,captureId:'capture-00000001',text:'不同内容'}),
    error=>error.code==='CAPTURE_ID_CONFLICT'&&error.statusCode===409
  );
});

test('processed capture replay does not recreate the inbox item',async t=>{
  const {store}=await fixture(t);
  const captured=await captureInbox({store,captureId:'capture-processed-01',text:'处理后不复活'});
  await store.updateState(state=>{state.inbox=state.inbox.filter(item=>item.id!==captured.item.id);});
  const replay=await captureInbox({store,captureId:'capture-processed-01',text:'处理后不复活'});
  assert.equal(replay.replayed,true);
  assert.equal(replay.processed,true);
  assert.equal(replay.item,null);
  assert.equal((await store.readState()).inbox.length,0);
});

test('capture receipt stores only a content hash and identifiers',async t=>{
  const {root,store}=await fixture(t);
  await captureInbox({store,captureId:'capture-private-01',text:'不应写进收据的敏感正文'});
  const files=await fsp.readdir(path.join(root,'data','captures'));
  assert.equal(files.length,1);
  const raw=await fsp.readFile(path.join(root,'data','captures',files[0]),'utf8');
  assert.doesNotMatch(raw,/不应写进收据的敏感正文/);
  const receipt=JSON.parse(raw);
  assert.match(receipt.contentHash,/^[a-f0-9]{64}$/);
  assert.equal(receipt.captureId,'capture-private-01');
});

test('concurrent retries of one captureId create at most one inbox item',async t=>{
  const {store}=await fixture(t);
  const results=await Promise.all(Array.from({length:8},()=>captureInbox({
    store,
    captureId:'capture-concurrent-01',
    text:'并发采集只允许一条'
  })));
  assert.equal(results.filter(result=>result.replayed===false).length,1);
  assert.equal((await store.readState()).inbox.filter(item=>item.captureId==='capture-concurrent-01').length,1);
});

test('Feishu capture adapter writes a marker once and replays the same remote block',async()=>{
  let document='<title id="doc">日记</title><h1 id="inbox">收件箱</h1><h1 id="journal">日记</h1>';
  let writes=0;
  const fakeExec=async(_command,args)=>{
    if(args.includes('+fetch')){
      return{stdout:JSON.stringify({data:{document:{content:document,revision_id:String(writes+1),document_id:'doc'}}})};
    }
    writes+=1;
    const content=args[args.indexOf('--content')+1];
    const block=`<p id="cap_${writes}">${content.replace(/^<p>|<\/p>$/g,'')}</p>`;
    document=document.replace('<h1 id="journal">日记</h1>',`${block}<h1 id="journal">日记</h1>`);
    return{stdout:JSON.stringify({ok:true})};
  };
  const client=createFeishuCaptureClient({exec:fakeExec});
  const config={documentUrl:'https://example.feishu.cn/wiki/inbox',inboxHeading:'收件箱',inboxPrefix:'[INBOX]'};
  const first=await client.appendAndFetch(config,'飞书幂等采集',{captureId:'capture-feishu-01'});
  const replay=await client.appendAndFetch(config,'飞书幂等采集',{captureId:'capture-feishu-01'});
  assert.equal(first.replayed,false);
  assert.equal(replay.replayed,true);
  assert.equal(first.item.blockId,replay.item.blockId);
  assert.equal(writes,1);
  await assert.rejects(
    client.appendAndFetch(config,'不同正文',{captureId:'capture-feishu-01'}),
    error=>error.code==='CAPTURE_ID_CONFLICT'
  );
});

test('Feishu capture passes only the reviewed lark-cli environment',async()=>{
  const calls=[];
  const fakeExec=async(_command,_args,options)=>{
    calls.push(options);
    return{stdout:JSON.stringify({data:{document:{
      content:'<title id="doc">日记</title><h1 id="inbox">收件箱</h1>',
      revision_id:'1',
      document_id:'doc'
    }}})};
  };
  const client=createFeishuCaptureClient({
    exec:fakeExec,
    processEnv:{
      HOME:'/tmp/home',
      PATH:'/bin',
      LARK_APP_ID:'allowed',
      UNRELATED_SECRET:'blocked'
    }
  });
  await client.fetch({documentUrl:'https://example.feishu.cn/wiki/inbox'});
  assert.equal(calls[0].env.HOME,'/tmp/home');
  assert.equal(calls[0].env.LARK_APP_ID,'allowed');
  assert.equal(calls[0].env.UNRELATED_SECRET,undefined);
});

test('server capture route uses captureInbox and does not trust body.source as the persisted source',async()=>{
  const server=await fsp.readFile(path.resolve('src/server.mjs'),'utf8');
  assert.match(server,/captureInbox\(\{store,captureId:body\.captureId\?\?null,text:body\.text\}\)/);
  assert.doesNotMatch(server,/addInbox\(\{store,text:body\.text,source:body\.source/);
});
