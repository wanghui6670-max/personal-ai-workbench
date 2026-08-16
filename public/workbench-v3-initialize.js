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

  async function enhance(){
    scheduled=false;
    const sourceBar=document.querySelector('#v3-dashboard .v3-source');
    if(!sourceBar)return;
    const state=await currentState();
    const source=state?.config?.dataSource;
    const existing=sourceBar.querySelector('[data-v3-action="initialize-feishu"]');
    if(!source||source.provider!=='feishu_doc'||source.initialImportAt){existing?.remove();return;}
    if(existing)return;
    const button=document.createElement('button');
    button.type='button';
    button.className='btn small';
    button.dataset.v3Action='initialize-feishu';
    button.textContent='初始化导入并分析';
    button.title='一次性重新建立当前整篇飞书日记基线；完成后普通同步只处理新增内容。';
    const sync=sourceBar.querySelector('[data-v3-action="sync-feishu"]');
    if(sync)sync.insertAdjacentElement('beforebegin',button);else sourceBar.appendChild(button);
  }

  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>void enhance());}

  async function initialize(button){
    if(busy)return;
    const state=await currentState();
    const source=state?.config?.dataSource;
    if(!source)return notify('飞书日记尚未绑定。',true);
    if(source.initialImportAt)return notify('初始化已经完成；后续请直接使用“同步飞书”。');
    const pending=(state.inbox||[]).filter(item=>item.source==='feishu_doc').length;
    const warning=pending?`当前仍有 ${pending} 条飞书待处理记录。初始化不会删除它们，但会重新建立来源基线。\n\n`:'';
    if(!confirm(`${warning}初始化会完整扫描当前飞书日记一次，重建“已见来源”基线，并把当前内容送入 AI 去重/分类；最终只保留待办。以后普通同步只处理新增 block。\n\n这是一次性操作，继续吗？`))return;
    busy=true;button.disabled=true;button.textContent='初始化导入中…';
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
      try{sessionStorage.setItem('workbench-feishu-init-summary',JSON.stringify({imported:result.imported||0,deduped:result.deduped||0,remoteCount:result.remoteCount||0}));}catch{}
      location.reload();
    }catch(error){
      busy=false;button.disabled=false;button.textContent='初始化导入并分析';notify(error.message,true);
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
      setTimeout(()=>notify(`初始化导入完成：当前文档 ${summary.remoteCount} 条来源中，新进入分析 ${summary.imported} 条，精确去重 ${summary.deduped} 条。AI 正在分类，只会留下待办。`),900);
    }
  }catch{}

  const app=document.querySelector('#app');
  if(app)new MutationObserver(schedule).observe(app,{childList:true,subtree:true});
  window.addEventListener('hashchange',schedule);
  requestAnimationFrame(schedule);
})();