(()=>{
  const nativeFetch=window.fetch.bind(window);
  const IDLE_SOURCE='feishu_doc_idle';
  const INIT_ANALYZE_ONCE='workbench-feishu-initialize-analyze-once';
  let syncPermit=false;
  let classificationRun=false;
  const manualAnalyzeIds=new Set();
  let enhanceScheduled=false;
  let statePromise=null;

  // A normal page reload must never resume an old automatic diary-classification run.
  // The only exception is the single reload immediately following an explicit
  // one-time initialization import.
  try{
    classificationRun=sessionStorage.getItem(INIT_ANALYZE_ONCE)==='1';
    sessionStorage.removeItem(INIT_ANALYZE_ONCE);
    sessionStorage.removeItem('workbench-v3-inbox-reviews-v1');
  }catch{}
  window.__WORKBENCH_FEISHU_CLASSIFY_RUN__=classificationRun;

  function requestUrl(input){
    try{return new URL(typeof input==='string'?input:input?.url||'',location.origin);}catch{return null;}
  }
  function requestBody(init){
    if(typeof init?.body!=='string')return null;
    try{return JSON.parse(init.body);}catch{return null;}
  }
  function calledFromWorkbenchV3(){return String(new Error().stack||'').includes('/workbench-v3.js');}
  function jsonResponse(payload,status=409){
    return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});
  }
  async function idleWorkbenchState(response){
    if(!response.ok)return response;
    const data=await response.clone().json().catch(()=>null);
    if(!data||!Array.isArray(data.inbox))return response;
    data.inbox=data.inbox.map(item=>item?.source==='feishu_doc'?{...item,source:IDLE_SOURCE}:item);
    const headers=new Headers(response.headers);headers.delete('content-length');
    return new Response(JSON.stringify(data),{status:response.status,statusText:response.statusText,headers});
  }

  window.fetch=async function manualControlledFetch(input,init={}){
    const url=requestUrl(input);
    const path=url?.pathname||'';
    if(path==='/api/inbox/sync'){
      if(!syncPermit)return jsonResponse({error:'飞书同步只能由你点击“同步飞书”触发。'});
      syncPermit=false;
      const response=await nativeFetch(input,init);
      if(response.ok){
        classificationRun=true;
        window.__WORKBENCH_FEISHU_CLASSIFY_RUN__=true;
        window.dispatchEvent(new CustomEvent('workbench:feishu-sync-complete'));
      }
      return response;
    }
    if(path==='/api/ai/plan'){
      const body=requestBody(init);
      if(body?.view==='inbox-review'&&!classificationRun){
        const id=String(body.id||'');
        if(!manualAnalyzeIds.has(id))return jsonResponse({error:'请先点击“同步飞书”，或手动点这条记录的“重新分析”。'});
        manualAnalyzeIds.delete(id);
      }
    }
    if(path==='/api/state'&&!classificationRun&&calledFromWorkbenchV3()){
      return idleWorkbenchState(await nativeFetch(input,init));
    }
    return nativeFetch(input,init);
  };

  function sourceLabelFix(){
    for(const pill of document.querySelectorAll('.v3-item-meta .pill')){
      if(pill.textContent===IDLE_SOURCE)pill.textContent='飞书同步';
    }
  }
  function pendingCopyFix(){
    if(classificationRun)return;
    for(const node of document.querySelectorAll('.v3-ai-review.pending .v3-ai-reason')){
      if(/等待进入有界分析队列|正在用/.test(node.textContent||''))node.textContent='等待你点击“同步飞书”后开始去重和分类。';
    }
    for(const button of document.querySelectorAll('[data-v3-action="sync-feishu"]')){
      if(!button.disabled&&button.textContent!=='同步飞书')button.textContent='同步飞书';
      button.title='只有点击这里才会拉取飞书；成功后才开始去重和分类。';
    }
  }
  async function currentState(){
    if(statePromise)return statePromise;
    statePromise=nativeFetch('/api/state',{headers:{'Content-Type':'application/json'}})
      .then(async response=>response.ok?response.json():null)
      .finally(()=>{statePromise=null;});
    return statePromise;
  }
  async function addDismissButtons(){
    const items=[...document.querySelectorAll('.v3-inbox-item')];
    if(!items.length)return;
    const state=await currentState();
    const inbox=Array.isArray(state?.inbox)?state.inbox:[];
    items.forEach((node,index)=>{
      const item=inbox[index];if(!item||node.querySelector('[data-manual-dismiss]'))return;
      let actions=node.querySelector('.v3-actions');
      if(!actions){actions=document.createElement('div');actions.className='v3-actions';node.appendChild(actions);}
      const button=document.createElement('button');
      button.type='button';button.className='btn small';button.dataset.manualDismiss=item.id;
      button.textContent='删除本地';button.title=item.source==='feishu_doc'?'仅从 Workbench 撤下；飞书原文保留，这个来源以后不会重新导入。':'从 Workbench 本地待处理区删除。';
      actions.appendChild(button);
    });
  }
  function enhance(){enhanceScheduled=false;sourceLabelFix();pendingCopyFix();void addDismissButtons();}
  function scheduleEnhance(){if(enhanceScheduled)return;enhanceScheduled=true;requestAnimationFrame(enhance);}

  document.addEventListener('click',event=>{
    const sync=event.target.closest?.('[data-v3-action="sync-feishu"],[data-action="sync-feishu"]');
    if(sync){syncPermit=true;return;}
    const analyze=event.target.closest?.('[data-v3-action="analyze"]');
    if(analyze?.dataset?.id){manualAnalyzeIds.add(analyze.dataset.id);return;}
    const dismiss=event.target.closest?.('[data-manual-dismiss]');
    if(!dismiss)return;
    event.preventDefault();event.stopPropagation();
    const id=dismiss.dataset.manualDismiss;
    if(!confirm('只删除 Workbench 本地这条记录，飞书原文不会删除。继续吗？'))return;
    dismiss.disabled=true;dismiss.textContent='删除中…';
    void nativeFetch('/api/inbox/command',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemId:id,command:'删除'})
    }).then(async response=>{
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||data.question||`请求失败 ${response.status}`);
      location.reload();
    }).catch(error=>{dismiss.disabled=false;dismiss.textContent='删除本地';alert(error.message);});
  },true);

  window.__WORKBENCH_ARM_INITIAL_ANALYSIS__=()=>{
    try{sessionStorage.setItem(INIT_ANALYZE_ONCE,'1');}catch{}
  };
  window.addEventListener('workbench:feishu-sync-complete',scheduleEnhance);
  const app=document.querySelector('#app');if(app)new MutationObserver(scheduleEnhance).observe(app,{childList:true,subtree:true});
  requestAnimationFrame(enhance);
})();