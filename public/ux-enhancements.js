const nativeFetch=window.fetch.bind(window);
const PANEL_MODE_KEY='personal-ai-workbench.ai-panel-mode';
const PANEL_MODES=new Set(['open','rail','closed']);
const morning={open:false,busy:false,error:'',sessionId:null,messages:[],candidates:[],state:null};
let scheduled=false;
let receipt=null;

function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[char]));
}

function compact(value,max=180){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  return text.length>max?`${text.slice(0,max-1)}…`:text;
}

function readPanelMode(){
  try{
    const stored=localStorage.getItem(PANEL_MODE_KEY);
    return PANEL_MODES.has(stored)?stored:'open';
  }catch{return 'open';}
}

function setPanelMode(mode){
  const next=PANEL_MODES.has(mode)?mode:'open';
  document.documentElement.dataset.aiPanelMode=next;
  try{localStorage.setItem(PANEL_MODE_KEY,next);}catch{}
  scheduleEnhance();
}

function requestPath(input){
  try{
    const raw=typeof input==='string'?input:input?.url;
    return new URL(raw,location.origin).pathname;
  }catch{return'';}
}

function actionReceipt(pathname,data,ok){
  if(pathname==='/api/projects/sync'){
    const results=Array.isArray(data?.results)?data.results:[];
    const success=results.filter(item=>item?.ok).length;
    const stale=results.filter(item=>item?.stale).length;
    const failed=Math.max(0,results.length-success-stale);
    return ok
      ?{title:'所有项目同步已完成',detail:`成功 ${success}，过期跳过 ${stale}，失败 ${failed}`}
      :{title:'所有项目同步失败',detail:data?.error||'请查看待确认和工作日志。',error:true};
  }
  if(/^\/api\/projects\/[^/]+\/sync$/.test(pathname)){
    return ok
      ?{title:'项目同步已完成',detail:'飞书记录与本地机器状态已按事务顺序处理。'}
      :{title:'项目同步未完成',detail:data?.error||'请查看待确认中的恢复提示。',error:true};
  }
  if(pathname==='/api/inbox/sync'){
    const sync=data?.sync||{};
    return ok
      ?{title:'飞书收件箱已读回',detail:`新增 ${sync.imported||0}，更新 ${sync.updated||0}，移除 ${sync.removed||0}`}
      :{title:'飞书收件箱同步失败',detail:data?.error||'请检查飞书连接。',error:true};
  }
  if(pathname==='/api/backup'){
    return ok
      ?{title:'本机备份已创建',detail:'backup v2 已保存状态、配置和恢复凭据。'}
      :{title:'备份创建失败',detail:data?.error||'请检查数据目录。',error:true};
  }
  if(pathname==='/api/ai/execute'){
    return ok
      ?{title:'AI 工具已执行并读回',detail:data?.tool?.name?`工具：${data.tool.name}`:'左侧状态已重新读取。'}
      :{title:'AI 工具执行失败',detail:data?.error||'左侧状态没有被确认更新。',error:true};
  }
  if(pathname==='/api/todos/today'){
    return ok
      ?{title:'今日工作台已更新',detail:'这次变更来自你的明确操作。'}
      :{title:'今日工作台未更新',detail:data?.error||'请检查待办状态。',error:true};
  }
  return null;
}

window.fetch=async function observedFetch(input,init={}){
  const response=await nativeFetch(input,init);
  const method=String(init?.method||input?.method||'GET').toUpperCase();
  if(method!=='GET'){
    const pathname=requestPath(input);
    if(pathname&&pathname!=='/api/morning/chat'){
      response.clone().json().catch(()=>({})).then(data=>{
        const next=actionReceipt(pathname,data,response.ok);
        if(next){receipt={...next,key:`${Date.now()}-${Math.random()}`};scheduleEnhance();}
      });
    }
  }
  return response;
};

