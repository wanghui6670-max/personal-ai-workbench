(()=>{
  let scheduled=false;
  let statePromise=null;
  let busy=false;

  function notify(message,error=false){
    const toast=document.querySelector('#toast');
    if(!toast){if(error)alert(message);return;}
    toast.textContent=message;
    toast.className=`toast show${error?' error':''}`;
    clearTimeout(toast._initTimer);
    toast._initTimer=setTimeout(()=>toast.className='toast',4200);
  }

  async function currentState(){
    if(statePromise)return statePromise;
    statePromise=fetch('/api/state',{headers:{'Content-Type':'application/json'}})
      .then(async response=>response.ok?response.json():null)
      .finally(()=>{statePromise=null;});
    return statePromise;
  }

  function buttonCopy(source){
    const reinitialize=Boolean(source?.initialImportAt);
    return reinitialize
      ?{text:'重新初始化',title:'重新完整扫描当前飞书日记并重建已见来源基线；这是显式操作，普通同步仍只处理新增内容。'}
      :{text:'初始化导入并分析',title:'完整扫描当前整篇飞书日记一次，建立来源基线；完成后普通同步只处理新增内容。'};
  }

  async function enhance(){
    scheduled=false;
    const sourceBar=document.querySelector('#v3-dashboard .v3-source');
    if(!sourceBar)return;
    const state=await currentState();
    const source=state?.config?.dataSource;
    const existing=sourceBar.querySelector('[data-v3-action="initialize-feishu"]');
    if(!source||source.provider!=='feishu_doc'){existing?.remove();return;}
    const copy=buttonCopy(source);
    if(existing){
      if(!busy&&existing.textContent!==copy.text)existing.textContent=copy.text;
      existing.title=copy.title;
      return;
    }
    const button=document.createElement('button');
    button.type='button';
    button.className='btn small';
    button.dataset.v3Action='initialize-feishu';
    button.textContent=copy.text;
    button.title=copy.title;
    const sync=sourceBar.querySelector('[data-v3-action="sync-feishu"]');
    if(sync)sync.insertAdjacentElement('beforebegin',button);else sourceBar.appendChild(button);
  }

  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>void enhance());}

  async function initialize(button){
    if(busy)return;
    const state=await currentState();
    const source=state?.config?.dataSource;
    if(!source)return notify('飞书日记尚未绑定。',true);
    const reinitialize=Boolean(source.initialImportAt);
    const pending=(state.inbox||[]).filter(item=>item.source==='feishu_doc').length;
    const pendingWarning=pending?`当前仍有 ${pending} 条飞书待处理记录。重新建立基线不会删除这些本地记录，但当前飞书内容会重新参与精确去重。\n\n`:'';
    const actionText=reinitialize
      ?'重新初始化会清空现有“已见来源”基线，完整扫描当前飞书日记，再重新建立基线并把需要分析的内容送入 AI。完成后，普通“同步飞书”仍只处理之后新增的 block。'
      :'初始化会完整扫描当前飞书日记一次，建立“已见来源”基线，并把当前内容送入 AI 去重/分类；最终只保留待办。以后普通同步只处理新增 block。';
    if(!confirm(`${pendingWarning}${actionText}\n\n飞书原文不会被删除或改写。继续吗？`))return;
    busy=true;button.disabled=true;button.textContent=reinitialize?'重新初始化中…':'初始化导入中…';
    try{
      const rpcId=`feishu-init-${Date.now()}`;
      const response=await fetch('/api/mcp',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          jsonrpc:'2.0',id:rpcId,method:'tools/call',
          params:{name:'feishu_initial_import',arguments:{},confirmed:true}
        })
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||`初始化请求失败 ${response.status}`);
      if(data.error)throw new Error(data.error.message||'初始化工具执行失败');
      const result=data.result?.structuredContent?.result||{};
      window.__WORKBENCH_ARM_INITIAL_ANALYSIS__?.();
      try{sessionStorage.setItem('workbench-feishu-init-summary',JSON.stringify({reinitialize,imported:result.imported||0,deduped:result.deduped||0,remoteCount:result.remoteCount||0}));}catch{}
      location.reload();
    }catch(error){
      busy=false;button.disabled=false;button.textContent=buttonCopy(source).text;notify(error.message,true);
    }
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-v3-action="initialize-feishu"]');
    if(!button)return;
    event.preventDefault();event.stopPropagation();void initialize(button);
  },true);

  try{
    const summary=JSON.parse(sessionStorage.getItem('workbench-feishu-init-summary')||'null');
    if(summary){
      sessionStorage.removeItem('workbench-feishu-init-summary');
      const label=summary.reinitialize?'重新初始化完成':'初始化导入完成';
      setTimeout(()=>notify(`${label}：当前文档 ${summary.remoteCount} 条来源中，新进入分析 ${summary.imported} 条，精确去重 ${summary.deduped} 条。AI 正在分类，只会留下待办。`),900);
    }
  }catch{}

  const app=document.querySelector('#app');
  if(app)new MutationObserver(schedule).observe(app,{childList:true,subtree:true});
  window.addEventListener('hashchange',schedule);
  requestAnimationFrame(schedule);
})();
