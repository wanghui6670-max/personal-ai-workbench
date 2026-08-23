const {esc,attr,routePart,fmtDate,fmtTime,json,currentView,setTop,hideLegacyMain}=window.WB;
let v3State=null;
let scheduled=false;
let rendering=false;
let refreshPromise=null;
let planVersion=0;
const inboxPlans=new Map();
const autoAnalyzeQueue=[];
const queuedIds=new Set();
let autoAnalyzeActive=0;
const AUTO_ANALYZE_CONCURRENCY=2;
const AUTO_ANALYZE_QUEUE_LIMIT=100;
const REVIEW_CACHE_KEY='workbench-v3-inbox-reviews-v1';
const REVIEW_CACHE_MAX_AGE_MS=9*60*1000;

function notify(message,error=false){window.WB.toast(message,error,3000);}
function stateSignature(state){
  return JSON.stringify({
    today:state?.todayPlan||[],todos:(state?.todos||[]).map(todo=>[todo.id,todo.dueDate,todo.done]),inbox:(state?.inbox||[]).map(item=>[item.id,item.text,item.source,item.suggestedDueDate,item.suggestedProjectId]),
    projects:(state?.projects||[]).map(project=>[project.id,project.progress?.percent,project.progress?.lastActivity,project.completed,project.archived]),
    confirmations:(state?.confirmations||[]).map(item=>item.id),sync:state?.config?.dataSource?.lastSyncAt||null,plans:planVersion
  });
}
function reviewKey(item){return JSON.stringify([item?.id||'',item?.text||'',item?.source||'',item?.createdAt||'']);}
function loadReviewCache(){
  try{
    const raw=JSON.parse(sessionStorage.getItem(REVIEW_CACHE_KEY)||'[]');const now=Date.now();if(!Array.isArray(raw))return;
    for(const entry of raw){
      if(!entry||typeof entry.id!=='string'||typeof entry.reviewKey!=='string'||!entry.plan||!Number.isFinite(entry.cachedAt))continue;
      if(now-entry.cachedAt>REVIEW_CACHE_MAX_AGE_MS)continue;
      inboxPlans.set(entry.id,{status:'ready',reviewKey:entry.reviewKey,plan:entry.plan,cachedAt:entry.cachedAt});
    }
  }catch{}
}
function persistReviewCache(){
  try{
    const now=Date.now(),safe=[];
    for(const [id,entry] of inboxPlans){
      if(entry?.status!=='ready'||!entry.plan||typeof entry.reviewKey!=='string')continue;
      const cachedAt=Number(entry.cachedAt||now);if(now-cachedAt>REVIEW_CACHE_MAX_AGE_MS)continue;
      safe.push({id,reviewKey:entry.reviewKey,plan:entry.plan,cachedAt});if(safe.length>=100)break;
    }
    sessionStorage.setItem(REVIEW_CACHE_KEY,JSON.stringify(safe));
  }catch{}
}
function reconcileReviewCache(){
  if(!v3State)return;const items=new Map((v3State.inbox||[]).map(item=>[item.id,item]));let changed=false;
  for(const [id,entry] of inboxPlans){const item=items.get(id);if(!item||entry.reviewKey!==reviewKey(item)){inboxPlans.delete(id);changed=true;}}
  if(changed)persistReviewCache();
}
async function refresh(force=false){
  if(refreshPromise&&!force)return refreshPromise;
  refreshPromise=json('/api/state').then(state=>{v3State=state;reconcileReviewCache();renderEnhancements();void autoAnalyze();return state;}).finally(()=>{refreshPromise=null;});
  return refreshPromise;
}

