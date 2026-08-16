import test from 'node:test';
import assert from 'node:assert/strict';
import {createGetnoteReader,createPrivateHttpGetnoteReader,getnoteRuntimeConfig} from '../src/getnote-runtime.mjs';
import {createGetnoteRuntimeServer} from '../src/getnote-runtime-server.mjs';
import {createTaskCliClient} from '../src/task-cli.mjs';
import {createGetnoteNoteClient} from '../src/getnote-note-client.mjs';

const TOKEN='runtime-service-token-0123456789abcdef';

function jsonResponse(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json'}});}

test('local_cli reader exposes only fixed read commands',async()=>{
  const calls=[];
  const exec=async(command,args)=>{
    calls.push([command,...args]);
    if(args[0]==='notes')return{stdout:JSON.stringify({success:true,data:{notes:[],has_more:false}})};
    if(args[0]==='note'&&args[1]==='todos')return{stdout:JSON.stringify({success:true,data:{note_id:args[2],meeting_todos:{items:[]}}})};
    if(args[0]==='note')return{stdout:JSON.stringify({success:true,data:{note_id:args[1],note_type:'TEXT',content:'原文'}})};
    throw new Error('unexpected');
  };
  const reader=createGetnoteReader({mode:'local_cli',exec,env:{}});
  await reader.listNotes({limit:20,cursor:'cursor-1'});
  await reader.fetchTodos('note-1');
  await reader.fetchNote('note-1');
  assert.deepEqual(calls,[
    ['getnote','notes','--limit','20','--cursor','cursor-1','-o','json'],
    ['getnote','note','todos','note-1','-o','json'],
    ['getnote','note','note-1','-o','json']
  ]);
  assert.deepEqual(reader.status(),{mode:'local_cli',transport:'execFile',readOnly:true});
});

test('local_cli forwards only GetNote/network runtime env and strips unrelated Workbench secrets',async()=>{
  let childEnv=null;
  const exec=async(command,args,options)=>{
    childEnv=options.env;
    return{stdout:JSON.stringify({success:true,data:{notes:[],has_more:false}})};
  };
  const reader=createGetnoteReader({
    mode:'local_cli',exec,
    env:{
      HOME:'/Users/test',PATH:'/opt/homebrew/bin:/usr/bin',LANG:'zh_CN.UTF-8',HTTPS_PROXY:'http://127.0.0.1:7897',
      GETNOTE_API_KEY:'getnote-secret',GETNOTE_CLIENT_ID:'getnote-client',
      AI_PROVIDER_API_KEY:'ai-secret',JOYCREW_TRUSTED_PROXY_TOKEN:'joycrew-secret',SESSION_SECRET:'session-secret',
      GETNOTE_RUNTIME_SERVICE_TOKEN:'sidecar-secret'
    }
  });
  await reader.listNotes({limit:20});
  assert.equal(childEnv.HOME,'/Users/test');
  assert.equal(childEnv.PATH,'/opt/homebrew/bin:/usr/bin');
  assert.equal(childEnv.HTTPS_PROXY,'http://127.0.0.1:7897');
  assert.equal(childEnv.GETNOTE_API_KEY,'getnote-secret');
  assert.equal(childEnv.GETNOTE_CLIENT_ID,'getnote-client');
  for(const key of ['AI_PROVIDER_API_KEY','JOYCREW_TRUSTED_PROXY_TOKEN','SESSION_SECRET','GETNOTE_RUNTIME_SERVICE_TOKEN']){
    assert.equal(Object.hasOwn(childEnv,key),false,`${key} must not be exposed to getnote CLI`);
  }
});

test('private_http reader uses fixed routes, bearer auth and rejects public origins',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/todos'))return jsonResponse({success:true,data:{note_id:'n1',meeting_todos:{items:[]}}});
    if(String(url).includes('/v1/notes/n1'))return jsonResponse({success:true,data:{note_id:'n1',note_type:'TEXT',content:'原文'}});
    return jsonResponse({success:true,data:{notes:[],has_more:false}});
  };
  const reader=createPrivateHttpGetnoteReader({baseUrl:'http://host.docker.internal:4310',token:TOKEN,fetchImpl});
  await reader.listNotes({limit:20});
  await reader.fetchTodos('n1');
  await reader.fetchNote('n1');
  assert.equal(calls.length,3);
  assert.match(calls[0].url,/\/v1\/notes\?limit=20$/);
  assert.match(calls[1].url,/\/v1\/notes\/n1\/todos$/);
  assert.match(calls[2].url,/\/v1\/notes\/n1$/);
  for(const call of calls){
    assert.equal(call.options.method,'GET');
    assert.equal(call.options.headers.Authorization,`Bearer ${TOKEN}`);
    assert.equal(call.options.redirect,'error');
  }
  assert.throws(()=>createPrivateHttpGetnoteReader({baseUrl:'https://example.com',token:TOKEN,fetchImpl}),/必须位于/);
  assert.throws(()=>createPrivateHttpGetnoteReader({baseUrl:'http://host.docker.internal:4310',token:'short',fetchImpl}),/至少需要 32/);
});

