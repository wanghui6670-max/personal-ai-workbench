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

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const attr=esc;
const routePart=value=>encodeURIComponent(String(value??''));
const fmtDate=value=>value?new Date(`${value}T00:00:00`).toLocaleDateString('zh-CN',{month:'short',day:'numeric'}):'—';
const fmtTime=value=>value?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';

async function json(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||data.question||`请求失败 ${response.status}`);
  return data;
}

function currentView(){return (location.hash||'#today').slice(1).split('/')[0]||'today';}
function notify(message,error=false){
  const toast=document.querySelector('#toast');
  if(!toast)return;
  toast.textContent=message;toast.className=`toast show${error?' error':''}`;
  clearTimeout(toast._v3Timer);toast._v3Timer=setTimeout(()=>toast.className='toast',3000);
}
function stateSignature(state){
  return JSON.stringify({
    today:state?.todayPlan||[],inbox:(state?.inbox||[]).map(item=>[item.id,item.text,item.source]),
    projects:(state?.projects||[]).map(project=>[project.id,project.progress?.percent,project.progress?.lastActivity,project.completed,project.archived]),
    confirmations:(state?.confirmations||[]).map(item=>item.id),sync:state?.config?.dataSource?.lastSyncAt||null,
    plans:planVersion
  });
}
function reviewKey(item){return JSON.stringify([item?.id||'',item?.text||'',item?.source||'',item?.createdAt||'']);}
function loadReviewCache(){
  try{
    const raw=JSON.parse(sessionStorage.getItem(REVIEW_CACHE_KEY)||'[]');
    const now=Date.now();
    if(!Array.isArray(raw))return;
    for(const entry of raw){
      if(!entry||typeof entry.id!=='string'||typeof entry.reviewKey!=='string'||!entry.plan||!Number.isFinite(entry.cachedAt))continue;
      if(now-entry.cachedAt>REVIEW_CACHE_MAX_AGE_MS)continue;
      inboxPlans.set(entry.id,{status:'ready',reviewKey:entry.reviewKey,plan:entry.plan,cachedAt:entry.cachedAt});
    }
  }catch{}
}
function persistReviewCache(){
  try{
    const now=Date.now();
    const safe=[];
    for(const [id,entry] of inboxPlans){
      if(entry?.status!=='ready'||!entry.plan||typeof entry.reviewKey!=='string')continue;
      const cachedAt=Number(entry.cachedAt||now);if(now-cachedAt>REVIEW_CACHE_MAX_AGE_MS)continue;
      safe.push({id,reviewKey:entry.reviewKey,plan:entry.plan,cachedAt});
      if(safe.length>=100)break;
    }
    sessionStorage.setItem(REVIEW_CACHE_KEY,JSON.stringify(safe));
  }catch{}
}
function reconcileReviewCache(){
  if(!v3State)return;
  const items=new Map((v3State.inbox||[]).map(item=>[item.id,item]));
  let changed=false;
  for(const [id,entry] of inboxPlans){
    const item=items.get(id);
    if(!item||entry.reviewKey!==reviewKey(item)){inboxPlans.delete(id);changed=true;}
  }
  if(changed)persistReviewCache();
}

async function refresh(force=false){
  if(refreshPromise&&!force)return refreshPromise;
  refreshPromise=json('/api/state').then(state=>{v3State=state;reconcileReviewCache();renderEnhancements();void autoAnalyze();return state;}).finally(()=>{refreshPromise=null;});
  return refreshPromise;
}

function enhanceSidebar(){
  const today=document.querySelector('.nav a[href="#today"]');
  if(today&&v3State){today.innerHTML=`⌂ 今日与收件箱<span class="count">${Number(v3State.stats?.today||0)+Number(v3State.stats?.inbox||0)}</span>`;}
  const inbox=document.querySelector('.nav a[href="#inbox"]');if(inbox)inbox.classList.add('v3-hidden');
  const journal=document.querySelector('.nav a[href="#journal"]');if(journal)journal.textContent='≡ 项目现场';
  const cleanup=document.querySelector('[data-action="toggle-cleanup"]');
  if(cleanup&&!document.querySelector('.v3-nav-media')){
    const link=document.createElement('a');link.className=`v3-nav-media${currentView()==='media'?' active':''}`;link.href='#media';link.innerHTML='◉ 自媒体';cleanup.insertAdjacentElement('beforebegin',link);
  }
}

