let v3AutoFilter='active';
let v3AutoScheduled=false;
let v3AutoObserver=null;
let v3AutoReloadScheduled=false;
let v3AutoFilteredCount=0;
const v3AutoFilteringIds=new Set();
const v3AutoFilteredIds=new Set();

const CATEGORY_META=Object.freeze({
  todo:{label:'待办候选',tone:'amber'},
  project:{label:'项目进展',tone:'blue'},
  analysis:{label:'分析思考',tone:'purple'},
  daily:{label:'日常记录',tone:'green'},
  decision:{label:'需要决定',tone:'red'},
  pending:{label:'分析中',tone:'muted'}
});
const AUTO_FILTER_NON_TODO=new Set(['project','analysis','daily']);

function inferCategory(item){
  const label=item.querySelector('.v3-ai-label')?.textContent||'';
  const reason=item.querySelector('.v3-ai-reason')?.textContent||'';
  const command=item.querySelector('.v3-ai-command')?.textContent||'';
  const text=`${label} ${reason} ${command}`;
  if(/正在|等待进入|AI 自动分析|分析暂不可用/.test(text))return'pending';
  if(/待办候选|分类：待办候选|缺.*截止日期|创建.*待办/.test(text))return'todo';
  if(/项目进展|分类：项目进展|项目记录/.test(text))return'project';
  if(/分析思考|分类：分析思考/.test(text))return'analysis';
  if(/日常记录|分类：日常记录/.test(text))return'daily';
  return'decision';
}

function itemId(item){
  return item.querySelector('[data-id]')?.dataset?.id||'';
}

function isFeishuItem(item){
  return /飞书同步/.test(item.querySelector('.v3-item-meta')?.textContent||'');
}

async function dismissFilteredNonTodo(item,category){
  if(!AUTO_FILTER_NON_TODO.has(category)||!isFeishuItem(item))return;
  const id=itemId(item);
  if(!id||v3AutoFilteringIds.has(id)||v3AutoFilteredIds.has(id))return;
  v3AutoFilteringIds.add(id);
  item.dataset.v3AutoFiltering='1';
  try{
    const response=await fetch('/api/inbox/command',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({itemId:id,command:`不进入待办：${category}`})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||data.question||`请求失败 ${response.status}`);
    v3AutoFilteredIds.add(id);
    v3AutoFilteredCount+=1;
    item.remove();
  }catch(error){
    item.dataset.v3AutoFilterError='1';
    const reason=item.querySelector('.v3-ai-reason');
    if(reason&&!reason.textContent.includes('自动过滤失败'))reason.textContent=`${reason.textContent||''} · 自动过滤失败：${error.message}`;
  }finally{
    v3AutoFilteringIds.delete(id);
    delete item.dataset.v3AutoFiltering;
    schedule();
  }
}

function ensureCategoryPill(item,category){
  const meta=CATEGORY_META[category]||CATEGORY_META.decision;
  if(item.dataset.v3Category!==category)item.dataset.v3Category=category;
  const host=item.querySelector('.v3-item-meta');if(!host)return;
  let pill=host.querySelector('.v3-category-pill');
  if(!pill){pill=document.createElement('span');pill.className='pill v3-category-pill';host.appendChild(pill);}
  const wanted=`pill v3-category-pill ${meta.tone}`;
  if(pill.className!==wanted)pill.className=wanted;
  if(pill.textContent!==meta.label)pill.textContent=meta.label;
  const aiLabel=item.querySelector('.v3-ai-label');
  if(aiLabel&&category!=='pending'){
    const current=aiLabel.textContent||'';
    let suffix='';
    if(category==='todo'&&/缺.*截止日期|需要补充/.test(`${current} ${item.querySelector('.v3-ai-reason')?.textContent||''}`))suffix=' · 待补日期';
    else if(category==='todo'&&item.querySelector('[data-v3-action="confirm-plan"]'))suffix=' · 等你确认';
    const next=`${meta.label}${suffix}`;
    if(aiLabel.textContent!==next)aiLabel.textContent=next;
  }
}

function filterBarHtml(counts){
  const buttons=[
    ['active','待办流',(counts.todo||0)+(counts.pending||0)],
    ['todo','待办',counts.todo||0],
    ['pending','分析中',counts.pending||0],
    ['decision','需要决定',counts.decision||0]
  ];
  const controls=buttons.map(([key,label,count])=>`<button type="button" class="v3-pool-filter${v3AutoFilter===key?' active':''}" data-v3-pool="${key}">${label}<span>${count}</span></button>`).join('');
  return `${controls}<span class="v3-pool-filtered">已过滤非待办 ${v3AutoFilteredCount}</span>`;
}

function visibleFor(category){
  if(v3AutoFilter==='active')return category==='todo'||category==='pending';
  return category===v3AutoFilter;
}

function maybeReloadAfterFiltering(counts){
  if(v3AutoReloadScheduled||v3AutoFilteredCount===0||v3AutoFilteringIds.size>0||(counts.pending||0)>0)return;
  v3AutoReloadScheduled=true;
  setTimeout(()=>location.reload(),500);
}

function renderClassificationPools(){
  const dashboard=document.querySelector('#v3-dashboard');if(!dashboard)return;
  const source=dashboard.querySelector('.v3-source');
  const queue=source?.closest('.v3-card');if(!queue)return;
  const items=[...queue.querySelectorAll('.v3-inbox-item')];
  const counts={};
  for(const item of items){
    const category=inferCategory(item);counts[category]=(counts[category]||0)+1;
    ensureCategoryPill(item,category);
    if(AUTO_FILTER_NON_TODO.has(category)){
      item.hidden=true;
      void dismissFilteredNonTodo(item,category);
      continue;
    }
    const visible=visibleFor(category);
    if(item.hidden===visible)item.hidden=!visible;
  }
  let bar=queue.querySelector('.v3-pool-filters');
  if(!bar){bar=document.createElement('div');bar.className='v3-pool-filters';source.insertAdjacentElement('afterend',bar);}
  const html=filterBarHtml(counts);if(bar.innerHTML!==html)bar.innerHTML=html;
  maybeReloadAfterFiltering(counts);
}

function schedule(){if(v3AutoScheduled)return;v3AutoScheduled=true;requestAnimationFrame(()=>{v3AutoScheduled=false;renderClassificationPools();attachObserver();});}
function attachObserver(){
  const main=document.querySelector('.main');if(!main||v3AutoObserver?._target===main)return;
  v3AutoObserver?.disconnect();v3AutoObserver=new MutationObserver(schedule);v3AutoObserver._target=main;
  v3AutoObserver.observe(main,{childList:true});
}

document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-v3-pool]');if(!button)return;
  event.preventDefault();event.stopPropagation();v3AutoFilter=button.dataset.v3Pool||'active';schedule();
},true);
window.addEventListener('hashchange',schedule);
const app=document.querySelector('#app');if(app)new MutationObserver(schedule).observe(app,{childList:true});
requestAnimationFrame(()=>{attachObserver();renderClassificationPools();});
