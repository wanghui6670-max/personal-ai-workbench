const PANEL_MODE_KEY='personal-ai-workbench.ai-panel-mode';
const PANEL_MODES=new Set(['open','rail','closed']);
const morning={open:false,busy:false,error:'',sessionId:null,messages:[],candidates:[],state:null};
let scheduled=false;

function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[char]));
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

async function requestJson(url,options={}){
  const response=await fetch(url,{
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
  if(!panel)return;
  ensurePanelControls(panel);
  normalizeModelStatus(panel);
  ensureMorningTriggers(panel);
  renderMorningPanel(panel);
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
    else if(action==='morning-focus')runMorning('帮我过一下今天。');
    else if(action==='morning-close'){morning.open=false;scheduleEnhance();}
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