function sourceHtml(state){
  const source=state.config?.dataSource;
  if(!source||source.provider!=='feishu_doc')return `<div class="v3-source"><span class="pill amber">飞书未绑定</span><span>主同步入口尚未配置。绑定飞书云文档后，工作台只读取“收件箱”章节的 <code>[INBOX]</code> 条目。</span><button class="btn small primary" data-v3-action="settings">去设置</button></div>`;
  const status=source.lastSyncStatus==='ok'?'已同步':source.lastSyncStatus==='error'?'同步失败':'待同步';
  return `<div class="v3-source"><span class="pill blue">飞书主来源</span><span>${esc(status)} · 最近读回 ${source.lastSyncAt?fmtTime(source.lastSyncAt):'—'}</span>${source.lastSyncError?`<span class="pill red">${esc(source.lastSyncError)}</span>`:''}<button class="btn small primary" data-v3-action="sync-feishu">同步飞书并自动分析</button></div>`;
}

function todoRow(todo,state){
  const inToday=(state.todayPlan||[]).includes(todo.id);
  return `<div class="todo ${todo.done?'done':''}"><button class="check ${todo.done?'checked':''}" data-action="toggle-todo" data-id="${attr(todo.id)}" title="完成/恢复"></button><div class="todo-main"><div class="name">${esc(todo.title)}</div><div class="summary">${esc(todo.context||'')}</div><div class="meta"><span class="pill">截止 ${fmtDate(todo.dueDate)}</span>${todo.project?`<span class="pill blue">${esc(todo.project)}</span>`:'<span class="pill">独立待办</span>'}</div></div><div class="toolbar"><button class="btn small" data-action="edit-todo" data-id="${attr(todo.id)}">编辑</button>${!todo.done?`<button class="btn small ${inToday?'':'primary'}" data-action="today-toggle" data-id="${attr(todo.id)}" data-add="${inToday?'0':'1'}">${inToday?'移出今日':'加入今日'}</button>`:''}</div></div>`;
}

function reviewIsExecutable(item,entry){
  const plan=entry?.plan;
  if(entry?.reviewKey!==reviewKey(item))return false;
  if(!plan||plan.kind==='clarification'||plan.toolName!=='inbox_process'||plan.confirmationRequired!==true)return false;
  if(plan.args?.itemId!==item.id||typeof plan.args?.command!=='string'||!plan.args.command.trim())return false;
  const command=plan.args.command;
  if(/新建项目|单独建项目|建项目/.test(command))return false;
  if(/删除|丢弃|不要了/.test(command)&&!/(删除|丢弃|不要了)/.test(item.text))return false;
  return true;
}
function reviewHtml(item){
  const entry=inboxPlans.get(item.id);
  if(!entry)return `<div class="v3-ai-review pending"><div class="v3-ai-label">AI 自动分析</div><div class="v3-ai-reason">等待进入有界分析队列…</div></div>`;
  if(entry.status==='pending')return `<div class="v3-ai-review pending"><div class="v3-ai-label">AI 自动分析</div><div class="v3-ai-reason"><span class="v3-loading">正在用“当前事项 + 项目目录摘要”的最小上下文生成建议…</span></div></div>`;
  if(entry.status==='error')return `<div class="v3-ai-review"><div class="v3-ai-label">分析暂不可用</div><div class="v3-ai-reason">${esc(entry.message||'AI 分析失败，可改用手工处理。')}</div><div class="v3-actions"><button class="btn small" data-v3-action="analyze" data-id="${attr(item.id)}">重试分析</button></div></div>`;
  const plan=entry.plan||{};
  if(plan.kind==='clarification'||!plan.toolName)return `<div class="v3-ai-review"><div class="v3-ai-label">需要你决定</div><div class="v3-ai-reason">${esc(plan.messageReply||plan.reason||'现有信息不足以安全决定处理方式。')}</div><div class="v3-actions"><button class="btn small" data-action="open-command" data-id="${attr(item.id)}">告诉 AI 怎么处理</button><button class="btn small" data-v3-action="analyze" data-id="${attr(item.id)}">重新分析</button></div></div>`;
  const executable=reviewIsExecutable(item,entry);
  const project=plan.args?.targetProjectId&&v3State?.projects?.find(candidate=>candidate.id===plan.args.targetProjectId);
  return `<div class="v3-ai-review"><div class="v3-ai-label">${plan.planner==='model'?'AI 建议处理':'规则建议处理'} · ${executable?'等你确认':'需要补充确认'}</div><div class="v3-ai-reason">${esc(plan.reason||'根据当前工作台上下文生成建议。')}${project?` · 目标项目：${esc(project.name)}`:''}</div><div class="v3-ai-command">建议动作：${esc(plan.args?.command||plan.toolName)}</div><div class="v3-actions">${executable?`<button class="btn small primary" data-v3-action="confirm-plan" data-id="${attr(item.id)}">确认并处理</button>`:`<button class="btn small primary" data-action="open-command" data-id="${attr(item.id)}">补充信息后处理</button>`}<button class="btn small" data-v3-action="analyze" data-id="${attr(item.id)}">重新分析</button></div>${entry.outcome?`<div class="v3-ai-reason">${esc(entry.outcome)}</div>`:''}</div>`;
}

