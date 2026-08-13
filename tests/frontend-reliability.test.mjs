import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const appSource=await fsp.readFile(new URL('../public/app.js',import.meta.url),'utf8');

function response(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data};}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=async(times=5)=>{for(let i=0;i<times;i+=1)await new Promise(resolve=>setImmediate(resolve));};
function baseState(overrides={}){return {
  config:{workspaceRoot:'./workspace',workspaceRootResolved:'/tmp/workspace'},aiEnabled:false,businesses:[],inbox:[],todos:[],todayPlan:[],todayTodos:[],projects:[],confirmations:[],notes:[],activities:[],morningSession:null,overdue:[],unclassified:[],stats:{inbox:0,today:0,confirmations:0,overdue:0,unclassified:0,activeProjects:0},...overrides
};}

async function loadFrontend(fetchImpl){
  const listeners={},controls={
    '#project-desc':{value:'可靠性项目'},
    '#project-end':{value:'2026-09-01'},
    '#project-source-inbox':{value:''}
  };
  let appHtml='',renderCount=0;
  const app={get innerHTML(){return appHtml;},set innerHTML(value){appHtml=value;renderCount+=1;const match=value.match(/id="project-source-inbox"[^>]*value="([^"]*)"/);if(match)controls['#project-source-inbox'].value=match[1];}};
  const toast={textContent:'',className:'toast'};
  const document={
    querySelector(selector){if(selector==='#app')return app;if(selector==='#toast')return toast;return controls[selector]||null;},
    addEventListener(type,handler){listeners[type]=handler;}
  };
  const location={hash:'#today'};
  const context={document,window:{addEventListener(){}},location,CSS:{escape:value=>value},fetch:fetchImpl,requestAnimationFrame:callback=>callback(),setTimeout:()=>1,clearTimeout(){},console,confirm:()=>true};
  vm.runInNewContext(appSource,context,{filename:'public/app.js'});
  await flush();
  return {app,toast,location,listeners,controls,get renderCount(){return renderCount;}};
}

function action(name){const element={dataset:{action:name},disabled:false,innerHTML:'',classList:{contains:()=>false}};element.closest=()=>element;return element;}
function click(ui,target){ui.listeners.click({target,preventDefault(){}});}

test('modal uses CSP-safe delegation and only its overlay closes it',async()=>{
  let stateReads=0;
  const ui=await loadFrontend(async url=>{
    if(url==='/api/auth/status')return response({authEnabled:false,authenticated:true});
    if(url==='/api/state'){stateReads+=1;return response(baseState());}
    throw new Error(`unexpected request: ${url}`);
  });
  assert.equal(stateReads,1);
  assert.doesNotMatch(appSource,/\sonclick\s*=/i);

  click(ui,action('settings'));
  assert.match(ui.app.innerHTML,/class="overlay" data-action="close-modal"/);
  const before=ui.renderCount;
  const overlay={dataset:{action:'close-modal'},classList:{contains:name=>name==='overlay'}};
  const modalChild={closest:()=>overlay};
  click(ui,modalChild);
  assert.equal(ui.renderCount,before,'clicks inside the modal must not close or redraw it');
  assert.match(ui.app.innerHTML,/工作台设置/);

  overlay.closest=()=>overlay;
  click(ui,overlay);
  assert.doesNotMatch(ui.app.innerHTML,/工作台设置/);
});

test('settings shows the actual Luna xhigh configuration without claiming live verification',async()=>{
  const ui=await loadFrontend(async url=>{
    if(url==='/api/auth/status')return response({authEnabled:false,authenticated:true});
    if(url==='/api/state')return response(baseState({
      aiEnabled:true,
      aiConfig:{provider:'openai',model:'gpt-5.6-luna',reasoningEffort:'xhigh'}
    }));
    throw new Error(`unexpected request: ${url}`);
  });

  click(ui,action('settings'));
  assert.match(ui.app.innerHTML,/AI 判断已配置：gpt-5\.6-luna · 极高（xhigh）/);
  assert.match(ui.app.innerHTML,/尚未联网验证/);
  assert.doesNotMatch(ui.app.innerHTML,/联网验证通过|模型已可达|调用已成功/);
});

test('batch sync reports successful and stale counts separately',async()=>{
  let stateReads=0;
  const ui=await loadFrontend(async url=>{
    if(url==='/api/auth/status')return response({authEnabled:false,authenticated:true});
    if(url==='/api/state'){stateReads+=1;return response(baseState());}
    if(url==='/api/projects/sync')return response({results:[
      {id:'p_ok',ok:true,progress:{percent:40}},
      {id:'p_stale',ok:false,stale:true,code:'PROJECT_SYNC_STALE'}
    ]});
    throw new Error(`unexpected request: ${url}`);
  });

  click(ui,action('sync-all'));
  await flush();

  assert.equal(stateReads,2);
  assert.match(ui.toast.textContent,/成功 1，过期跳过 1/);
  assert.match(ui.toast.textContent,/请按最新状态重新同步/);
  assert.doesNotMatch(ui.toast.textContent,/同步完成：1\/2/);
});

test('state-derived IDs and progress cannot escape route, attribute, or style contexts',async()=>{
  const maliciousId='p_\" data-action=\"delete-business';
  const maliciousPercent='0\" data-action=\"delete-business';
  const project={
    id:maliciousId,name:'恶意恢复项目',businessId:'biz_safe',endDate:'2026-09-01',archived:false,
    progress:{percent:maliciousPercent,summary:'恢复显示'}
  };
  const business={id:'biz_\" autofocus onfocus=\"alert',name:'危险板块',folder:'01_危险'};
  const ui=await loadFrontend(async url=>{
    if(url==='/api/auth/status')return response({authEnabled:false,authenticated:true});
    if(url==='/api/state')return response(baseState({
      businesses:[business,{id:'biz_safe',name:'安全板块',folder:'02_安全'}],
      projects:[project],
      stats:{inbox:0,today:0,confirmations:0,overdue:0,unclassified:0,activeProjects:1}
    }));
    throw new Error(`unexpected request: ${url}`);
  });

  assert.match(ui.app.innerHTML,/style="--p:0"><span>0%<\/span>/);
  assert.match(ui.app.innerHTML,/href="#project\/p_%22%20data-action%3D%22delete-business"/);
  assert.match(ui.app.innerHTML,/href="#business\/biz_%22%20autofocus%20onfocus%3D%22alert"/);
  assert.doesNotMatch(ui.app.innerHTML,/style="--p:0" data-action=/);
  assert.doesNotMatch(ui.app.innerHTML,/href="#[^"]*" data-action="delete-business/);

  click(ui,action('settings'));
  assert.match(ui.app.innerHTML,/data-id="biz_&quot; autofocus onfocus=&quot;alert"/);
  assert.doesNotMatch(ui.app.innerHTML,/data-id="biz_" autofocus/);
});

