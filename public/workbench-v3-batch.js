(()=>{
  const {toast:notify}=window.WB;
  const selectedIds=new Set();
  let busy=false;
  let scheduled=false;
  let observer=null;
  let statePromise=null;

  async function currentState(){
    if(statePromise)return statePromise;
    statePromise=fetch('/api/state',{headers:{'Content-Type':'application/json'}}).then(async response=>response.ok?response.json():null).finally(()=>{statePromise=null;});
    return statePromise;
  }
  function inboxNodes(){return [...document.querySelectorAll('#v3-dashboard .v3-inbox-item')];}
  function itemNode(id){return inboxNodes().find(node=>node.dataset.batchId===id)||null;}
  function visibleNodes(){return inboxNodes().filter(node=>!node.hidden);}
  function stableItemId(node,fallback){return node.dataset.v3Id||node.querySelector('[data-manual-dismiss]')?.dataset?.manualDismiss||fallback?.id||'';}
  function confirmButton(node){return node?.querySelector('[data-v3-action="confirm-plan"],[data-v3-action="confirm-extracted-todo"]')||null;}
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  async function waitUntil(predicate,{timeoutMs=25000,intervalMs=160}={}){const started=Date.now();while(Date.now()-started<timeoutMs){if(predicate())return true;await wait(intervalMs);}return false;}

  function ensureItemCheckbox(node,id){
    if(!id)return;node.dataset.batchId=id;node.classList.add('v3-batch-selectable');let label=node.querySelector('.v3-batch-check');
    if(!label){label=document.createElement('label');label.className='v3-batch-check';label.title='选择这条记录进行批量处理';const input=document.createElement('input');input.type='checkbox';input.dataset.batchSelect=id;input.setAttribute('aria-label','选择此记录进行批量处理');label.appendChild(input);node.prepend(label);}
    const input=label.querySelector('input');input.dataset.batchSelect=id;input.checked=selectedIds.has(id);input.disabled=busy;
  }
  function batchBarHost(){const source=document.querySelector('#v3-dashboard .v3-source');if(!source)return null;const filters=source.parentElement?.querySelector('.v3-pool-filters');return filters||source;}
  function renderBatchBar(){
    const host=batchBarHost();if(!host)return;const queue=host.closest('.v3-card');if(!queue)return;let bar=queue.querySelector('.v3-batch-bar');if(!bar){bar=document.createElement('div');bar.className='v3-batch-bar';}if(bar.previousElementSibling!==host)host.insertAdjacentElement('afterend',bar);
    const nodes=inboxNodes(),existingIds=new Set(nodes.map(node=>node.dataset.batchId).filter(Boolean));for(const id of [...selectedIds])if(!existingIds.has(id))selectedIds.delete(id);
    const visible=visibleNodes().map(node=>node.dataset.batchId).filter(Boolean),selectedCount=selectedIds.size,allVisible=visible.length>0&&visible.every(id=>selectedIds.has(id));
    const executable=[...selectedIds].filter(id=>Boolean(confirmButton(itemNode(id)))).length;const disabled=busy||selectedCount===0;
    const html=`<label class="v3-batch-all"><input type="checkbox" data-batch-all aria-label="全选当前页所有记录" ${allVisible?'checked':''} ${busy?'disabled':''}> 全选当前</label><span class="v3-batch-count">已选 ${selectedCount}</span><button class="btn small" data-batch-action="reanalyze" ${disabled?'disabled':''}>批量重新分析</button><button class="btn small primary" data-batch-action="confirm" ${busy||executable===0?'disabled':''}>批量确认可执行 ${executable}</button><button class="btn small" data-batch-action="delete" ${disabled?'disabled':''}>批量删除本地</button>${busy?'<span class="v3-batch-busy">处理中…</span>':''}`;
    if(bar.innerHTML!==html)bar.innerHTML=html;
  }
  async function enhance(){scheduled=false;try{const state=await currentState();const inbox=Array.isArray(state?.inbox)?state.inbox:[];const nodes=inboxNodes();nodes.forEach((node,index)=>{const id=stableItemId(node,inbox[index]);if(id)ensureItemCheckbox(node,id);});renderBatchBar();}catch{}}
  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>void enhance());}

  async function batchReanalyze(){
    const ids=[...selectedIds];const queue=ids.filter(id=>Boolean(itemNode(id)?.querySelector('[data-v3-action="analyze"]')));if(!queue.length)return notify('所选记录当前没有可重新解析的原始日记项。',true);
    busy=true;schedule();let cursor=0;const worker=async()=>{while(cursor<queue.length){const id=queue[cursor++];const button=itemNode(id)?.querySelector('[data-v3-action="analyze"]');if(!button)continue;button.click();await waitUntil(()=>{const node=itemNode(id);return !node||!node.querySelector('.v3-ai-review.pending');});}};
    await Promise.all(Array.from({length:Math.min(2,queue.length)},worker));busy=false;schedule();notify(`已重新解析 ${queue.length} 条原始日记。`);
  }
  async function batchConfirm(){
    const ids=[...selectedIds],executable=ids.filter(id=>Boolean(confirmButton(itemNode(id)))),skipped=ids.length-executable.length;
    if(!executable.length)return notify('所选记录里没有已经具备安全执行条件的待办。',true);
    const suffix=skipped?`；另有 ${skipped} 条缺截止日期/仍在解析，会跳过`:'';if(!confirm(`将批量确认 ${executable.length} 条已具备安全执行条件的待办${suffix}。继续吗？`))return;
    busy=true;schedule();
    for(const id of executable){const button=confirmButton(itemNode(id));if(!button)continue;button.click();await waitUntil(()=>{const node=itemNode(id);return !node||(!node.querySelector('.v3-ai-review.pending')&&!confirmButton(node));});selectedIds.delete(id);}
    busy=false;schedule();notify(`已提交 ${executable.length} 条批量确认${skipped?`，跳过 ${skipped} 条`:''}。`);
  }
  async function batchDelete(){
    const ids=[...selectedIds];if(!ids.length)return;if(ids.length>500)return notify('单次批量删除最多 500 条，请分两次处理。',true);
    if(!confirm(`只从 Workbench 本地删除已选 ${ids.length} 条记录；飞书原文不会删除，而且这些已见来源以后不会重新导入。继续吗？`))return;
    busy=true;schedule();
    try{
      const response=await fetch('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:`inbox-batch-delete-${Date.now()}`,method:'tools/call',params:{name:'inbox_batch_delete',arguments:{itemIds:ids},confirmed:true}})});
      const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`批量删除请求失败 ${response.status}`);if(data.error)throw new Error(data.error.message||'批量删除失败');
      const result=data.result?.structuredContent?.result||{};for(const id of result.deletedIds||[])selectedIds.delete(id);busy=false;schedule();const missing=Number(result.missing||0);notify(`已一次性从 Workbench 本地删除 ${Number(result.deleted||0)} 条${missing?`，${missing} 条已不存在`:''}；飞书原文未改。`);setTimeout(()=>location.reload(),120);
    }catch(error){busy=false;schedule();notify(error.message,true);}
  }

  document.addEventListener('change',event=>{
    const item=event.target.closest?.('[data-batch-select]');if(item){event.stopPropagation();const id=item.dataset.batchSelect;if(item.checked)selectedIds.add(id);else selectedIds.delete(id);schedule();return;}
    const all=event.target.closest?.('[data-batch-all]');if(all){event.stopPropagation();for(const node of visibleNodes()){const id=node.dataset.batchId;if(!id)continue;if(all.checked)selectedIds.add(id);else selectedIds.delete(id);}schedule();}
  },true);
  document.addEventListener('click',event=>{
    if(event.target.closest?.('.v3-batch-check'))event.stopPropagation();const action=event.target.closest?.('[data-batch-action]')?.dataset?.batchAction;if(!action||busy)return;event.preventDefault();event.stopPropagation();
    if(action==='reanalyze')void batchReanalyze();else if(action==='confirm')void batchConfirm();else if(action==='delete')void batchDelete();
  },true);
  window.addEventListener('hashchange',schedule);window.addEventListener('workbench:enhance',schedule);window.addEventListener('workbench:feishu-sync-complete',schedule);requestAnimationFrame(()=>{schedule();});
})();
