let v3AutoFilter='all';
let v3AutoScheduled=false;
let v3AutoObserver=null;

const CATEGORY_META=Object.freeze({
  todo:{label:'待办候选',tone:'amber'},
  project:{label:'项目进展',tone:'blue'},
  analysis:{label:'分析思考',tone:'purple'},
  daily:{label:'日常记录',tone:'green'},
  decision:{label:'需要决定',tone:'red'},
  pending:{label:'分析中',tone:'muted'}
});

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

function ensureCategoryPill(item,category){
  const meta=CATEGORY_META[category]||CATEGORY_META.decision;
  item.dataset.v3Category=category;
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
    if(/缺.*截止日期|需要你决定|需要补充/.test(`${current} ${item.querySelector('.v3-ai-reason')?.textContent||''}`))suffix=' · 待补充';
    else if(item.querySelector('[data-v3-action="confirm-plan"]'))suffix=' · 等你确认';
    const next=`${meta.label}${suffix}`;
    if(aiLabel.textContent!==next)aiLabel.textContent=next;
  }
}

function filterBarHtml(counts,total){
  const buttons=[
    ['all','全部',total],['todo','待办',counts.todo||0],['project','项目进展',counts.project||0],
    ['analysis','分析思考',counts.analysis||0],['daily','日常记录',counts.daily||0],
    ['decision','需要决定',counts.decision||0],['pending','分析中',counts.pending||0]
  ];
  return buttons.map(([key,label,count])=>`<button type="button" class="v3-pool-filter${v3AutoFilter===key?' active':''}" data-v3-pool="${key}">${label}<span>${count}</span></button>`).join('');
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
    const visible=v3AutoFilter==='all'||category===v3AutoFilter;
    if(item.hidden===visible)item.hidden=!visible;
  }
  let bar=queue.querySelector('.v3-pool-filters');
  if(!bar){bar=document.createElement('div');bar.className='v3-pool-filters';source.insertAdjacentElement('afterend',bar);}
  const html=filterBarHtml(counts,items.length);if(bar.innerHTML!==html)bar.innerHTML=html;
}

function schedule(){if(v3AutoScheduled)return;v3AutoScheduled=true;requestAnimationFrame(()=>{v3AutoScheduled=false;renderClassificationPools();attachObserver();});}
function attachObserver(){
  const main=document.querySelector('.main');if(!main||v3AutoObserver?._target===main)return;
  v3AutoObserver?.disconnect();v3AutoObserver=new MutationObserver(schedule);v3AutoObserver._target=main;
  v3AutoObserver.observe(main,{childList:true,subtree:true});
}

document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-v3-pool]');if(!button)return;
  event.preventDefault();event.stopPropagation();v3AutoFilter=button.dataset.v3Pool||'all';schedule();
},true);
window.addEventListener('hashchange',schedule);
const app=document.querySelector('#app');if(app)new MutationObserver(schedule).observe(app,{childList:true});
requestAnimationFrame(()=>{attachObserver();renderClassificationPools();});