test('project creation locks double clicks, renders its inbox source immediately, and verifies uncertain success by state readback',async()=>{
  const capture=deferred(),projectRequest=deferred();let inboxCalls=0,projectCalls=0,stateReads=0;
  const project={id:'p_verified',name:'可靠性项目',businessId:'biz_client',sourceInboxId:'in_persisted',endDate:'2026-09-01'};
  const ui=await loadFrontend(async(url,options={})=>{
    if(url==='/api/auth/status')return response({authEnabled:false,authenticated:true});
    if(url==='/api/state'){stateReads+=1;return response(stateReads===1?baseState():baseState({projects:[project]}));}
    if(url==='/api/inbox'){inboxCalls+=1;return capture.promise;}
    if(url==='/api/projects'){projectCalls+=1;return projectRequest.promise;}
    throw new Error(`unexpected request: ${url} ${options.method||'GET'}`);
  });

  const create=action('create-project');
  click(ui,create);
  click(ui,action('create-project'));
  assert.equal(inboxCalls,1,'the synchronous submit lock must block a second capture');
  assert.equal(projectCalls,0);

  capture.resolve(response({item:{id:'in_persisted'}} ,201));
  await flush();
  assert.equal(projectCalls,1);
  assert.match(ui.app.innerHTML,/收件箱来源：in_persisted/);
  assert.match(ui.app.innerHTML,/正在继续创建项目/);
  assert.match(ui.app.innerHTML,/创建中/);

  projectRequest.reject(new Error('response connection lost'));
  await flush();
  assert.equal(stateReads,2,'an uncertain project response must be followed by a state readback');
  assert.equal(ui.location.hash,'#project/p_verified');
  assert.match(ui.toast.textContent,/当前状态确认项目和本地目录已创建/);
  assert.equal(inboxCalls,1);
  assert.equal(projectCalls,1);
});

