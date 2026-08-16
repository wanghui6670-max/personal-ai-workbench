let v3AutoFilter='active';
let v3AutoScheduled=false;
let v3AutoObserver=null;

const CATEGORY_META=Object.freeze({
  todo:{label:'待办候选',tone:'amber'},
  pending:{label:'提取中',tone:'muted'},
  decision:{label:'需要决定',tone:'red'}
});

function inferCategory(item){
  const label=item.querySelector('.v3-ai-label')?.textContent||'';
  const reason=item.querySelector('.v3-ai-reason')?.textContent||'';
  const text=`${label} ${reason}`;
  if(/AI 待办提取|正在|等待进入|等待你点击|提取队列/.test(text))return'pending';
  if(/待办候选|待补截止日期|确认创建待办/.test(text))return'todo';
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
    ['active','待办流',(counts.todo||0)+(counts.pending||0)],
    ['todo','待办',counts.todo||0],
    ['pending','提取中',counts.pending||0],
    ['decision','需要决定',counts.decision||0]
  ];
  return buttons.map(([key,label,count])=>`<button type="button" class="v3-pool-filter${v3AutoFilter===key?' active':''}" data-v3-pool="${key}">${label}<span>${count}</span></button>`).join('');
}

function visibleFor(category){
  if(v3AutoFilter==='active')return category==='todo'||category==='pending';
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