function inboxItemHtml(item){
  return `<div class="v3-inbox-item"><div class="v3-item-text">${esc(item.text)}</div><div class="v3-item-meta"><span class="pill">${fmtTime(item.createdAt)}</span><span class="pill blue">${item.source==='feishu_doc'?'飞书同步':esc(item.source||'manual')}</span></div>${reviewHtml(item)}<div id="cmd-${attr(item.id)}"></div></div>`;
}

function latestProjectActivity(project,state){
  const activity=(state.activities||[]).find(item=>item.projectId===project.id);
  if(activity)return`${fmtTime(activity.at)} · ${activity.text}`;
  if(project.progress?.lastActivity)return`最后活动 ${fmtTime(project.progress.lastActivity)}`;
  return'暂无最近工作现场';
}
function projectLiveHtml(state){
  const projects=(state.projects||[]).filter(project=>!project.archived).sort((a,b)=>String(b.progress?.lastActivity||'').localeCompare(String(a.progress?.lastActivity||'')));
  if(!projects.length)return'<div class="v3-empty">还没有项目。</div>';
  return `<div class="v3-project-live">${projects.map(project=>`<div class="v3-project"><div class="v3-project-top"><div><a class="v3-project-name" href="#project/${routePart(project.id)}">${esc(project.name)}</a><div class="v3-item-meta"><span class="pill">${esc(project.status||project.progress?.status||'未启动')}</span>${project.progress?.hasBlocker?'<span class="pill amber">有卡点</span>':''}</div></div><div class="v3-progress">${Number(project.progress?.percent||0)}%</div></div><div class="v3-project-scene">${esc(latestProjectActivity(project,state))}</div><div class="v3-actions"><a class="btn small" href="#project/${routePart(project.id)}">打开现场</a><button class="btn small" data-action="sync-project" data-id="${attr(project.id)}">刷新进度</button></div></div>`).join('')}</div>`;
}

