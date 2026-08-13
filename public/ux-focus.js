const nativeFetch=window.fetch.bind(window);
const PANEL_KEY='paw.aiPanelMode.v1';
const RECEIPT_KEY='paw.lastActionReceipt.v1';
const PANEL_MODES=new Set(['expanded','rail','hidden']);

let panelMode=readPanelMode();
let lastReceipt=readReceipt();
let stateSnapshot=null;
let enhanceQueued=false;
let morningState={hydrated:false,busy:false,sessionId:null,messages:[],candidates:[]};

function readPanelMode(){
  try{
    const value=localStorage.getItem(PANEL_KEY);
    return PANEL_MODES.has(value)?value:'expanded';
  }catch{return'expanded';}
}

function readReceipt(){
  try{
    const raw=sessionStorage.getItem(RECEIPT_KEY);
    if(!raw)return null;
    const parsed=JSON.parse(raw);
    if(!parsed||typeof parsed!=='object')return null;
    if(Date.now()-Number(parsed.at||0)>4*60*60*1000){sessionStorage.removeItem(RECEIPT_KEY);return null;}
    return parsed;
  }catch{return null;}
}

function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[char]));
}

function compact(value,max=180){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  return text.length>max?`${text.slice(0,max-1)}…`:text;
}

function setPanelMode(next){
  if(!PANEL_MODES.has(next))return;
  panelMode=next;
  try{localStorage.setItem(PANEL_KEY,next);}catch{}
  scheduleEnhance();
}

function setReceipt({title,detail='',tone='success'}){
  lastReceipt={title:compact(title,90),detail:compact(detail,180),tone,at:Date.now()};
  try{sessionStorage.setItem(RECEIPT_KEY,JSON.stringify(lastReceipt));}catch{}
  scheduleEnhance();
}

function clearReceipt(){
  lastReceipt=null;
  try{sessionStorage.removeItem(RECEIPT_KEY);}catch{}
  scheduleEnhance();
}

function requestPath(input){
  try{
    const raw=typeof input==='string'?input:input?.url;
    return new URL(raw,location.origin).pathname;
  }catch{return'';}
}

function responseReceipt(pathname,data,ok){
  if(pathname==='/api/projects/sync'){
    const results=Array.isArray(data?.results)?data.results:[];
    const success=results.filter(item=>item?.ok).length;
    const stale=results.filter(item=>item?.stale).length;
    const failed=Math.max(0,results.length-success-stale);
    return ok
      ?{title:'所有项目同步已完成',detail:`成功 ${success}，过期跳过 ${stale}，失败 ${failed}`}
      :{title:'所有项目同步失败',detail:data?.error||'请查看待确认和工作日志。',tone:'error'};
  }
  if(/^\/api\/projects\/[^/]+\/sync$/.test(pathname)){
    return ok
      ?{title:'项目同步已完成',detail:'飞书记录与本地机器状态已按事务顺序处理。'}
      :{title:'项目同步未完成',detail:data?.error||'请查看待确认中的恢复提示。',tone:'error'};
  }
  if(pathname==='/api/inbox/sync'){
    const sync=data?.sync||{};
    return ok
      ?{title:'飞书收件箱已读回',detail:`新增 ${sync.imported||0}，更新 ${sync.updated||0}，移除 ${sync.removed||0}`}
      :{title:'飞书收件箱同步失败',detail:data?.error||'请检查飞书连接。',tone:'error'};
  }
  if(pathname==='/api/backup'){
    return ok
      ?{title:'本机备份已创建',detail:'backup v2 已保存状态、配置和恢复凭据。'}
      :{title:'备份创建失败',detail:data?.error||'请检查数据目录。',tone:'error'};
  }
  if(pathname==='/api/ai/execute'){
    return ok
      ?{title:'AI 工具已执行并读回',detail:data?.tool?.name?`工具：${data.tool.name}`:'左侧状态已重新读取。'}
      :{title:'AI 工具执行失败',detail:data?.error||'左侧状态没有被确认更新。',tone:'error'};
  }
  if(pathname==='/api/todos/today'){
    return ok
      ?{title:'今日工作台已更新',detail:'这次变更来自你的明确操作。'}
      :{title:'今日工作台未更新',detail:data?.error||'请检查待办状态。',tone:'error'};
  }
  return null;
}

