let v3AutoFilter='active';
let v3AutoScheduled=false;
let v3AutoObserver=null;

const CATEGORY_META=Object.freeze({
  todo:{label:'飞书待办',tone:'amber'},
  decision:{label:'需要决定',tone:'red'},
  legacy:{label:'旧版日记项',tone:'muted'}
});

function inferCategory(item){
  const source=item.dataset.v3Source||'';
  const label=item.querySelector('.v3-ai-label')?.textContent||'';
  if(source==='feishu_todo_candidate'||(source==='feishu_doc'&&/旧版/.test(item.querySelector('.v3-item-meta')?.textContent||'')))return'legacy';
  if(/需要你决定/.test(label))return'decision';
  if(source==='feishu_todo'||/飞书待办/.test(item.querySelector('.v3-item-meta')?.textContent||''))return'todo';
  return'decision';
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
}

function filterBarHtml(counts){
  const buttons=[
    ['active','待办流',(counts.todo||0)+(counts.decision||0)],
    ['todo','飞书待办',counts.todo||0],
    ['decision','需要决定',counts.decision||0],
    ['legacy','旧版待清理',counts.legacy||0]
  ];
  return buttons.map(([key,label,count])=>`<button type="button" class="v3-pool-filter${v3AutoFilter===key?' active':''}" data-v3-pool="${key}">${label}<span>${count}</span></button>`).join('');
}

function visibleFor(category){
  if(v3AutoFilter==='active')return category==='todo'||category==='decision';
  return category===v3AutoFilter;
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
    item.hidden=!visibleFor(category);
  }
  let bar=queue.querySelector('.v3-pool-filters');
  if(!bar){bar=document.createElement('div');bar.className='v3-pool-filters';source.insertAdjacentElement('afterend',bar);}
  const html=filterBarHtml(counts);if(bar.innerHTML!==html)bar.innerHTML=html;
}

function schedule(){if(v3AutoScheduled)return;v3AutoScheduled=true;requestAnimationFrame(()=>{v3AutoScheduled=false;renderClassificationPools();});}

document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-v3-pool]');if(!button)return;
  event.preventDefault();event.stopPropagation();v3AutoFilter=button.dataset.v3Pool||'active';schedule();
},true);
window.addEventListener('hashchange',schedule);
window.addEventListener('workbench:enhance',schedule);
requestAnimationFrame(()=>{renderClassificationPools();});