function dashboardHtml(state){
  const today=state.todayTodos||[];
  const inbox=state.inbox||[];
  const aiPending=inbox.filter(item=>item.source==='feishu_doc'&&!inboxPlans.has(item.id)).length+autoAnalyzeQueue.length+autoAnalyzeActive;
  const attention=Number(state.stats?.confirmations||0)+Number(state.stats?.overdue||0)+Number(state.stats?.unclassified||0);
  return `<div id="v3-dashboard" class="v3-dashboard" data-signature="${attr(stateSignature(state))}"><div class="v3-hero"><div class="v3-metric"><strong>${today.length}</strong><span>今天明确要做</span></div><div class="v3-metric"><strong>${inbox.length}</strong><span>收件箱待处理</span></div><div class="v3-metric"><strong>${aiPending}</strong><span>AI 自动分析队列</span></div><div class="v3-metric"><strong>${attention}</strong><span>需要你拍板/留意</span></div></div><div class="v3-grid"><section class="v3-card"><div class="v3-card-head"><div><h2>今天要做什么</h2><p>Today 仍然只接受你明确确认的任务；AI 可以建议，但不会自动加入。</p></div></div>${today.length?today.map(todo=>todoRow(todo,state)).join(''):'<div class="v3-empty">今天还没有明确安排的任务。</div>'}</section><section class="v3-card"><div class="v3-card-head"><div><h2>需要你决定的事</h2><p>AI 建议、逾期、待归类和其他人工确认统一看这里。</p></div></div><div class="v3-attention"><a class="pill amber" href="#confirm">待确认 ${state.stats?.confirmations||0}</a><a class="pill red" href="#overdue">逾期 ${state.stats?.overdue||0}</a><a class="pill" href="#unclassified">待归类 ${state.stats?.unclassified||0}</a></div><div class="v3-notice" style="margin-top:12px">AI 的职责是先分析并给出一个可审计建议；任何会改变工作台的动作，仍然要你点“确认并处理”。</div></section></div><section class="v3-card"><div class="v3-card-head"><div><h2>飞书收件箱 · AI 处理队列</h2><p>飞书云文档是主同步入口。同步后按最多 2 条并发的有界队列自动分析；分析不等于执行。</p></div></div>${sourceHtml(state)}${inbox.length?inbox.map(inboxItemHtml).join(''):'<div class="v3-empty">收件箱为空。</div>'}</section><section class="v3-card"><div class="v3-card-head"><div><h2>项目现场与进度</h2><p>把“最近工作现场”和“项目进度”合并：每个项目直接看进度、最后活动和卡点。</p></div><button class="btn small" data-action="sync-all">同步所有项目</button></div>${projectLiveHtml(state)}</section></div>`;
}

function hideLegacyMain(main,keepCapture=true){
  for(const child of [...main.children]){
    if(child.id==='v3-dashboard'||child.id==='v3-scene'||child.id==='v3-media-page')continue;
    if(keepCapture&&child.classList.contains('capture')){child.classList.remove('v3-hidden');continue;}
    child.classList.add('v3-hidden');
  }
}
function setTop(title,desc){
  const h=document.querySelector('.top-left h1');if(h)h.textContent=title;
  const p=document.querySelector('.top-left p');if(p)p.textContent=desc;
}

function enhanceToday(){
  if(!v3State)return;
  const main=document.querySelector('.main');if(!main)return;
  setTop('今日与收件箱','今天做什么、需要你决定什么、AI 建议怎么处理，都在一个工作面。');
  hideLegacyMain(main,true);
  const signature=stateSignature(v3State);
  let dashboard=main.querySelector('#v3-dashboard');
  if(dashboard?.dataset.signature===signature)return;
  dashboard?.remove();
  const holder=document.createElement('div');holder.innerHTML=dashboardHtml(v3State);dashboard=holder.firstElementChild;
  const capture=main.querySelector('.capture');if(capture)capture.insertAdjacentElement('afterend',dashboard);else main.prepend(dashboard);
}

