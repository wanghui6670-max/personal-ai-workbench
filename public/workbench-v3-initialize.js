(()=>{
  const {toast:notify}=window.WB;
  let scheduled=false;
  let statePromise=null;
  let busy=false;

  async function currentState(){
    if(statePromise)return statePromise;
    statePromise=fetch('/api/state',{headers:{'Content-Type':'application/json'}}).then(async response=>response.ok?response.json():null).finally(()=>{statePromise=null;});
    return statePromise;
  }
  function buttonCopy(source){
    const reinitialize=Boolean(source?.initialImportAt);
    return reinitialize
      ?{text:'重新初始化待办',title:'重新扫描当前飞书云文档，只重建明确待办的已见来源基线；普通日记正文不会进入待办同步。'}
      :{text:'初始化待办同步',title:'扫描当前飞书云文档一次，只建立明确待办的来源基线；普通日记正文不会进入待办同步。'};
  }
  async function enhance(){
    scheduled=false;
    const sourceBar=document.querySelector('#v3-dashboard .v3-source');if(!sourceBar)return;
    const state=await currentState();const source=state?.config?.dataSource;const existing=sourceBar.querySelector('[data-v3-action="initialize-feishu"]');
    if(!source||source.provider!=='feishu_doc'){existing?.remove();return;}
    const copy=buttonCopy(source);
    if(existing){if(!busy&&existing.textContent!==copy.text)existing.textContent=copy.text;existing.title=copy.title;return;}
    const button=document.createElement('button');button.type='button';button.className='btn small';button.dataset.v3Action='initialize-feishu';button.textContent=copy.text;button.title=copy.title;
    const sync=sourceBar.querySelector('[data-v3-action="sync-feishu"]');if(sync)sync.insertAdjacentElement('beforebegin',button);else sourceBar.appendChild(button);
  }
  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>void enhance());}

  async function initialize(button){
    if(busy)return;
    const state=await currentState();const source=state?.config?.dataSource;if(!source)return notify('飞书云文档尚未绑定。',true);
    const reinitialize=Boolean(source.initialImportAt);
    const legacy=(state.inbox||[]).filter(item=>item.source==='feishu_todo_candidate'||(item.source==='feishu_doc'&&item.feishuMode==='mixed_diary')).length;
    const legacyWarning=legacy?`当前还有 ${legacy} 条旧版“整篇日记解析”本地项。初始化时会撤下这些旧项；如果对应飞书 block 本身是明确待办，会按新规则重新导入。\n\n`:'';
    const actionText=reinitialize
      ?'重新初始化会清空现有待办来源基线并重新扫描当前飞书云文档。只读取飞书原生未完成待办/复选框，以及明确“收件箱 / Workbench 收件箱”中的 [INBOX] 待办；普通段落、复盘、分析、项目进展和日常记录全部忽略。'
      :'初始化会扫描当前飞书云文档并建立待办来源基线。只读取飞书原生未完成待办/复选框，以及明确“收件箱 / Workbench 收件箱”中的 [INBOX] 待办；不会把普通日记送给 AI 判断是不是任务。';
    if(!confirm(`${legacyWarning}${actionText}\n\n飞书原文不会被删除或改写。继续吗？`))return;
    busy=true;button.disabled=true;button.textContent=reinitialize?'重新初始化待办中…':'初始化待办中…';
    try{
      const rpcId=`feishu-init-${Date.now()}`;
      const response=await fetch('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:rpcId,method:'tools/call',params:{name:'feishu_initial_import',arguments:{},confirmed:true}})});
      const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`初始化请求失败 ${response.status}`);if(data.error)throw new Error(data.error.message||'初始化工具执行失败');
      const result=data.result?.structuredContent?.result||{};
      try{sessionStorage.setItem('workbench-feishu-init-summary',JSON.stringify({reinitialize,imported:result.imported||0,deduped:result.deduped||0,remoteCount:result.remoteCount||0,cleanedLegacy:result.cleanedLegacy||0}));}catch{}
      location.reload();
    }catch(error){busy=false;button.disabled=false;button.textContent=buttonCopy(source).text;notify(error.message,true);}
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-v3-action="initialize-feishu"]');if(!button)return;
    event.preventDefault();event.stopPropagation();void initialize(button);
  },true);

  try{
    const summary=JSON.parse(sessionStorage.getItem('workbench-feishu-init-summary')||'null');
    if(summary){
      sessionStorage.removeItem('workbench-feishu-init-summary');
      const label=summary.reinitialize?'待办重新初始化完成':'待办初始化完成';
      setTimeout(()=>notify(`${label}：当前文档识别到 ${summary.remoteCount} 条明确待办，新增 ${summary.imported} 条，精确去重 ${summary.deduped} 条${summary.cleanedLegacy?`，撤下旧版日记项 ${summary.cleanedLegacy} 条`:''}。普通日记未进入待办同步。`),900);
    }
  }catch{}

  const app=document.querySelector('#app');if(app)new MutationObserver(schedule).observe(app,{childList:true,subtree:true});
  window.addEventListener('hashchange',schedule);requestAnimationFrame(schedule);
})();