function enhanceSidebar(){
  const today=document.querySelector('.nav a[href="#today"]');
  if(today&&v3State){const wanted=`⌂ 首页<span class="count">${Number(v3State.stats?.today||0)+Number(v3State.stats?.inbox||0)}</span>`;if(today.innerHTML!==wanted)today.innerHTML=wanted;}
  const inbox=document.querySelector('.nav a[href="#inbox"]');if(inbox&&!inbox.classList.contains('v3-hidden'))inbox.classList.add('v3-hidden');
  const journal=document.querySelector('.nav a[href="#journal"]');if(journal&&journal.textContent!=='≡ 项目现场')journal.textContent='≡ 项目现场';
  const cleanup=document.querySelector('[data-action="toggle-cleanup"]');let media=document.querySelector('.v3-nav-media');
  if(cleanup&&!media){media=document.createElement('a');media.className='v3-nav-media';media.href='#media';media.textContent='◉ 自媒体';cleanup.insertAdjacentElement('beforebegin',media);}
  if(media)media.classList.toggle('active',currentView()==='media');
}
function sourceHtml(state){
  const source=state.config?.dataSource;
  if(!source||source.provider!=='feishu_doc')return `<div class="v3-source"><span class="pill amber">飞书未绑定</span><span>绑定飞书云文档后，待办同步只读取文档里的明确待办，不读取普通日记正文。</span><button class="btn small primary" data-v3-action="settings">去设置</button></div>`;
  const status=source.lastSyncStatus==='ok'?'已同步':source.lastSyncStatus==='error'?'同步失败':'待同步';
  return `<div class="v3-source"><span class="pill blue">飞书待办来源</span><span>${esc(status)} · 最近读回 ${source.lastSyncAt?fmtTime(source.lastSyncAt):'—'}</span>${source.lastSyncError?`<span class="pill red">${esc(source.lastSyncError)}</span>`:''}<button class="btn small primary" data-v3-action="sync-feishu">同步飞书待办</button></div>`;
}
function todoRow(todo,state){
  const inToday=(state.todayPlan||[]).includes(todo.id);
  return `<div class="todo ${todo.done?'done':''}"><button class="check ${todo.done?'checked':''}" data-action="toggle-todo" data-id="${attr(todo.id)}" role="checkbox" aria-checked="${todo.done}" aria-label="${todo.done?'标记为未完成':'标记为已完成'}：${esc(todo.title)}"></button><div class="todo-main"><div class="name">${esc(todo.title)}</div><div class="summary">${esc(todo.context||'')}</div><div class="meta"><span class="pill">截止 ${fmtDate(todo.dueDate)}</span>${todo.project?`<span class="pill blue">${esc(todo.project)}</span>`:'<span class="pill">独立待办</span>'}</div></div><div class="toolbar"><button class="btn small" data-action="edit-todo" data-id="${attr(todo.id)}">编辑</button>${!todo.done?`<button class="btn small ${inToday?'':'primary'}" data-action="today-toggle" data-id="${attr(todo.id)}" data-add="${inToday?'0':'1'}">${inToday?'移出今日':'加入今日'}</button>`:''}</div></div>`;
}
function reviewIsExecutable(item,entry){
  const plan=entry?.plan;if(entry?.reviewKey!==reviewKey(item))return false;
  if(!plan||plan.kind==='clarification'||plan.toolName!=='inbox_process'||plan.confirmationRequired!==true)return false;
  if(plan.args?.itemId!==item.id||typeof plan.args?.command!=='string'||!plan.args.command.trim())return false;
  const command=plan.args.command;if(/新建项目|单独建项目|建项目/.test(command))return false;
  if(/删除|丢弃|不要了/.test(command)&&!/(删除|丢弃|不要了)/.test(item.text))return false;
  return true;
}
function legacyCandidateReviewHtml(){
  return `<div class="v3-ai-review"><div class="v3-ai-label">旧版日记提取候选</div><div class="v3-ai-reason">这条来自旧版“整篇日记提取”流程。请点一次“同步飞书待办”，系统会自动撤下旧候选，只保留飞书云文档中的明确待办。</div></div>`;
}
function reviewHtml(item){
  if(item.source==='feishu_todo_candidate')return legacyCandidateReviewHtml();
  if(item.source==='feishu_doc'&&item.feishuMode==='mixed_diary')return legacyCandidateReviewHtml();
  const entry=inboxPlans.get(item.id);
  if(!entry)return `<div class="v3-ai-review pending"><div class="v3-ai-label">AI 待办建议</div><div class="v3-ai-reason">等待进入有界分析队列…</div></div>`;
  if(entry.status==='pending')return `<div class="v3-ai-review pending"><div class="v3-ai-label">AI 待办建议</div><div class="v3-ai-reason"><span class="v3-loading">正在只围绕这条明确待办生成处理建议…</span></div></div>`;
  if(entry.status==='error')return `<div class="v3-ai-review"><div class="v3-ai-label">分析暂不可用</div><div class="v3-ai-reason">${esc(entry.message||'AI 分析失败，可稍后重试。')}</div><div class="v3-actions"><button class="btn small" data-v3-action="analyze" data-id="${attr(item.id)}">重试分析</button></div></div>`;
  const plan=entry.plan||{};
  if(plan.kind==='clarification'||!plan.toolName)return `<div class="v3-ai-review"><div class="v3-ai-label">需要你决定</div><div class="v3-ai-reason">${esc(plan.messageReply||plan.reason||'现有信息不足以安全处理这条待办。')}</div><div class="v3-actions"><button class="btn small" data-action="open-command" data-id="${attr(item.id)}">补充信息</button><button class="btn small" data-v3-action="analyze" data-id="${attr(item.id)}">重新分析</button></div></div>`;
  const executable=reviewIsExecutable(item,entry);const project=plan.args?.targetProjectId&&v3State?.projects?.find(candidate=>candidate.id===plan.args.targetProjectId);
  return `<div class="v3-ai-review"><div class="v3-ai-label">${plan.planner==='model'?'AI 建议处理':'规则建议处理'} · ${executable?'等你确认':'需要补充确认'}</div><div class="v3-ai-reason">${esc(plan.reason||'根据当前明确待办和项目目录生成建议。')}${project?` · 目标项目：${esc(project.name)}`:''}</div><div class="v3-ai-command">建议动作：${esc(plan.args?.command||plan.toolName)}</div><div class="v3-actions">${executable?`<button class="btn small primary" data-v3-action="confirm-plan" data-id="${attr(item.id)}">确认并处理</button>`:`<button class="btn small primary" data-action="open-command" data-id="${attr(item.id)}">补充信息后处理</button>`}<button class="btn small" data-v3-action="analyze" data-id="${attr(item.id)}">重新分析</button></div>${entry.outcome?`<div class="v3-ai-reason">${esc(entry.outcome)}</div>`:''}</div>`;
}
function sourceLabel(item){
  if(item.source==='feishu_todo')return'飞书待办';
  if(item.source==='feishu_doc')return item.feishuMode==='mixed_diary'?'旧版飞书日记':'飞书待办';
  if(item.source==='feishu_todo_candidate')return'旧版提取候选';
  return item.source||'manual';
}
function inboxItemHtml(item){
  return `<div class="v3-inbox-item" data-v3-id="${attr(item.id)}" data-v3-source="${attr(item.source||'')}" ><div class="v3-item-text">${esc(item.text)}</div><div class="v3-item-meta"><span class="pill">${fmtTime(item.createdAt)}</span><span class="pill blue">${esc(sourceLabel(item))}</span></div>${reviewHtml(item)}<div id="cmd-${attr(item.id)}"></div></div>`;
}
function latestProjectActivity(project,state){
  const activity=(state.activities||[]).find(item=>item.projectId===project.id);if(activity)return`${fmtTime(activity.at)} · ${activity.text}`;
  if(project.progress?.lastActivity)return`最后活动 ${fmtTime(project.progress.lastActivity)}`;return'暂无最近工作现场';
}
function projectLiveHtml(state){
  const projects=(state.projects||[]).filter(project=>!project.archived).sort((a,b)=>String(b.progress?.lastActivity||'').localeCompare(String(a.progress?.lastActivity||'')));
  if(!projects.length)return'<div class="v3-empty">还没有项目。</div>';
  return `<div class="v3-project-live">${projects.map(project=>`<div class="v3-project"><div class="v3-project-top"><div><a class="v3-project-name" href="#project/${routePart(project.id)}">${esc(project.name)}</a><div class="v3-item-meta"><span class="pill">${esc(project.status||project.progress?.status||'未启动')}</span>${project.progress?.hasBlocker?'<span class="pill amber">有卡点</span>':''}</div></div><div class="v3-progress">${Number(project.progress?.percent||0)}%</div></div><div class="v3-project-scene">${esc(latestProjectActivity(project,state))}</div><div class="v3-actions"><a class="btn small" href="#project/${routePart(project.id)}">打开现场</a><button class="btn small" data-action="sync-project" data-id="${attr(project.id)}">刷新进度</button></div></div>`).join('')}</div>`;
}
let calMonth=null,calSelectedDate=null;
function calTodayStr(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function calInit(){if(!calMonth){const d=new Date();calMonth={year:d.getFullYear(),month:d.getMonth()};}if(!calSelectedDate)calSelectedDate=calTodayStr();}
function calKey(year,month,day){return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}
function buildCalItemsMap(state){
  const map=new Map();
  const todayStr=calTodayStr();
  const todaySet=new Set(state.todayPlan||[]);
  for(const t of (state.todos||[])){
    if(!t.dueDate)continue;
    if(!map.has(t.dueDate))map.set(t.dueDate,{todos:[],projects:[]});
    map.get(t.dueDate).todos.push(t);
    if(todaySet.has(t.id)&&t.dueDate!==todayStr){
      if(!map.has(todayStr))map.set(todayStr,{todos:[],projects:[]});
      const todayItems=map.get(todayStr);
      if(!todayItems.todos.find(x=>x.id===t.id))todayItems.todos.push(t);
    }
  }
  for(const p of (state.projects||[])){if(p.archived||!p.endDate)continue;if(!map.has(p.endDate))map.set(p.endDate,{todos:[],projects:[]});map.get(p.endDate).projects.push(p);}
  return map;
}
function calendarHtml(state){
  calInit();const {year,month}=calMonth;const todayStr=calTodayStr();const itemsMap=buildCalItemsMap(state);
  const firstDay=new Date(year,month,1).getDay();const daysInMonth=new Date(year,month+1,0).getDate();
  const offset=(firstDay-1+7)%7;
  const monthNames=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const weekDays=['一','二','三','四','五','六','日'];
  let cells='';
  for(let i=0;i<offset;i++)cells+='<div class="v3-cal-cell empty"></div>';
  for(let d=1;d<=daysInMonth;d++){
    const dateStr=calKey(year,month,d);const items=itemsMap.get(dateStr);
    const isToday=dateStr===todayStr,isSelected=dateStr===calSelectedDate;
    const todoCount=items?items.todos.length:0,projCount=items?items.projects.length:0;
    const hasItems=todoCount+projCount>0;
    const allDone=items&&items.todos.length>0&&items.todos.every(t=>t.done);
    cells+=`<div class="v3-cal-cell${isToday?' today':''}${isSelected?' selected':''}${hasItems?' has-items':''}${allDone?' all-done':''}" data-cal-date="${dateStr}" tabindex="0" role="button" aria-label="${dateStr}${hasItems?`，${todoCount}个待办${projCount?`，${projCount}个项目里程碑`:''}`:''}"><div class="v3-cal-day">${d}</div>`;
    if(hasItems){cells+='<div class="v3-cal-badges">';if(todoCount)cells+=`<span class="v3-cal-badge ${allDone?'done':''}">${todoCount}</span>`;if(projCount)cells+=`<span class="v3-cal-badge project">${projCount}</span>`;cells+='</div>';}
    cells+='</div>';
  }
  return `<div class="v3-calendar"><div class="v3-cal-header"><div class="v3-cal-nav"><button class="btn small" data-cal-nav="prev">‹</button><strong>${year}年 ${monthNames[month]}</strong><button class="btn small" data-cal-nav="next">›</button></div><button class="btn small" data-cal-nav="today">回到今天</button></div><div class="v3-cal-weekdays">${weekDays.map(w=>`<span>${w}</span>`).join('')}</div><div class="v3-cal-grid">${cells}</div></div>`;
}
function calendarDetailHtml(state){
  calInit();const dateStr=calSelectedDate||calTodayStr();
  const items=buildCalItemsMap(state).get(dateStr)||{todos:[],projects:[]};
  const todos=items.todos,projects=items.projects;
  let html=`<div class="v3-cal-detail"><div class="v3-cal-detail-head"><h3>${dateStr.replace(/-/g,' / ')}</h3>`;
  if(!todos.length&&!projects.length)html+=`<span class="v3-cal-detail-empty">这一天没有带截止日期的待办或项目里程碑。</span>`;
  else html+=`<span class="v3-cal-detail-count">${todos.length} 个待办 · ${projects.length} 个项目里程碑</span>`;
  html+=`</div>`;
  for(const t of todos){
    const inToday=(state.todayPlan||[]).includes(t.id);
    html+=`<div class="v3-cal-item todo ${t.done?'done':''}"><button class="check ${t.done?'checked':''}" data-action="toggle-todo" data-id="${attr(t.id)}" role="checkbox" aria-checked="${t.done}" aria-label="${t.done?'标记为未完成':'标记为已完成'}：${esc(t.title)}"></button><div class="v3-cal-item-main"><div class="v3-cal-item-title">${esc(t.title)}</div><div class="v3-cal-item-meta">${t.project?`<span class="pill blue">${esc(t.project)}</span>`:'<span class="pill">独立待办</span>'}</div></div><div class="toolbar"><button class="btn small" data-action="edit-todo" data-id="${attr(t.id)}">编辑</button>${!t.done?`<button class="btn small ${inToday?'':'primary'}" data-action="today-toggle" data-id="${attr(t.id)}" data-add="${inToday?'0':'1'}">${inToday?'移出今日':'加入今日'}</button>`:''}</div></div>`;
  }
  for(const p of projects){
    const percent=Math.max(0,Math.min(100,Math.round(Number(p.progress?.percent||0))));
    html+=`<a class="v3-cal-item project" href="#project/${routePart(p.id)}"><div class="mini-ring" style="--p:${percent}"><span>${percent}%</span></div><div class="v3-cal-item-main"><div class="v3-cal-item-title">${esc(p.name)}</div><div class="v3-cal-item-meta"><span class="pill">计划结束</span>${p.progress?.hasBlocker?'<span class="pill amber">有卡点</span>':''}</div></div></a>`;
  }
  html+=`</div>`;
  return html;
}
function renderCalendar(){const wrap=document.querySelector('.v3-calendar-wrap');if(wrap&&v3State)wrap.innerHTML=calendarHtml(v3State)+calendarDetailHtml(v3State);}
function handleCalNav(dir){
  calInit();
  if(dir==='prev'){calMonth.month--;if(calMonth.month<0){calMonth.month=11;calMonth.year--;}}
  else if(dir==='next'){calMonth.month++;if(calMonth.month>11){calMonth.month=0;calMonth.year++;}}
  else if(dir==='today'){const d=new Date();calMonth={year:d.getFullYear(),month:d.getMonth()};calSelectedDate=calTodayStr();}
  renderCalendar();
}
function handleCalSelect(dateStr){calSelectedDate=dateStr;renderCalendar();}

function dashboardHtml(state){
  const today=state.todayTodos||[],inbox=state.inbox||[];
  const aiPending=inbox.filter(item=>item.source==='feishu_todo'&&!inboxPlans.has(item.id)).length+autoAnalyzeQueue.length+autoAnalyzeActive;
  const attention=Number(state.stats?.confirmations||0)+Number(state.stats?.overdue||0)+Number(state.stats?.unclassified||0);
  return `<div id="v3-dashboard" class="v3-dashboard" data-signature="${attr(stateSignature(state))}"><div class="v3-hero"><div class="v3-metric"><strong>${today.length}</strong><span>今天要做</span></div><div class="v3-metric"><strong>${inbox.length}</strong><span>待办待处理</span></div><div class="v3-metric"><strong>${aiPending}</strong><span>AI 建议中</span></div><div class="v3-metric"><strong>${attention}</strong><span>需要留意</span></div></div><section class="v3-card v3-calendar-card"><div class="v3-card-head"><div><h2>月度日历工作台</h2><p>带截止日期的待办和项目结束日期自动出现在日历上；点击日期查看详情。</p></div></div><div class="v3-calendar-wrap">${calendarHtml(state)}${calendarDetailHtml(state)}</div></section><section class="v3-card"><div class="v3-card-head"><div><h2>飞书待办 · AI 处理队列</h2><p>只同步飞书云文档中的明确待办；普通日记、复盘、分析和项目进展不会进入这里。</p></div></div>${sourceHtml(state)}${inbox.length?inbox.map(inboxItemHtml).join(''):'<div class="v3-empty">没有待处理的飞书待办。</div>'}</section></div>`;
}
// hideLegacyMain and setTop are now provided by window.WB
function enhanceToday(){
  if(!v3State)return;const main=document.querySelector('.main');if(!main)return;setTop('首页','月度日历工作台 · 飞书待办同步 · 今天做什么仍由你确认。');hideLegacyMain(main,true);
  const signature=stateSignature(v3State);let dashboard=main.querySelector('#v3-dashboard');if(dashboard?.dataset.signature===signature)return;dashboard?.remove();
  const holder=document.createElement('div');holder.innerHTML=dashboardHtml(v3State);dashboard=holder.firstElementChild;const capture=main.querySelector('.capture');if(capture)capture.insertAdjacentElement('afterend',dashboard);else main.prepend(dashboard);
}
function scenePageHtml(state){
  const global=(state.activities||[]).filter(item=>!item.projectId).slice(0,12);
  return `<div id="v3-scene" class="v3-dashboard" data-signature="${attr(stateSignature(state))}"><section class="v3-card"><div class="v3-card-head"><div><h2>项目现场与进度</h2><p>项目最近发生了什么、做到多少、有没有卡点，在同一张卡里恢复上下文。</p></div><button class="btn small" data-action="sync-all">同步所有项目</button></div>${projectLiveHtml(state)}</section><section class="v3-card"><div class="v3-card-head"><div><h2>其他最近工作动作</h2><p>不属于具体项目的采集、收件箱和系统动作。</p></div></div>${global.length?global.map(item=>`<div class="activity"><div class="time">${fmtTime(item.at)}</div><div class="text">${esc(item.text)}</div></div>`).join(''):'<div class="v3-empty">暂无其他工作动作。</div>'}</section></div>`;
}
function enhanceScene(){if(!v3State)return;const main=document.querySelector('.main');if(!main)return;setTop('项目现场','最近工作现场与项目进度已经合并。');hideLegacyMain(main,true);const signature=stateSignature(v3State);let node=main.querySelector('#v3-scene');if(node?.dataset.signature===signature)return;node?.remove();const holder=document.createElement('div');holder.innerHTML=scenePageHtml(v3State);const scene=holder.firstElementChild;const capture=main.querySelector('.capture');if(capture)capture.insertAdjacentElement('afterend',scene);else main.prepend(scene);}
function rewriteTaskSyncButton(){if(currentView()!=='tasks')return;for(const button of document.querySelectorAll('[data-action="sync-feishu"]')){if(button.textContent!=='同步飞书待办')button.textContent='同步飞书待办';button.title='只读取飞书云文档中的明确待办，不读取普通日记正文。';}}
let enhanceDispatched=false;
function renderEnhancements(){if(rendering)return;rendering=true;try{enhanceSidebar();const view=currentView();if(view==='today')enhanceToday();else if(view==='journal')enhanceScene();rewriteTaskSyncButton();}finally{rendering=false;}if(!enhanceDispatched){enhanceDispatched=true;requestAnimationFrame(()=>{enhanceDispatched=false;window.dispatchEvent(new CustomEvent('workbench:enhance'));});}}

function acceptedPlan(item,plan){
  if(!plan||plan.kind==='clarification')return plan;
  if(plan.toolName!=='inbox_process'||plan.args?.itemId!==item.id)return {...plan,kind:'clarification',toolName:null,messageReply:'AI 没有形成针对这条明确待办的安全处理动作，请你决定。'};
  if(/删除|丢弃|不要了/.test(String(plan.args?.command||''))&&!/(删除|丢弃|不要了)/.test(item.text))return {...plan,kind:'clarification',toolName:null,messageReply:'AI 曾提出删除，但原始待办没有明确删除意图，我已阻止这个建议。'};
  return plan;
}
async function analyzeItem(item,{force=false}={}){
  const key=reviewKey(item);
  if(item.source!=='feishu_todo')return;
  if(!v3State?.aiEnabled){inboxPlans.set(item.id,{status:'error',reviewKey:key,message:'当前没有启用 AI Provider；你仍可以手工处理这条飞书待办。'});planVersion+=1;renderEnhancements();return;}
  const existing=inboxPlans.get(item.id);if(existing?.reviewKey===key&&!force)return;
  inboxPlans.set(item.id,{status:'pending',reviewKey:key});planVersion+=1;renderEnhancements();
  try{
    const message=`当前这条内容已经是飞书明确待办。只分析如何处理它，不要从其他日记提取任务：itemId=${item.id}；原文=${JSON.stringify(item.text)}。缺截止日期或项目不唯一时返回 clarification；不得自动加入 Today，不得自动创建项目。`;
    const response=await json('/api/ai/plan',{method:'POST',body:JSON.stringify({message,view:'inbox-review',id:item.id})});
    const plan=acceptedPlan(item,response.plan||{});
    inboxPlans.set(item.id,{status:'ready',reviewKey:key,plan,cachedAt:Date.now()});persistReviewCache();
  }catch(error){inboxPlans.set(item.id,{status:'error',reviewKey:key,message:error.message});persistReviewCache();}
  planVersion+=1;renderEnhancements();
}
function pumpAutoAnalyzeQueue(){
  while(autoAnalyzeActive<AUTO_ANALYZE_CONCURRENCY&&autoAnalyzeQueue.length){
    const queued=autoAnalyzeQueue.shift();queuedIds.delete(queued.id);const current=v3State?.inbox?.find(item=>item.id===queued.id);
    if(!current||reviewKey(current)!==queued.reviewKey)continue;const existing=inboxPlans.get(current.id);if(existing?.reviewKey===queued.reviewKey)continue;
    autoAnalyzeActive+=1;void analyzeItem(current).finally(()=>{autoAnalyzeActive-=1;pumpAutoAnalyzeQueue();void autoAnalyze();});
  }
}
async function autoAnalyze(){
  if(!v3State||currentView()!=='today')return;const items=(v3State.inbox||[]).filter(item=>item.source==='feishu_todo');
  for(const item of items){if(autoAnalyzeQueue.length>=AUTO_ANALYZE_QUEUE_LIMIT)break;const key=reviewKey(item),existing=inboxPlans.get(item.id);if(existing?.reviewKey===key||queuedIds.has(item.id))continue;autoAnalyzeQueue.push({id:item.id,reviewKey:key});queuedIds.add(item.id);}
  pumpAutoAnalyzeQueue();
}
async function confirmPlan(itemId){
  const entry=inboxPlans.get(itemId),item=v3State?.inbox?.find(candidate=>candidate.id===itemId);if(!item||!reviewIsExecutable(item,entry))return notify('这条建议还不能安全执行，请先补充信息。',true);
  inboxPlans.set(itemId,{...entry,status:'pending'});planVersion+=1;renderEnhancements();
  try{
    const executed=await json('/api/ai/execute',{method:'POST',body:JSON.stringify({planId:entry.plan.id,confirmed:true})});const result=executed.result||{};
    if(result.needsProjectCreation||result.needsProjectSelection||result.needsFollowup){inboxPlans.set(itemId,{status:'ready',reviewKey:entry.reviewKey,plan:{...entry.plan,kind:'clarification',toolName:null,messageReply:result.question||'这一步还需要你补充项目或日期信息。'},outcome:result.question||'需要补充信息',cachedAt:Date.now()});persistReviewCache();planVersion+=1;renderEnhancements();return;}
    notify(result.message||'已按确认的 AI 建议处理');inboxPlans.delete(itemId);persistReviewCache();planVersion+=1;await refresh(true);
  }catch(error){if(/过期/.test(error.message))inboxPlans.delete(itemId);else inboxPlans.set(itemId,{...entry,status:'error',message:error.message});persistReviewCache();planVersion+=1;renderEnhancements();notify(error.message,true);}
}
async function syncFeishu(target){
  if(!v3State?.config?.dataSource){document.querySelector('[data-action="settings"]')?.click();return;}target.disabled=true;target.textContent='同步待办中…';
  try{
    const response=await json('/api/inbox/sync',{method:'POST',body:'{}'});planVersion+=1;await refresh(true);
    const cleaned=Number(response.sync?.cleanedLegacy||0);
    notify(`飞书待办已同步：新增 ${response.sync?.imported||0}${cleaned?`，自动撤下旧版日记项 ${cleaned}`:''}。普通日记未进入待办同步。`);
  }catch(error){notify(error.message,true);target.disabled=false;target.textContent='同步飞书待办';}
}
async function handleV3Action(event,target){
  const action=target.dataset.v3Action;
  if(action==='settings'){event.preventDefault();document.querySelector('[data-action="settings"]')?.click();return;}
  if(action==='sync-feishu'){event.preventDefault();await syncFeishu(target);return;}
  if(action==='analyze'){event.preventDefault();const item=v3State?.inbox?.find(candidate=>candidate.id===target.dataset.id);if(item)await analyzeItem(item,{force:true});return;}
  if(action==='confirm-plan'){event.preventDefault();await confirmPlan(target.dataset.id);}
}
document.addEventListener('click',event=>{
  const calNav=event.target.closest?.('[data-cal-nav]');
  if(calNav){event.preventDefault();handleCalNav(calNav.dataset.calNav);return;}
  const calCell=event.target.closest?.('[data-cal-date]');
  if(calCell){event.preventDefault();handleCalSelect(calCell.dataset.calDate);return;}
  const target=event.target.closest?.('[data-v3-action]');
  if(target)void handleV3Action(event,target);
},true);
document.addEventListener('keydown',event=>{
  if((event.key==='Enter'||event.key===' ')&&event.target?.dataset?.calDate){event.preventDefault();handleCalSelect(event.target.dataset.calDate);}
});
// Render dispatch — exposed for app.js direct calls
window.WB.renderToday=enhanceToday;
window.WB.renderScene=enhanceScene;
window.WB.v3Refresh=()=>void refresh(true);

window.addEventListener('hashchange',()=>{schedule();void refresh(true);});
window.addEventListener('workbench:enhance',schedule);
function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;renderEnhancements();void refresh();});}
loadReviewCache();void refresh(true);