test('runtime config defaults local and private mode never exposes its token',()=>{
  assert.deepEqual(getnoteRuntimeConfig({}),{mode:'local_cli',readOnly:true});
  const config=getnoteRuntimeConfig({GETNOTE_RUNTIME_MODE:'private_http',GETNOTE_RUNTIME_BASE_URL:'http://getnote-runtime:4310',GETNOTE_RUNTIME_SERVICE_TOKEN:TOKEN});
  assert.equal(config.mode,'private_http');
  assert.equal(config.origin,'http://getnote-runtime:4310');
  assert.equal(Object.hasOwn(config,'serviceToken'),false);
});

test('read-only sidecar authenticates every data route and rejects mutations',async t=>{
  const reader={
    listNotes:async()=>({success:true,data:{notes:[{note_id:'n1'}],has_more:false}}),
    fetchTodos:async id=>({success:true,data:{note_id:id,meeting_todos:{items:[]}}}),
    fetchNote:async id=>({success:true,data:{note_id:id,note_type:'TEXT',content:'原文'}})
  };
  const server=createGetnoteRuntimeServer({reader,serviceToken:TOKEN});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  const base=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/health`)).status,200);
  assert.equal((await fetch(`${base}/v1/notes?limit=20`)).status,401);
  const auth={Authorization:`Bearer ${TOKEN}`};
  assert.equal((await fetch(`${base}/v1/notes?limit=20`,{headers:auth})).status,200);
  assert.equal((await fetch(`${base}/v1/notes/n1/todos`,{headers:auth})).status,200);
  assert.equal((await fetch(`${base}/v1/notes/n1`,{headers:auth})).status,200);
  assert.equal((await fetch(`${base}/v1/notes/n1`,{method:'POST',headers:auth})).status,405);
});

test('task sync and note insight share the same reader contract',async()=>{
  const reader={
    status:()=>({mode:'private_http',readOnly:true}),
    listNotes:async()=>({success:true,data:{notes:[{note_id:'n1',title:'会议',created_at:'2026-08-15T01:00:00Z'}],has_more:false}}),
    fetchTodos:async()=>({success:true,data:{note_id:'n1',title:'会议',meeting_todos:{items:[{text:'8月20日提交方案',completed:false}]}}}),
    fetchNote:async()=>({success:true,data:{note_id:'n1',title:'会议',note_type:'TEXT',content:'会议原文'}})
  };
  const tasks=await createTaskCliClient({reader}).fetch({noteLimit:20});
  const note=await createGetnoteNoteClient({reader}).fetch('n1');
  assert.equal(tasks.runtimeMode,'private_http');
  assert.equal(tasks.active[0].sourceNoteId,'n1');
  assert.equal(note.content,'会议原文');
});