test('failed project creation keeps a retryable inbox source and never captures it twice',async()=>{
  let inboxCalls=0,projectCalls=0,stateReads=0;
  const inboxItem={id:'in_retry',text:'可靠性项目'};
  const project={id:'p_retry',name:'可靠性项目',businessId:null,sourceInboxId:'in_retry',endDate:'2026-09-01'};
  const ui=await loadFrontend(async url=>{
    if(url==='/api/auth/status')return response({authEnabled:false,authenticated:true});
    if(url==='/api/state'){
      stateReads+=1;
      if(stateReads===1)return response(baseState());
      if(stateReads===2)return response(baseState({inbox:[inboxItem]}));
      return response(baseState({projects:[project],unclassified:[project]}));
    }
    if(url==='/api/inbox'){inboxCalls+=1;return response({item:inboxItem},201);}
    if(url==='/api/projects'){projectCalls+=1;if(projectCalls===1)throw new Error('temporary network failure');return response({project,unclassified:true},201);}
    throw new Error(`unexpected request: ${url}`);
  });

  click(ui,action('create-project'));
  await flush(8);
  assert.equal(inboxCalls,1);
  assert.equal(projectCalls,1);
  assert.match(ui.app.innerHTML,/项目尚未创建，来源仍安全保留在收件箱/);
  assert.match(ui.app.innerHTML,/收件箱来源：in_retry/);
  assert.equal(ui.controls['#project-source-inbox'].value,'in_retry');

  click(ui,action('create-project'));
  await flush(8);
  assert.equal(inboxCalls,1,'retry must reuse sourceInboxId instead of creating another inbox item');
  assert.equal(projectCalls,2);
  assert.equal(stateReads,3);
  assert.equal(ui.location.hash,'#unclassified');
  assert.match(ui.toast.textContent,/项目已建立，暂放待归类/);
});

test('missing project and inbox after a failed second phase is reported as an anomalous source',async()=>{
  let stateReads=0,inboxCalls=0;
  const ui=await loadFrontend(async url=>{
    if(url==='/api/auth/status')return response({authEnabled:false,authenticated:true});
    if(url==='/api/state'){stateReads+=1;return response(baseState());}
    if(url==='/api/inbox'){inboxCalls+=1;throw new Error('must not recapture an existing source');}
    if(url==='/api/projects')throw new Error('project request failed');
    throw new Error(`unexpected request: ${url}`);
  });
  ui.controls['#project-source-inbox'].value='in_missing';
  click(ui,action('create-project'));
  await flush(8);
  assert.equal(inboxCalls,0);
  assert.equal(stateReads,2);
  assert.match(ui.app.innerHTML,/来源状态异常：项目和收件箱都没有找到这个来源/);
  assert.match(ui.app.innerHTML,/收件箱来源：in_missing/);
  assert.match(ui.toast.textContent,/来源状态异常/);
});