async function requestJson(url,options={}){
  const response=await nativeFetch(url,{
    ...options,
    headers:{'Content-Type':'application/json',...(options.headers||{})}
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||data.question||`请求失败 ${response.status}`);
  return data;
}

function panelButton(label,action,title){
  const button=document.createElement('button');
  button.type='button';
  button.className='ux-ai-control';
  button.dataset.uxAction=action;
  button.textContent=label;
  button.title=title;
  button.setAttribute('aria-label',title);
  return button;
}

function ensurePanelControls(panel){
  const top=panel.querySelector('.ai-panel-top');
  if(!top||top.querySelector('.ux-ai-controls'))return;
  const controls=document.createElement('div');
  controls.className='ux-ai-controls';
  controls.append(
    panelButton('展开','ai-open','展开 AI 工作区'),
    panelButton('窄条','ai-rail','把 AI 工作区收窄为入口条'),
    panelButton('收起','ai-close','完全收起 AI 工作区')
  );
  top.append(controls);
}

function ensureReopenButton(){
  let button=document.querySelector('#ux-ai-reopen');
  if(button)return;
  button=document.createElement('button');
  button.id='ux-ai-reopen';
  button.type='button';
  button.dataset.uxAction='ai-open';
  button.textContent='打开 AI';
  button.setAttribute('aria-label','打开 AI 工作区');
  document.body.append(button);
}

function normalizeModelStatus(panel){
  for(const pill of panel.querySelectorAll('.ai-context .pill')){
    if(pill.textContent.startsWith('模型已接入')){
      pill.textContent=pill.textContent.replace('模型已接入','模型已配置，未联网验证');
    }
  }
  const badge=panel.querySelector('.ai-live-dot');
  if(badge?.textContent.trim()==='MODEL'){
    badge.textContent='CONFIG';
    badge.title='模型已配置；每次结果会单独标注模型成功或本地安全回退。';
  }
}

function ensureMorningTriggers(panel){
  const suggestions=panel.querySelector('.ai-suggestions');
  if(suggestions&&!suggestions.querySelector('[data-ux-action="morning-focus"]')){
    const button=document.createElement('button');
    button.type='button';
    button.className='btn small ux-morning-trigger';
    button.dataset.uxAction='morning-focus';
    button.textContent='早晨对焦';
    suggestions.prepend(button);
  }
  const decisionHead=document.querySelector('.human-decision-card .card-head');
  if(decisionHead&&!decisionHead.querySelector('[data-ux-action="morning-focus"]')){
    const button=document.createElement('button');
    button.type='button';
    button.className='btn small primary ux-morning-trigger';
    button.dataset.uxAction='morning-focus';
    button.textContent='开始早晨对焦';
    decisionHead.append(button);
  }
}

function morningCandidateHtml(candidate){
  const current=morning.state||{};
  if(candidate.kind==='todo'){
    const todo=(current.todos||[]).find(item=>item.id===candidate.id);
    const done=Boolean(todo?.done);
    const inToday=(current.todayPlan||[]).includes(candidate.id);
    const control=done
      ?'<span class="ux-morning-state">已完成</span>'
      :`<button type="button" class="btn small ${inToday?'':'primary'}" data-action="today-toggle" data-id="${escapeHtml(candidate.id)}" data-add="${inToday?'0':'1'}">${inToday?'移出今日':'加入今日'}</button>`;
    return `<div class="ux-morning-candidate"><div><strong>${escapeHtml(candidate.title||todo?.title||'待办')}</strong><p>${escapeHtml(candidate.reason||'')}</p></div>${control}</div>`;
  }
  return `<div class="ux-morning-candidate"><div><strong>${escapeHtml(candidate.title||'项目')}</strong><p>${escapeHtml(candidate.reason||'')}</p></div><a class="btn small" href="#project/${encodeURIComponent(candidate.id)}">打开项目</a></div>`;
}

function morningPanelHtml(){
  const messages=morning.messages.slice(-10).map(message=>
    `<div class="ux-morning-message ${message.role==='user'?'user':'assistant'}">${escapeHtml(message.text)}</div>`
  ).join('');
  const candidates=morning.candidates.length
    ?`<div class="ux-morning-candidates"><div class="ux-morning-label">值得讨论</div>${morning.candidates.map(morningCandidateHtml).join('')}</div>`
    :'';
  const status=morning.busy?'<div class="ux-morning-status">正在读取最近 3 天和临近截止事项…</div>':'';
  const error=morning.error?`<div class="ux-morning-error">${escapeHtml(morning.error)}</div>`:'';
  return `<div class="ux-morning-head"><div><strong>早晨对焦</strong><span>只讨论，不自动安排</span></div><button type="button" class="ux-morning-close" data-ux-action="morning-close" aria-label="关闭早晨对焦">×</button></div><div class="ux-morning-messages">${messages||'<div class="ux-morning-empty">点击开始后，AI 会根据最近 3 天、临近截止项目和待办与你对焦。</div>'}</div>${candidates}${status}${error}<form id="ux-morning-form" class="ux-morning-form"><input id="ux-morning-input" autocomplete="off" maxlength="2000" placeholder="继续讨论，最后由你决定哪些进入今日"><button class="btn small primary" ${morning.busy?'disabled':''}>发送</button></form>`;
}

function renderMorningPanel(panel){
  let container=panel.querySelector('.ux-morning-panel');
  if(!morning.open){container?.remove();return;}
  if(!container){
    container=document.createElement('section');
    container.className='ux-morning-panel';
    const anchor=panel.querySelector('.ai-context');
    if(anchor)anchor.insertAdjacentElement('afterend',container);
    else panel.prepend(container);
  }
  const key=JSON.stringify({
    busy:morning.busy,error:morning.error,sessionId:morning.sessionId,
    messages:morning.messages,candidates:morning.candidates,
    todayPlan:morning.state?.todayPlan,todos:(morning.state?.todos||[]).map(todo=>[todo.id,todo.done])
  });
  if(container.dataset.renderKey!==key){
    container.dataset.renderKey=key;
    container.innerHTML=morningPanelHtml();
  }
}

function resultSummary(value){
  if(Array.isArray(value))return`${value.length} 条结果已读回`;
  if(!value||typeof value!=='object')return compact(value||'操作已完成',100);
  if(Array.isArray(value.todos))return`${value.todos.length} 个待办；今日 ${Array.isArray(value.todayPlan)?value.todayPlan.length:0} 个`;
  if(Array.isArray(value.projects))return`${value.projects.length} 个项目已读回`;
  if(Array.isArray(value.items))return`${value.items.length} 条记录已读回`;
  if(value.file)return'备份已创建；路径保留在技术详情中';
  if(value.message)return compact(value.message,120);
  if(value.ok===true)return'操作已完成，左侧状态已读回';
  const keys=Object.keys(value);
  return keys.length?`${keys.length} 个结果字段已读回`:'操作已完成';
}

function makeResultsReadable(panel){
  for(const result of panel.querySelectorAll('.ai-result:not([data-ux-readable])')){
    result.dataset.uxReadable='1';
    const pre=result.querySelector('pre');
    if(!pre)continue;
    let value=null;
    try{value=JSON.parse(pre.textContent);}catch{}
    const summary=document.createElement('div');
    summary.className='ux-result-summary';
    summary.textContent=resultSummary(value??pre.textContent);
    pre.insertAdjacentElement('beforebegin',summary);
    const details=document.createElement('details');
    details.className='ux-technical-details';
    const label=document.createElement('summary');
    label.textContent='查看技术详情';
    pre.parentNode.insertBefore(details,pre);
    details.append(label,pre);
  }
}

function renderActionReceipt(){
  const main=document.querySelector('.main');
  if(!main)return;
  const existing=main.querySelector('.ux-action-receipt');
  if(!receipt){existing?.remove();return;}
  if(existing?.dataset.receiptKey===receipt.key)return;
  const bar=existing||document.createElement('section');
  bar.className=`ux-action-receipt${receipt.error?' error':''}`;
  bar.dataset.receiptKey=receipt.key;
  bar.innerHTML=`<div><strong>${escapeHtml(receipt.title)}</strong>${receipt.detail?`<span>${escapeHtml(receipt.detail)}</span>`:''}</div><button type="button" data-ux-action="receipt-close" aria-label="关闭操作回执">关闭</button>`;
  if(!existing){
    const capture=main.querySelector('.capture');
    if(capture)capture.insertAdjacentElement('afterend',bar);
    else main.prepend(bar);
  }
}

async function refreshMorningState(){
  try{morning.state=await requestJson('/api/state');}
  catch{}
  scheduleEnhance();
}

async function runMorning(message){
  const text=String(message||'').trim();
  if(!text||morning.busy)return;
  morning.open=true;
  morning.busy=true;
  morning.error='';
  scheduleEnhance();
  try{
    const current=await requestJson('/api/state');
    morning.state=current;
    if(!morning.sessionId&&current.morningSession){
      morning.sessionId=current.morningSession.id;
      if(!morning.messages.length)morning.messages=[...(current.morningSession.messages||[])];
    }
    const result=await requestJson('/api/morning/chat',{
      method:'POST',
      body:JSON.stringify({message:text,sessionId:morning.sessionId})
    });
    morning.sessionId=result.sessionId;
    morning.messages.push(
      {role:'user',text},
      {role:'assistant',text:result.reply||'这次没有生成可读回复。'}
    );
    morning.candidates=Array.isArray(result.candidates)?result.candidates:[];
    morning.state=await requestJson('/api/state');
  }catch(error){morning.error=error.message;}
  finally{morning.busy=false;scheduleEnhance();}
}

function enhance(){
  ensureReopenButton();
  const panel=document.querySelector('.ai-panel');
  if(panel){
    ensurePanelControls(panel);
    normalizeModelStatus(panel);
    ensureMorningTriggers(panel);
    renderMorningPanel(panel);
    makeResultsReadable(panel);
  }
  renderActionReceipt();
}

function scheduleEnhance(){
  if(scheduled)return;
  scheduled=true;
  queueMicrotask(()=>{scheduled=false;enhance();});
}

document.addEventListener('click',event=>{
  const target=event.target.closest?.('[data-ux-action]');
  if(target){
    const action=target.dataset.uxAction;
    if(action==='ai-open')setPanelMode('open');
    else if(action==='ai-rail')setPanelMode('rail');
    else if(action==='ai-close')setPanelMode('closed');
    else if(action==='morning-focus'){setPanelMode('open');runMorning('帮我过一下今天。');}
    else if(action==='morning-close'){morning.open=false;scheduleEnhance();}
    else if(action==='receipt-close'){receipt=null;scheduleEnhance();}
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if(event.target.closest?.('.ux-morning-panel [data-action="today-toggle"]')){
    setTimeout(refreshMorningState,700);
  }
});

document.addEventListener('submit',event=>{
  if(event.target.id!=='ux-morning-form')return;
  event.preventDefault();
  const input=event.target.querySelector('#ux-morning-input');
  const text=input?.value.trim();
  if(!text)return;
  input.value='';
  runMorning(text);
});

setPanelMode(readPanelMode());
new MutationObserver(scheduleEnhance).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
scheduleEnhance();
