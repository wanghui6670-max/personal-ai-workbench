const THEME_KEY='personal-ai-workbench.theme';
const THEME_VALUES=new Set(['light','dark']);
let scheduled=false;

function preferredTheme(){
  try{
    const stored=localStorage.getItem(THEME_KEY);
    if(THEME_VALUES.has(stored))return stored;
  }catch{}
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
}

function applyTheme(theme,{persist=false}={}){
  const next=THEME_VALUES.has(theme)?theme:'light';
  document.documentElement.dataset.theme=next;
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta)meta.setAttribute('content',next==='dark'?'#0f1115':'#f6f7f9');
  if(persist){
    try{localStorage.setItem(THEME_KEY,next);}catch{}
  }
  syncThemeButton();
}

function syncThemeButton(){
  const button=document.querySelector('[data-theme-toggle]');
  if(!button)return;
  const dark=document.documentElement.dataset.theme==='dark';
  const label=dark?'切换到日间模式':'切换到夜间模式';
  const html=`<span aria-hidden="true">${dark?'☀':'☾'}</span><span class="theme-label">${label}</span>`;
  if(button.innerHTML!==html)button.innerHTML=html;
  if(button.title!==label)button.title=label;
  if(button.getAttribute('aria-label')!==label)button.setAttribute('aria-label',label);
}

function ensureThemeButton(){
  const actions=document.querySelector('.topbar .actions');
  if(!actions)return;
  const existing=actions.querySelector('[data-theme-toggle]');
  if(existing){syncThemeButton();return;}
  const button=document.createElement('button');
  button.type='button';
  button.className='btn ghost theme-toggle';
  button.dataset.themeToggle='';
  actions.prepend(button);
  syncThemeButton();
}

function setTextIfChanged(node,text){
  if(node&&node.textContent!==text)node.textContent=text;
}

function wrapSecondary(node,{className,label}){
  if(!node||node.closest('.today-secondary-details'))return null;
  const details=document.createElement('details');
  details.className=`today-secondary-details ${className}`;
  const summary=document.createElement('summary');
  summary.textContent=label;
  const body=document.createElement('div');
  body.className='today-secondary-body';
  node.replaceWith(details);
  body.append(node);
  details.append(summary,body);
  return details;
}

function compactRecentWork(primary){
  if(!primary||primary.querySelector('.today-recent-details'))return;
  const title=[...primary.querySelectorAll('.section-title')].find(node=>node.textContent.trim()==='最近工作现场');
  if(!title)return;
  const details=document.createElement('details');
  details.className='today-secondary-details today-recent-details';
  const summary=document.createElement('summary');
  const activities=[];
  let cursor=title.nextSibling;
  while(cursor){
    const next=cursor.nextSibling;
    if(cursor.nodeType===1&&cursor.classList?.contains('activity'))activities.push(cursor);
    else if(cursor.nodeType===1&&cursor.classList?.contains('empty'))activities.push(cursor);
    cursor=next;
  }
  summary.textContent=`最近工作现场${activities.length?` · ${activities.length}`:''}`;
  const body=document.createElement('div');
  body.className='today-secondary-body';
  for(const item of activities)body.append(item);
  title.replaceWith(details);
  details.append(summary,body);
}

function simplifyDecisionCard(card){
  if(!card)return;
  card.classList.add('today-decision-minimal');
  setTextIfChanged(card.querySelector('.card-desc'),'只处理需要你拍板的事项。');
  const rule=card.querySelector('.decision-rule');
  if(rule&&!rule.hidden)rule.hidden=true;
  const askTitle=[...card.querySelectorAll('.section-title')].find(node=>node.textContent.includes('可以这样问右侧 AI'));
  if(askTitle){
    askTitle.dataset.todaySecondaryCopy='';
    if(!askTitle.hidden)askTitle.hidden=true;
    const next=askTitle.nextElementSibling;
    if(next){
      next.dataset.todaySecondaryCopy='';
      if(!next.hidden)next.hidden=true;
    }
  }
  const attention=[...card.querySelectorAll('.section-title')].find(node=>node.textContent.includes('当前需要你留意')||node.textContent==='需要处理');
  setTextIfChanged(attention,'需要处理');
}

function simplifyToday(){
  const isToday=(location.hash||'#today').slice(1).split('/')[0]==='today';
  document.documentElement.classList.toggle('today-focus',isToday);
  if(!isToday)return;
  const main=document.querySelector('.main');
  if(!main)return;
  const grid=main.querySelector('.grid');
  if(!grid)return;

  const primary=grid.querySelector('section.card.pad');
  setTextIfChanged(primary?.querySelector('.card-desc'),'只显示你明确加入今天的任务。');
  const empty=primary?.querySelector('.empty');
  if(empty&&empty.textContent.includes('今天还没有正式安排任务')){
    empty.innerHTML='<strong>今天还没有正式安排任务。</strong><br>从待办中选择真正要做的，再加入今日。';
  }
  compactRecentWork(primary);
  simplifyDecisionCard(grid.querySelector('.human-decision-card'));

  const statRow=main.querySelector(':scope > .stat-row');
  if(statRow){
    const wrapped=wrapSecondary(statRow,{className:'today-stats-details',label:'工作概览'});
    if(wrapped)grid.insertAdjacentElement('afterend',wrapped);
  }

  const projectSection=[...main.querySelectorAll(':scope > section.card.pad')].find(section=>section.querySelector('.card-title')?.textContent.trim()==='所有项目进度');
  if(projectSection)wrapSecondary(projectSection,{className:'today-project-details',label:'项目进度'});
}

function enhance(){
  ensureThemeButton();
  simplifyToday();
}

function scheduleEnhance(){
  if(scheduled)return;
  scheduled=true;
  queueMicrotask(()=>{scheduled=false;enhance();});
}

applyTheme(preferredTheme());
document.addEventListener('click',event=>{
  if(!event.target.closest?.('[data-theme-toggle]'))return;
  const current=document.documentElement.dataset.theme==='dark'?'dark':'light';
  applyTheme(current==='dark'?'light':'dark',{persist:true});
});
window.addEventListener('hashchange',scheduleEnhance);
new MutationObserver(scheduleEnhance).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change',event=>{
  let stored=null;
  try{stored=localStorage.getItem(THEME_KEY);}catch{}
  if(!THEME_VALUES.has(stored))applyTheme(event.matches?'dark':'light');
});
scheduleEnhance();