function scenePageHtml(state){
  const global=(state.activities||[]).filter(item=>!item.projectId).slice(0,12);
  return `<div id="v3-scene" class="v3-dashboard" data-signature="${attr(stateSignature(state))}"><section class="v3-card"><div class="v3-card-head"><div><h2>项目现场与进度</h2><p>项目最近发生了什么、做到多少、有没有卡点，在同一张卡里恢复上下文。</p></div><button class="btn small" data-action="sync-all">同步所有项目</button></div>${projectLiveHtml(state)}</section><section class="v3-card"><div class="v3-card-head"><div><h2>其他最近工作动作</h2><p>不属于具体项目的采集、收件箱和系统动作。</p></div></div>${global.length?global.map(item=>`<div class="activity"><div class="time">${fmtTime(item.at)}</div><div class="text">${esc(item.text)}</div></div>`).join(''):'<div class="v3-empty">暂无其他工作动作。</div>'}</section></div>`;
}
function enhanceScene(){
  if(!v3State)return;const main=document.querySelector('.main');if(!main)return;
  setTop('项目现场','最近工作现场与项目进度已经合并。');hideLegacyMain(main,true);
  const signature=stateSignature(v3State);let node=main.querySelector('#v3-scene');if(node?.dataset.signature===signature)return;node?.remove();
  const holder=document.createElement('div');holder.innerHTML=scenePageHtml(v3State);const scene=holder.firstElementChild;const capture=main.querySelector('.capture');if(capture)capture.insertAdjacentElement('afterend',scene);else main.prepend(scene);
}

function rewriteTaskSyncButton(){
  if(currentView()!=='tasks')return;
  for(const button of document.querySelectorAll('[data-action="sync-feishu"]')){button.textContent='同步飞书收件箱';button.title='读回飞书云文档收件箱；得到大脑不再作为主待办来源';}
}

function renderEnhancements(){
  if(rendering)return;rendering=true;
  try{
    enhanceSidebar();
    const view=currentView();
    if(view==='today')enhanceToday();
    else if(view==='journal')enhanceScene();
    rewriteTaskSyncButton();
  }finally{rendering=false;}
}