window.fetch=async function uxObservedFetch(input,init={}){
  const response=await nativeFetch(input,init);
  const method=String(init?.method||input?.method||'GET').toUpperCase();
  if(method!=='GET'){
    const pathname=requestPath(input);
    if(pathname&&pathname!=='/api/morning/chat'){
      response.clone().json().catch(()=>({})).then(data=>{
        const receipt=responseReceipt(pathname,data,response.ok);
        if(receipt)setReceipt(receipt);
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
  if(!response.ok){
    const error=new Error(data.error||data.question||`请求失败 ${response.status}`);
    error.status=response.status;
    error.code=data.code||null;
    throw error;
  }
  return data;
}

async function refreshState(){
  stateSnapshot=await requestJson('/api/state');
  return stateSnapshot;
}

function scheduleEnhance(){
  if(enhanceQueued)return;
  enhanceQueued=true;
  queueMicrotask(()=>{
    enhanceQueued=false;
    enhance().catch(error=>console.warn('[ux-focus]',error.message));
  });
}

function applyPanelMode(){
  const layout=document.querySelector('.layout');
  const panel=document.querySelector('.ai-panel');
  if(!layout||!panel){document.querySelector('#ux-ai-reopen')?.remove();return;}

  layout.classList.remove('ux-ai-expanded','ux-ai-rail','ux-ai-hidden');
  layout.classList.add(`ux-ai-${panelMode}`);
  panel.setAttribute('aria-hidden',panelMode==='hidden'?'true':'false');

  const top=panel.querySelector('.ai-panel-top');
  if(top&&!top.querySelector('.ux-ai-panel-controls')){
    const controls=document.createElement('div');
    controls.className='ux-ai-panel-controls';
    top.appendChild(controls);
  }
  const controls=top?.querySelector('.ux-ai-panel-controls');
  if(controls&&controls.dataset.mode!==panelMode){
    controls.dataset.mode=panelMode;
    controls.innerHTML=panelMode==='expanded'
      ?'<button type="button" data-ux-panel-mode="rail" aria-label="把 AI 面板缩成窄条" title="窄条">◧</button><button type="button" data-ux-panel-mode="hidden" aria-label="收起 AI 面板" title="收起">×</button>'
      :'<button type="button" data-ux-panel-mode="expanded" aria-label="展开 AI 面板" title="展开">AI</button><button type="button" data-ux-panel-mode="hidden" aria-label="完全收起 AI 面板" title="收起">×</button>';
  }

  let reopen=document.querySelector('#ux-ai-reopen');
  if(panelMode==='hidden'){
    if(!reopen){
      reopen=document.createElement('button');
      reopen.id='ux-ai-reopen';
      reopen.type='button';
      reopen.textContent='打开 AI';
      reopen.setAttribute('aria-label','打开 AI 工作区');
      document.body.appendChild(reopen);
    }
  }else reopen?.remove();
}

function clarifyModelStatus(){
  const panel=document.querySelector('.ai-panel');
  if(!panel)return;
  for(const pill of panel.querySelectorAll('.ai-context .pill')){
    const text=pill.textContent.trim();
    if(text.startsWith('模型已接入 ·')){
      pill.textContent=text.replace('模型已接入 ·','模型已配置 · 尚未验证 ·');
    }
  }
  const live=panel.querySelector('.ai-live-dot');
  if(live?.textContent.trim()==='MODEL')live.textContent='CONFIG';
  const context=panel.querySelector('.ai-context');
  if(context&&!panel.querySelector('.ux-model-legend')){
    const legend=document.createElement('div');
    legend.className='ux-model-legend';
    legend.textContent='每次结果以“模型”或“本地安全回退”徽标为准。';
    context.insertAdjacentElement('afterend',legend);
  }
  for(const badge of panel.querySelectorAll('.ai-planner-badge')){
    const fallback=badge.textContent.includes('本地安全回退');
    badge.classList.toggle('ux-fallback',fallback);
    badge.title=fallback?'本次没有使用云模型结果。':'本次计划由界面显示的模型生成。';
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

function makeResultsReadable(){
  for(const result of document.querySelectorAll('.ai-result:not([data-ux-ready])')){
    result.dataset.uxReady='1';
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

function renderReceipt(){
  const main=document.querySelector('.main');
  if(!main)return;
  const existing=main.querySelector('.ux-action-receipt');
  if(!lastReceipt){existing?.remove();return;}
  const signature=JSON.stringify(lastReceipt);
  if(existing?.dataset.signature===signature)return;
  const receipt=existing||document.createElement('section');
  receipt.className=`ux-action-receipt ${lastReceipt.tone==='error'?'error':'success'}`;
  receipt.dataset.signature=signature;
  receipt.innerHTML=`<div><strong>${escapeHtml(lastReceipt.title)}</strong>${lastReceipt.detail?`<span>${escapeHtml(lastReceipt.detail)}</span>`:''}</div><button type="button" id="ux-receipt-close" aria-label="关闭操作回执">关闭</button>`;
  if(!existing){
    const capture=main.querySelector('.capture');
    if(capture)capture.insertAdjacentElement('afterend',receipt);
    else main.prepend(receipt);
  }
}

function isTodayPage(){
  return (location.hash||'#today').replace(/^#/,'').split('/')[0]==='today';
}

function hydrateMorningFromState(snapshot){
  const session=snapshot?.morningSession||null;
  morningState.sessionId=session?.id||null;
  morningState.messages=Array.isArray(session?.messages)?session.messages:[];
  morningState.hydrated=true;
}

function candidateHtml(candidate){
  const state=stateSnapshot||{};
  if(candidate.kind==='todo'){
    const todo=state.todos?.find(item=>item.id===candidate.id);
    if(!todo)return'';
    const inToday=Array.isArray(state.todayPlan)&&state.todayPlan.includes(todo.id);
    const action=todo.done
      ?'<span class="ux-candidate-state">已完成</span>'
      :inToday
        ?'<span class="ux-candidate-state active">已在今日</span>'
        :`<button type="button" class="ux-morning-add" data-todo-id="${escapeHtml(todo.id)}">加入今日</button>`;
    return `<div class="ux-morning-candidate"><div><strong>${escapeHtml(todo.title)}</strong><span>${escapeHtml(candidate.reason||'值得讨论')}</span></div>${action}</div>`;
  }
  const project=state.projects?.find(item=>item.id===candidate.id);
  if(!project)return'';
  return `<div class="ux-morning-candidate"><div><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(candidate.reason||'值得讨论')}</span></div><a href="#project/${encodeURIComponent(project.id)}">打开项目</a></div>`;
}

function renderMorningCard(card){
  const signature=JSON.stringify({
    busy:morningState.busy,
    sessionId:morningState.sessionId,
    messages:morningState.messages.slice(-8).map(({role,text,at})=>({role,text,at})),
    candidates:morningState.candidates
  });
  if(card.dataset.signature===signature)return;
  card.dataset.signature=signature;
  const messages=morningState.messages.slice(-8).map(message=>`<div class="ux-morning-message ${message.role==='user'?'user':'assistant'}"><span>${message.role==='user'?'你':'AI'}</span><p>${escapeHtml(message.text)}</p></div>`).join('');
  const candidates=morningState.candidates.map(candidateHtml).filter(Boolean).join('');
  card.innerHTML=`
    <div class="ux-morning-head">
      <div><span class="ux-eyebrow">每日唯一入口</span><h2>早晨对焦</h2><p>回看最近 3 天和临近截止事项；AI 只提出讨论项，最终由你加入今日。</p></div>
      <button type="button" id="ux-morning-start" ${morningState.busy?'disabled':''}>${morningState.messages.length?'继续对焦':'开始对焦'}</button>
    </div>
    ${messages?`<div class="ux-morning-thread">${messages}</div>`:'<div class="ux-morning-empty">还没有开始今天的对焦。</div>'}
    ${candidates?`<div class="ux-morning-candidates"><h3>值得你拍板</h3>${candidates}</div>`:''}
    ${morningState.messages.length?`<form id="ux-morning-form"><input id="ux-morning-input" autocomplete="off" maxlength="2000" placeholder="继续聊：今天最想推进什么？"><button ${morningState.busy?'disabled':''}>发送</button></form>`:''}
  `;
}

async function ensureMorningCard(){
  if(!isTodayPage())return;
  const main=document.querySelector('.main');
  if(!main)return;
  let card=main.querySelector('#ux-morning-focus');
  if(!card){
    card=document.createElement('section');
    card.id='ux-morning-focus';
    card.className='card pad ux-morning-card';
    const capture=main.querySelector('.capture');
    if(capture)capture.insertAdjacentElement('afterend',card);
    else main.prepend(card);
  }
  if(!morningState.hydrated){
    try{
      const snapshot=await refreshState();
      hydrateMorningFromState(snapshot);
    }catch(error){
      morningState.hydrated=true;
      setReceipt({title:'早晨对焦暂时不可用',detail:error.message,tone:'error'});
    }
  }
  renderMorningCard(card);
}

function addMorningEntrypoints(){
  if(!isTodayPage())return;
  const prompt=document.querySelector('.human-decision-card .empty');
  if(prompt&&!prompt.querySelector('#ux-morning-scroll')){
    const button=document.createElement('button');
    button.type='button';
    button.id='ux-morning-scroll';
    button.textContent='开始早晨对焦';
    prompt.prepend(button);
  }
  const suggestions=document.querySelector('.ai-suggestions');
  if(suggestions&&!suggestions.querySelector('#ux-ai-morning-shortcut')){
    const button=document.createElement('button');
    button.type='button';
    button.className='btn small';
    button.id='ux-ai-morning-shortcut';
    button.textContent='早晨对焦';
    suggestions.prepend(button);
  }
}

function scrollToMorning(){
  if(!isTodayPage()){
    location.hash='#today';
    setTimeout(scrollToMorning,120);
    return;
  }
  document.querySelector('#ux-morning-focus')?.scrollIntoView({behavior:'smooth',block:'start'});
}

async function runMorning(message){
  if(morningState.busy)return;
  morningState.busy=true;
  scheduleEnhance();
  try{
    const result=await requestJson('/api/morning/chat',{
      method:'POST',
      body:JSON.stringify({message,sessionId:morningState.sessionId})
    });
    morningState.sessionId=result.sessionId;
    morningState.candidates=Array.isArray(result.candidates)?result.candidates:[];
    const snapshot=await refreshState();
    hydrateMorningFromState(snapshot);
    morningState.candidates=Array.isArray(result.candidates)?result.candidates:[];
  }catch(error){
    setReceipt({title:'早晨对焦失败',detail:error.message,tone:'error'});
  }finally{
    morningState.busy=false;
    scheduleEnhance();
  }
}

async function addMorningTodo(todoId){
  try{
    await requestJson('/api/todos/today',{method:'POST',body:JSON.stringify({todoId,add:true})});
    setReceipt({title:'已加入今日工作台',detail:'这次安排来自你的明确点击。'});
    location.reload();
  }catch(error){
    setReceipt({title:'没有加入今日工作台',detail:error.message,tone:'error'});
  }
}

async function enhance(){
  applyPanelMode();
  clarifyModelStatus();
  makeResultsReadable();
  renderReceipt();
  if(isTodayPage()){
    await ensureMorningCard();
    addMorningEntrypoints();
  }
}

document.addEventListener('click',event=>{
  const panelButton=event.target.closest?.('[data-ux-panel-mode]');
  if(panelButton){event.preventDefault();setPanelMode(panelButton.dataset.uxPanelMode);return;}
  if(event.target.closest?.('#ux-ai-reopen')){event.preventDefault();setPanelMode('expanded');return;}
  if(event.target.closest?.('#ux-receipt-close')){event.preventDefault();clearReceipt();return;}
  if(event.target.closest?.('#ux-morning-scroll,#ux-ai-morning-shortcut')){event.preventDefault();scrollToMorning();return;}
  if(event.target.closest?.('#ux-morning-start')){event.preventDefault();runMorning('帮我过一下今天。');return;}
  const add=event.target.closest?.('.ux-morning-add');
  if(add){event.preventDefault();addMorningTodo(add.dataset.todoId);}
});

document.addEventListener('submit',event=>{
  if(event.target.id!=='ux-morning-form')return;
  event.preventDefault();
  const input=document.querySelector('#ux-morning-input');
  const message=input?.value.trim();
  if(!message)return;
  input.value='';
  runMorning(message);
});

window.addEventListener('hashchange',scheduleEnhance);
new MutationObserver(scheduleEnhance).observe(document.documentElement,{childList:true,subtree:true});
scheduleEnhance();
