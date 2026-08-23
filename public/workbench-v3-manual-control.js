(()=>{
  const nativeFetch=window.fetch.bind(window);
  let syncPermit=false;
  let enhanceScheduled=false;
  let statePromise=null;

  function requestUrl(input){
    try{return new URL(typeof input==='string'?input:input?.url||'',location.origin);}catch{return null;}
  }
  function jsonResponse(payload,status=409){
    return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});
  }

  // 只限制“读取飞书来源”必须由用户显式触发。同步后的内容已经是飞书明确待办，
  // AI 可以围绕这些待办给建议，但不得再读取普通日记来判断/提取任务。
  window.fetch=async function manualControlledFetch(input,init={}){
    const url=requestUrl(input);
    const path=url?.pathname||'';
    if(path==='/api/inbox/sync'){
      if(!syncPermit)return jsonResponse({error:'飞书待办同步只能由你点击“同步飞书待办”触发。'});
      syncPermit=false;
      const response=await nativeFetch(input,init);
      if(response.ok)window.dispatchEvent(new CustomEvent('workbench:feishu-sync-complete'));
      return response;
    }
    return nativeFetch(input,init);
  };

  function copyFix(){
    for(const button of document.querySelectorAll('[data-v3-action="sync-feishu"],[data-action="sync-feishu"]')){
      if(!button.disabled&&button.textContent!=='同步飞书待办')button.textContent='同步飞书待办';
      button.title='只读取飞书云文档中的明确待办；普通日记、复盘、分析和项目进展不会进入待办同步。';
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
    const byId=new Map(inbox.map(item=>[item.id,item]));
    items.forEach((node,index)=>{
      const item=byId.get(node.dataset.v3Id)||inbox[index];if(!item||node.querySelector('[data-manual-dismiss]'))return;
      let actions=node.querySelector('.v3-actions');
      if(!actions){actions=document.createElement('div');actions.className='v3-actions';node.appendChild(actions);}
      const button=document.createElement('button');
      button.type='button';button.className='btn small';button.dataset.manualDismiss=item.id;
      button.textContent='删除本地';
      button.title=['feishu_todo','feishu_doc','feishu_todo_candidate'].includes(item.source)
        ?'仅从 Workbench 撤下；飞书原文保留。'
        :'从 Workbench 本地待处理区删除。';
      actions.appendChild(button);
    });
  }
  function enhance(){enhanceScheduled=false;copyFix();void addDismissButtons();}
  function scheduleEnhance(){if(enhanceScheduled)return;enhanceScheduled=true;requestAnimationFrame(enhance);}

  document.addEventListener('click',event=>{
    const sync=event.target.closest?.('[data-v3-action="sync-feishu"],[data-action="sync-feishu"]');
    if(sync){syncPermit=true;return;}
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

  // 兼容旧初始化脚本调用；todo-only 模式不再需要“整篇日记提取”一次性令牌。
  window.__WORKBENCH_ARM_INITIAL_ANALYSIS__=()=>{};
  window.addEventListener('workbench:feishu-sync-complete',scheduleEnhance);
  window.addEventListener('workbench:enhance',scheduleEnhance);
  requestAnimationFrame(enhance);
})();