function acceptedPlan(item,plan){
  if(!plan||plan.kind==='clarification')return plan;
  if(plan.toolName!=='inbox_process'||plan.args?.itemId!==item.id){
    return {...plan,kind:'clarification',toolName:null,messageReply:'AI 没有形成针对这条收件箱事项的唯一安全处理动作，请你决定。'};
  }
  if(/删除|丢弃|不要了/.test(String(plan.args?.command||''))&&!/(删除|丢弃|不要了)/.test(item.text)){
    return {...plan,kind:'clarification',toolName:null,messageReply:'AI 曾提出删除，但原始信息没有明确删除意图，我已阻止这个建议。请你决定。'};
  }
  return plan;
}
async function analyzeItem(item,{force=false}={}){
  const key=reviewKey(item);
  if(!v3State?.aiEnabled){inboxPlans.set(item.id,{status:'error',reviewKey:key,message:'当前没有启用 AI Provider；可以使用手工处理，或配置 AI 后重新分析。'});planVersion+=1;renderEnhancements();return;}
  const existing=inboxPlans.get(item.id);if(existing?.reviewKey===key&&!force)return;
  inboxPlans.set(item.id,{status:'pending',reviewKey:key});planVersion+=1;renderEnhancements();
  try{
    const message=`只分析这一条飞书收件箱事项并提出一个处理建议，不要执行：itemId=${item.id}；原文=${JSON.stringify(item.text)}。优先使用 inbox_process；如果缺少截止日期、项目归属不明确、需要新建项目或无法唯一判断，就返回 clarification。不得自动加入 Today，不得自动创建项目，不得因为猜测而删除。`;
    const response=await json('/api/ai/plan',{method:'POST',body:JSON.stringify({message,view:'inbox-review',id:item.id})});
    const plan=acceptedPlan(item,response.plan||{});inboxPlans.set(item.id,{status:'ready',reviewKey:key,plan,cachedAt:Date.now()});persistReviewCache();
  }catch(error){inboxPlans.set(item.id,{status:'error',reviewKey:key,message:error.message});persistReviewCache();}
  planVersion+=1;renderEnhancements();
}
function pumpAutoAnalyzeQueue(){
  while(autoAnalyzeActive<AUTO_ANALYZE_CONCURRENCY&&autoAnalyzeQueue.length){
    const queued=autoAnalyzeQueue.shift();queuedIds.delete(queued.id);
    const current=v3State?.inbox?.find(item=>item.id===queued.id);
    if(!current||reviewKey(current)!==queued.reviewKey)continue;
    const existing=inboxPlans.get(current.id);if(existing?.reviewKey===queued.reviewKey)continue;
    autoAnalyzeActive+=1;
    void analyzeItem(current).finally(()=>{autoAnalyzeActive-=1;pumpAutoAnalyzeQueue();void autoAnalyze();});
  }
}
async function autoAnalyze(){
  if(!v3State||currentView()!=='today')return;
  const items=(v3State.inbox||[]).filter(item=>item.source==='feishu_doc');
  for(const item of items){
    if(autoAnalyzeQueue.length>=AUTO_ANALYZE_QUEUE_LIMIT)break;
    const key=reviewKey(item);const existing=inboxPlans.get(item.id);
    if(existing?.reviewKey===key||queuedIds.has(item.id))continue;
    autoAnalyzeQueue.push({id:item.id,reviewKey:key});queuedIds.add(item.id);
  }
  pumpAutoAnalyzeQueue();
}
async function confirmPlan(itemId){
  const entry=inboxPlans.get(itemId);const item=v3State?.inbox?.find(candidate=>candidate.id===itemId);
  if(!item||!reviewIsExecutable(item,entry))return notify('这条建议还不能安全执行，请先补充信息。',true);
  inboxPlans.set(itemId,{...entry,status:'pending'});planVersion+=1;renderEnhancements();
  try{
    const executed=await json('/api/ai/execute',{method:'POST',body:JSON.stringify({planId:entry.plan.id,confirmed:true})});
    const result=executed.result||{};
    if(result.needsProjectCreation||result.needsProjectSelection||result.needsFollowup){
      inboxPlans.set(itemId,{status:'ready',reviewKey:entry.reviewKey,plan:{...entry.plan,kind:'clarification',toolName:null,messageReply:result.question||'这一步还需要你补充项目或日期信息。'},outcome:result.question||'需要补充信息',cachedAt:Date.now()});
      persistReviewCache();planVersion+=1;renderEnhancements();return;
    }
    notify(result.message||'已按确认的 AI 建议处理');inboxPlans.delete(itemId);persistReviewCache();planVersion+=1;await refresh(true);
  }catch(error){
    if(/过期/.test(error.message))inboxPlans.delete(itemId);else inboxPlans.set(itemId,{...entry,status:'error',message:error.message});
    persistReviewCache();planVersion+=1;renderEnhancements();notify(error.message,true);
  }
}
async function syncFeishu(target){
  if(!v3State?.config?.dataSource){document.querySelector('[data-action="settings"]')?.click();return;}
  target.disabled=true;target.textContent='同步并分析中…';
  try{
    const response=await json('/api/inbox/sync',{method:'POST',body:'{}'});planVersion+=1;
    await refresh(true);notify(`飞书已同步：新增 ${response.sync?.imported||0}，更新 ${response.sync?.updated||0}，移除 ${response.sync?.removed||0}；AI 已进入有界分析队列。`);
  }catch(error){notify(error.message,true);target.disabled=false;target.textContent='同步飞书并自动分析';}
}

async function handleV3Action(event,target){
  const action=target.dataset.v3Action;
  if(action==='settings'){event.preventDefault();document.querySelector('[data-action="settings"]')?.click();return;}
  if(action==='sync-feishu'){event.preventDefault();await syncFeishu(target);return;}
  if(action==='analyze'){event.preventDefault();const item=v3State?.inbox?.find(candidate=>candidate.id===target.dataset.id);if(item)await analyzeItem(item,{force:true});return;}
  if(action==='confirm-plan'){event.preventDefault();await confirmPlan(target.dataset.id);}
}

document.addEventListener('click',event=>{const target=event.target.closest?.('[data-v3-action]');if(target)void handleV3Action(event,target);},true);
window.addEventListener('hashchange',()=>{if(currentView()==='inbox'){location.hash='#today';return;}schedule();void refresh(true);});
new MutationObserver(schedule).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;renderEnhancements();});}
loadReviewCache();
if(currentView()==='inbox')location.hash='#today';
void refresh(true);
