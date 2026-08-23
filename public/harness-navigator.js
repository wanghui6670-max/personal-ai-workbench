/* harness-navigator.js — DSH Navigator 面板（15 项增强版）
 * 增强：Markdown 渲染、停止生成、Think 区块、时间戳、复制、会话持久化、
 *       会话列表/搜索/分支、性能指标、Token 统计、反馈按钮、GenUI 卡片、
 *       轨迹标签页、Skill 标签、模型选择
 */
const nativeFetch=window.fetch.bind(window);
const navigatorState={
  status:null,statusLoading:false,busy:false,abortController:null,
  error:'',sessionId:null,messages:[],trajectory:[],thinkBlocks:[],skillCalls:[],
  metrics:null,activeTab:'chat',
  sessions:[],currentSessionId:null,
  recording:false,speechRecognition:null
};
const DEFAULT_PANEL_WIDTH=500;
let scheduled=false;
let lastMountedHtml='';

/* ─── 工具函数 ─── */
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function compact(value,max=280){const text=String(value??'').replace(/\s+/g,' ').trim();return text.length<=max?text:`${text.slice(0,max-1)}…`;}
function formatTime(date){const d=new Date(date);const pad=n=>String(n).padStart(2,'0');return `${pad(d.getMonth()+1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;}
function formatElapsed(ms){if(ms<1000)return `${ms}ms`;const s=ms/1000;return s<60?`${s.toFixed(1)}秒`:`${Math.floor(s/60)}分${Math.round(s%60)}秒`;}
function formatTokens(n){if(n==null)return '—';if(n<1000)return `${n}`;if(n<1000000)return `${(n/1000).toFixed(1)}K`;return `${(n/1000000).toFixed(1)}M`;}

/* ─── Markdown 渲染器 ─── */
function renderMarkdown(text){
  if(!text)return '';
  let html=escapeHtml(text);
  // 代码块 ```
  html=html.replace(/```(\w*)\n?([\s\S]*?)```/g,(m,lang,code)=>{
    return `<pre class="md-code-block"><code>${code.replace(/^\n/,'')}</code></pre>`;
  });
  // 行内代码
  html=html.replace(/`([^`]+)`/g,'<code class="md-inline-code">$1</code>');
  // 标题
  html=html.replace(/^### (.+)$/gm,'<h4 class="md-h4">$1</h4>');
  html=html.replace(/^## (.+)$/gm,'<h3 class="md-h3">$1</h3>');
  html=html.replace(/^# (.+)$/gm,'<h2 class="md-h2">$1</h2>');
  // 粗体和斜体
  html=html.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  html=html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g,'<em>$1</em>');
  // 链接
  html=html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');
  // 无序列表
  const lines=html.split('\n');
  const result=[];
  let inList=false,inOrder=false;
  for(let line of lines){
    if(/^\s*[-*] (.+)/.test(line)){
      if(!inList){result.push('<ul class="md-list">');inList=true;}
      result.push(`<li>${line.replace(/^\s*[-*] /,'')}</li>`);
    }else if(/^\s*\d+\. (.+)/.test(line)){
      if(!inOrder){result.push('<ol class="md-list">');inOrder=true;}
      result.push(`<li>${line.replace(/^\s*\d+\. /,'')}</li>`);
    }else if(line.match(/^<pre|^<h[234]|^<div/)){
      if(inList){result.push('</ul>');inList=false;}
      if(inOrder){result.push('</ol>');inOrder=false;}
      result.push(line);
    }else if(line.trim()){
      if(inList){result.push('</ul>');inList=false;}
      if(inOrder){result.push('</ol>');inOrder=false;}
      result.push(`<p class="md-p">${line}</p>`);
    }
  }
  if(inList)result.push('</ul>');
  if(inOrder)result.push('</ol>');
  return result.join('');
}

/* ─── GenUI 渲染器 ─── */
function renderGenUI(spec){
  if(!spec||typeof spec!=='object')return '';
  const title=spec.title?`<div class="genui-title">${escapeHtml(spec.title)}</div>`:'';
  let items='';
  if(Array.isArray(spec.items)){
    for(const item of spec.items){
      if(item.type==='callout'){
        items+=`<div class="genui-callout genui-${item.tone||'info'}"><strong>${escapeHtml(item.title||'')}</strong><p>${escapeHtml(item.content||'')}</p></div>`;
      }else if(item.type==='grid'){
        const cols=item.cols||3;
        let cells='';
        for(const c of(item.items||[])){
          if(c.type==='stat')cells+=`<div class="genui-stat"><span class="label">${escapeHtml(c.label||'')}</span><span class="value">${escapeHtml(c.value||'')}</span></div>`;
          else cells+=`<div class="genui-cell">${escapeHtml(String(c.content||c.value||''))}</div>`;
        }
        items+=`<div class="genui-grid" style="--genui-cols:${cols}">${cells}</div>`;
      }else if(item.type==='list'){
        let lis='';
        for(const li of(item.items||[]))lis+=`<div class="genui-list-item"><strong>${escapeHtml(li.title||'')}</strong><span>${escapeHtml(li.desc||'')}</span></div>`;
        items+=`<div class="genui-list">${lis}</div>`;
      }else if(item.type==='text'){
        items+=`<p class="genui-text">${escapeHtml(item.content||'')}</p>`;
      }
    }
  }
  return `<div class="genui-card">${title}<div class="genui-body" style="gap:${spec.gap||14}px">${items}</div></div>`;
}

function extractGenUI(text){
  const blocks=[];
  const regex=/```dsh-ui\n([\s\S]*?)```/g;
  let match;
  while((match=regex.exec(text))!==null){
    try{blocks.push(JSON.parse(match[1].trim()));}catch{}
  }
  return blocks;
}
function stripGenUI(text){
  return text.replace(/```dsh-ui\n[\s\S]*?```/g,'');
}

/* ─── 会话管理（内存模式，不做客户端持久化） ─── */
function loadSessions(){
  return [];
}
function saveSessions(){
  /* no-op: 会话状态仅保存在模块内存中，不写入客户端存储 */
}
function createSession(title){
  const now=Date.now();
  const sid=`s_${now.toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const session={id:sid,title:title||'新对话',createdAt:now,messages:[]};
  navigatorState.sessions.push(session);
  navigatorState.currentSessionId=sid;
  navigatorState.sessionId=null;
  navigatorState.messages=[];
  navigatorState.trajectory=[];
  navigatorState.thinkBlocks=[];
  navigatorState.metrics=null;
  saveSessions();
  return session;
}
function switchSession(sid){
  const session=navigatorState.sessions.find(s=>s.id===sid);
  if(!session)return;
  navigatorState.currentSessionId=sid;
  navigatorState.messages=session.messages||[];
  navigatorState.trajectory=[];
  navigatorState.thinkBlocks=[];
  navigatorState.metrics=null;
  navigatorState.sessionId=null;
  scheduleMount();
}
function deleteSession(sid){
  navigatorState.sessions=navigatorState.sessions.filter(s=>s.id!==sid);
  if(navigatorState.currentSessionId===sid){
    navigatorState.currentSessionId=null;
    navigatorState.messages=[];
    navigatorState.trajectory=[];
    navigatorState.thinkBlocks=[];
    navigatorState.metrics=null;
    navigatorState.sessionId=null;
  }
  saveSessions();
  scheduleMount();
}
function updateCurrentSession(){
  if(!navigatorState.currentSessionId)return;
  const session=navigatorState.sessions.find(s=>s.id===navigatorState.currentSessionId);
  if(!session)return;
  session.messages=navigatorState.messages.slice();
  if(session.title==='新对话'&&navigatorState.messages.length){
    const firstUser=navigatorState.messages.find(m=>m.role==='user');
    if(firstUser)session.title=compact(firstUser.text,28);
  }
  saveSessions();
}
function branchSession(fromIdx){
  const now=Date.now();
  const sid=`s_${now.toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const branchMessages=navigatorState.messages.slice(0,fromIdx+1).map(m=>({...m}));
  const session={id:sid,title:'分支对话',createdAt:now,messages:branchMessages};
  navigatorState.sessions.push(session);
  navigatorState.currentSessionId=sid;
  navigatorState.messages=branchMessages;
  navigatorState.trajectory=[];
  navigatorState.thinkBlocks=[];
  navigatorState.metrics=null;
  navigatorState.sessionId=null;
  saveSessions();
  scheduleMount();
}

/* ─── 路由与网络 ─── */
function currentRoute(){const raw=(location.hash||'#today').slice(1);const [view,encodedId]=raw.split('/');let id=null;try{id=encodedId?decodeURIComponent(encodedId):null;}catch{}return{view:view||'today',id};}
async function jsonRequest(url,options={},signal){const response=await nativeFetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})},signal:signal});const payload=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(payload.error||`请求失败 ${response.status}`);error.code=payload.code;throw error;}return payload;}

/* ─── 状态显示 ─── */
function statusTone(status){if(status?.available&&status?.state!=='error')return'ready';if(status?.enabled)return'warning';return'muted';}
function statusLabel(status){if(!status)return'检查中';if(status.available&&status.state==='starting')return'启动中';if(status.available&&status.state==='error')return'本轮异常';if(status.available)return'DSH 已就绪';if(status.reason==='disabled')return'未启用';if(status.reason==='packages_missing')return'运行库未安装';if(status.reason==='node_unsupported')return'Node 版本不足';if(status.reason==='provider_key_missing'||status.reason==='provider_model_missing')return'模型未配置';return'不可用';}

/* ─── 消息渲染 ─── */
function messageHtml(message,idx){
  const label=message.role==='user'?'你':'DSH';
  const time=message.time?formatTime(message.time):'';
  const genUIBlocks=message.role==='assistant'?extractGenUI(message.text):[];
  const textContent=message.role==='assistant'?stripGenUI(message.text):message.text;
  const mdHtml=message.role==='assistant'?renderMarkdown(textContent):escapeHtml(textContent);
  const genui=genUIBlocks.length?genUIBlocks.map(renderGenUI).join(''):'';
  const thinkHtml=message.think?`<details class="harness-nav-think"><summary>Think</summary><div>${escapeHtml(message.think)}</div></details>`:'';
  const skillsHtml=message.skills&&message.skills.length?`<div class="harness-nav-skills">${message.skills.map(s=>`<span class="skill-tag">Skill ${escapeHtml(s)}</span>`).join('')}</div>`:'';
  const copyBtn=message.role==='assistant'?`<button type="button" class="msg-copy" data-copy-idx="${idx}" title="复制">复制</button>`:'';
  const branchBtn=message.role==='assistant'?`<button type="button" class="msg-branch" data-branch-idx="${idx}" title="在新对话中分支">分支</button>`:'';
  const feedbackBtn=message.role==='assistant'?`<span class="msg-feedback"><button type="button" class="fb-good" data-fb-idx="${idx}" data-fb="good" title="好的回答">👍</button><button type="button" class="fb-bad" data-fb-idx="${idx}" data-fb="bad" title="有问题的回答">👎</button></span>`:'';
  return`<div class="harness-nav-message ${message.role}" data-msg-idx="${idx}"><div class="msg-header"><span class="msg-label">${label}</span>${time?`<span class="msg-time">${time}</span>`:''}${copyBtn}${branchBtn}${feedbackBtn}</div>${thinkHtml}${skillsHtml}<div class="msg-body">${mdHtml}</div>${genui}</div>`;
}

/* ─── 轨迹渲染 ─── */
function trajectoryTabHtml(){
  const items=navigatorState.trajectory;
  if(!items.length)return'<div class="harness-nav-tab-empty">本轮没有工具调用。</div>';
  const rows=items.map((item,i)=>{
    if(item.type==='tool_call')return`<div class="traj-row traj-call"><span class="traj-badge call">CALL</span><strong>${escapeHtml(item.name||'tool')}</strong><code>${escapeHtml(compact(JSON.stringify(item.arguments||{}),240))}</code></div>`;
    if(item.type==='tool_result')return`<div class="traj-row traj-result"><span class="traj-badge ${item.ok?'ok':'error'}">${item.ok?'OK':'ERR'}</span><strong>结果</strong><code>${escapeHtml(compact(item.text||item.errorCode||'',360))}</code></div>`;
    if(item.type==='turn_end')return`<div class="traj-row traj-turn"><span class="traj-badge done">TURN</span><strong>${escapeHtml(item.status||'end')}</strong></div>`;
    return'';
  }).join('');
  return`<div class="harness-nav-trajectory-list">${rows}</div>`;
}

/* ─── 性能指标栏 ─── */
function metricsHtml(){
  const m=navigatorState.metrics;
  if(!m)return'';
  const parts=[];
  parts.push(`用时 ${formatElapsed(m.elapsedMs)}`);
  if(m.firstTokenMs)parts.push(`首token ${(m.firstTokenMs/1000).toFixed(1)}秒`);
  if(m.tokensPerSecond)parts.push(`${m.tokensPerSecond} tok/s`);
  if(m.inputTokens!=null)parts.push(`输入 ${formatTokens(m.inputTokens)}`);
  if(m.outputTokens!=null)parts.push(`输出 ${formatTokens(m.outputTokens)}`);
  if(m.cacheHitRatio!=null)parts.push(`缓存 ${Math.round(m.cacheHitRatio*100)}%`);
  return`<div class="harness-nav-metrics">${parts.join(' · ')}</div>`;
}

/* ─── 会话列表渲染 ─── */
function sessionListHtml(){
  const sessions=navigatorState.sessions;
  if(!sessions.length)return'';
  const items=sessions.slice().reverse().map(s=>{
    const active=s.id===navigatorState.currentSessionId;
    const time=formatTime(s.createdAt);
    return`<div class="session-item ${active?'active':''}" data-session-id="${s.id}"><span class="session-title">${escapeHtml(s.title)}</span><span class="session-time">${time}</span><button type="button" class="session-del" data-del-session="${s.id}" title="删除">×</button></div>`;
  }).join('');
  return`<div class="session-list">${items}</div>`;
}

/* ─── 空状态 ─── */
function emptyStateHtml(){return`<div class="harness-nav-empty"><div class="harness-nav-empty-mark">✦</div><strong>开始一段工作对话</strong><p>在这里记下任何新事项，会自动进入收件箱；也可以让我帮你查看和分析。</p><div class="harness-nav-empty-actions"><button type="button" data-harness-suggest="帮我看今天：读取今日任务和临近截止事项，告诉我最需要关注什么。">看今天</button><button type="button" data-harness-suggest="查看收件箱：读取当前收件箱，帮我快速判断哪些事项值得处理。不要修改状态。">看收件箱</button><button type="button" data-harness-suggest="查看项目：读取当前进行中的项目，概括进度、卡点和临近截止项。不要修改状态。">看项目</button></div></div>`;}

/* ─── 不可用状态 ─── */
function unavailableHtml(status,statusMessage){return`<div class="harness-nav-unavailable"><div class="harness-nav-empty-mark">✦</div><strong>${escapeHtml(statusLabel(status))}</strong><p>${escapeHtml(statusMessage)}</p><button type="button" data-harness-refresh>重新检查</button></div>`;}

function healthHtml(status){return`<span class="harness-nav-health ${statusTone(status)}" title="${escapeHtml(statusLabel(status))}" aria-label="${escapeHtml(statusLabel(status))}"></span>`;}

/* ─── 主卡片渲染 ─── */
function cardHtml(){
  const status=navigatorState.status;
  const available=Boolean(status?.available);
  const messages=navigatorState.messages.slice(-40).map((m,i)=>messageHtml(m,i)).join('');
  const statusMessage=status?.message||'正在检查独立 Harness Sidecar。';
  const embeddedFallback=status?.uiMode==='embedded_experimental'&&status?.embeddedWeb?.enabled&&!status?.embeddedWeb?.verified?`<div class="harness-nav-native-warning">原生 DSH Web 未通过组成校验，当前继续使用受控 DSH Sidecar。${status.embeddedWeb.reason?` · ${escapeHtml(status.embeddedWeb.reason)}`:''}</div>`:'';
  const model=status?.model?escapeHtml(status.model):'DeepSeek Harness';
  const availableModels=Array.isArray(status?.availableModels)&&status.availableModels.length?status.availableModels:[];
  const modelSelector=availableModels.length>1
    ?`<select class="harness-nav-model-select" data-harness-model-switch ${navigatorState.busy?'disabled':''}>${availableModels.map(m=>`<option value="${escapeHtml(m)}" ${m===status.model?'selected':''}>${escapeHtml(m)}</option>`).join('')}</select>`
    :`<span>${model}</span>`;
  const tabChat=navigatorState.activeTab==='chat'?'active':'';
  const tabTraj=navigatorState.activeTab==='trajectory'?'active':'';
  const showStop=navigatorState.busy;
  return`<section class="harness-nav-card" data-harness-navigator>
    <button type="button" class="harness-nav-resize" data-harness-resize aria-label="调整 DSH 面板宽度" title="拖动调整宽度"></button>
    <header class="harness-nav-head">
      <strong>聊天</strong>
      <div class="harness-nav-head-actions">
        ${healthHtml(status)}
        <button type="button" data-harness-new title="新对话" aria-label="新对话" ${navigatorState.busy?'disabled':''}>＋</button>
        <button type="button" data-harness-sessions-toggle title="历史会话" aria-label="历史会话">☰</button>
        <button type="button" data-action="settings" title="工作台设置" aria-label="工作台设置">⚙</button>
        <button type="button" data-ux-action="ai-close" title="收起 DSH" aria-label="收起 DSH">›</button>
      </div>
    </header>
    ${embeddedFallback}
    <div class="harness-nav-sessions-panel" data-sessions-panel style="display:none">
      <div class="sessions-header"><span>历史会话</span><button type="button" data-harness-sessions-close>×</button></div>
      ${sessionListHtml()}
    </div>
    <div class="harness-nav-tabs">
      <button type="button" class="nav-tab ${tabChat}" data-tab="chat">对话</button>
      <button type="button" class="nav-tab ${tabTraj}" data-tab="trajectory">轨迹${navigatorState.trajectory.length?`(${navigatorState.trajectory.filter(t=>t.type==='tool_call').length})`:''}</button>
    </div>
    <div class="harness-nav-messages" data-tab-content="chat" style="${navigatorState.activeTab==='chat'?'':'display:none'}">
      ${available?(messages||emptyStateHtml()):unavailableHtml(status,statusMessage)}
      ${navigatorState.error?`<div class="harness-nav-error">${escapeHtml(navigatorState.error)}</div>`:''}
    </div>
    <div class="harness-nav-trajectory-panel" data-tab-content="trajectory" style="${navigatorState.activeTab==='trajectory'?'':'display:none'}">
      ${trajectoryTabHtml()}
    </div>
    <div class="harness-nav-metrics-bar">${metricsHtml()}</div>
    <form class="harness-nav-form" data-harness-form>
      <textarea name="message" rows="1" autocomplete="off" maxlength="12000" placeholder="记下来或描述要处理的内容…" aria-label="发送给 DSH" ${!available||navigatorState.busy?'disabled':''}></textarea>
      <div class="harness-nav-formbar">
        <div class="harness-nav-compose-meta"><span>Agent</span>${modelSelector}</div>
        ${showStop?'<button type="button" class="harness-nav-stop" data-harness-stop aria-label="停止生成">■</button>':''}
        <button type="button" class="harness-nav-mic${navigatorState.recording?' recording':''}" data-harness-mic aria-label="${navigatorState.recording?'停止语音输入':'语音输入'}" ${!available||navigatorState.busy?'disabled':''}>${navigatorState.recording?'■':'🎙'}</button>
        <button class="harness-nav-send" aria-label="发送" ${!available||navigatorState.busy?'disabled':''}>${navigatorState.busy?'…':'↑'}</button>
      </div>
    </form>
  </section>`;
}

/* ─── 面板宽度 ─── */
function clampPanelWidth(value){const viewportMax=Math.max(420,Math.min(720,Math.floor(window.innerWidth*.48)));return Math.max(400,Math.min(viewportMax,Math.round(Number(value)||DEFAULT_PANEL_WIDTH)));}
function applyPanelWidth(value){const width=clampPanelWidth(value);document.documentElement.style.setProperty('--dsh-panel-width',`${width}px`);return width;}
function loadPanelWidth(){applyPanelWidth(DEFAULT_PANEL_WIDTH);}

/* ─── 挂载 ─── */
function mount(){
  const panel=document.querySelector('.ai-panel');
  if(!panel)return;
  const status=navigatorState.status;
  const available=Boolean(status?.available);
  const embeddedVerified=available&&status?.uiMode==='embedded_experimental'&&status?.embeddedWeb?.verified===true;
  const webUrl=embeddedVerified&&typeof status?.webUrl==='string'&&status.webUrl?status.webUrl:'';
  panel.classList.add('harness-primary');
  panel.classList.toggle('harness-native',Boolean(webUrl));
  let root=panel.querySelector('[data-harness-navigator-mount]');
  if(!root){root=document.createElement('div');root.dataset.harnessNavigatorMount='';const anchor=panel.querySelector('.ai-chat')||panel.querySelector('.ai-foot');if(anchor)panel.insertBefore(root,anchor);else panel.append(root);lastMountedHtml='';}
  const html=webUrl?`<iframe class="harness-embed" src="${escapeHtml(webUrl)}" title="DeepSeek Harness" allow="clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe>`:cardHtml();
  if(lastMountedHtml!==html){root.innerHTML=html;lastMountedHtml=html;autoScroll();}
}
function scheduleMount(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;mount();});}
function autoScroll(){requestAnimationFrame(()=>{const el=document.querySelector('[data-tab-content="chat"]');if(el)el.scrollTop=el.scrollHeight;});}

/* ─── 状态加载 ─── */
async function loadStatus(force=false){
  if(navigatorState.statusLoading||(!force&&navigatorState.status))return;
  navigatorState.statusLoading=true;scheduleMount();
  try{
    const payload=await jsonRequest('/api/harness/status');
    navigatorState.status=payload.navigator||null;navigatorState.error='';
  }catch(error){
    if(String(error.message).includes('请先登录')||error.message==='未登录'){navigatorState.status={enabled:false,available:false,state:'auth',reason:'auth_required',message:'登录后将检查 Harness Navigator。'};return;}
    navigatorState.status={enabled:false,available:false,state:'error',message:'无法读取 Harness 状态。'};navigatorState.error=error.message;
  }finally{navigatorState.statusLoading=false;scheduleMount();}
}

/* ─── 导航 ─── */
function applyNavigation(navigation){if(!navigation?.view)return;const hash=navigation.id?`#${navigation.view}/${encodeURIComponent(navigation.id)}`:`#${navigation.view}`;if(location.hash!==hash)location.hash=hash;if(navigation.modal==='settings'||navigation.modal==='new_project'){setTimeout(()=>{const action=navigation.modal==='settings'?'settings':'new-project';document.querySelector(`[data-action="${action}"]`)?.click();},80);}}

/* ─── 发送消息 ─── */
async function sendMessage(message){
  const text=String(message||'').trim();
  if(!text||navigatorState.busy)return;
  if(!navigatorState.currentSessionId)createSession(compact(text,28));
  pushMessage({role:'user',text,time:Date.now()});
  navigatorState.busy=true;navigatorState.error='';navigatorState.trajectory=[];navigatorState.thinkBlocks=[];navigatorState.metrics=null;
  navigatorState.abortController=new AbortController();
  scheduleMount();
  try{
    const route=currentRoute();
    const payload=await jsonRequest('/api/harness/navigator',{
      method:'POST',
      body:JSON.stringify({message:text,sessionId:navigatorState.sessionId,view:route.view,id:route.id}),
      signal:navigatorState.abortController.signal
    });
    const result=payload.navigator||{};
    navigatorState.sessionId=result.sessionId||navigatorState.sessionId;
    const thinkText=(result.thinkBlocks&&result.thinkBlocks.length)?result.thinkBlocks.join('\n\n'):null;
    pushMessage({role:'assistant',text:result.reply||'本轮没有可显示的回复。',time:Date.now(),think:thinkText,skills:result.skillCalls||[]});
    navigatorState.trajectory=Array.isArray(result.trajectory)?result.trajectory:[];
    navigatorState.metrics=result.metrics||null;
    navigatorState.status=payload.status||navigatorState.status;
    applyNavigation(result.navigation);
    updateCurrentSession();
  }catch(error){
    if(error.name==='AbortError'){
      pushMessage({role:'assistant',text:'（已停止生成）',time:Date.now()});
    }else{
      const msg=error.message||'Navigator 执行失败。';
      if(error.code==='HARNESS_SESSION_BUSY')navigatorState.messages.pop();
      await loadStatus(true);navigatorState.error=msg;
    }
  }finally{
    navigatorState.busy=false;navigatorState.abortController=null;scheduleMount();
  }
}

function pushMessage(message){
  navigatorState.messages.push(message);
  if(navigatorState.messages.length>80)navigatorState.messages.splice(0,navigatorState.messages.length-80);
}

/* ─── 停止生成 ─── */
function stopGeneration(){
  if(navigatorState.abortController){navigatorState.abortController.abort();navigatorState.abortController=null;}
  navigatorState.busy=false;scheduleMount();
}

/* ─── 语音输入 ─── */
function toggleVoiceInput(){
  if(navigatorState.recording){stopVoiceInput();return;}
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRecognition){
    navigatorState.error='当前浏览器不支持语音输入（需要 Chrome 或 Edge）';scheduleMount();
    setTimeout(()=>{navigatorState.error='';scheduleMount();},3000);
    return;
  }
  const textarea=document.querySelector('[data-harness-form] textarea[name="message"]');
  if(!textarea||textarea.disabled)return;
  const recognition=new SpeechRecognition();
  recognition.lang='zh-CN';
  recognition.continuous=true;
  recognition.interimResults=true;
  const baseText=textarea.value;
  let finalBuffer='';
  recognition.onresult=event=>{
    let interim='';
    for(let i=event.resultIndex;i<event.results.length;i++){
      const result=event.results[i];
      if(result.isFinal){finalBuffer+=result[0].transcript;}
      else{interim+=result[0].transcript;}
    }
    textarea.value=baseText+finalBuffer+interim;
    textarea.style.height='auto';textarea.style.height=`${Math.min(textarea.scrollHeight,180)}px`;
  };
  recognition.onerror=event=>{
    navigatorState.recording=false;navigatorState.speechRecognition=null;
    if(event.error==='no-speech'||event.error==='aborted')return;
    navigatorState.error='语音识别出错：'+event.error;scheduleMount();
    setTimeout(()=>{navigatorState.error='';scheduleMount();},3000);
  };
  recognition.onend=()=>{
    if(navigatorState.recording){
      navigatorState.recording=false;navigatorState.speechRecognition=null;scheduleMount();
    }
  };
  try{
    recognition.start();
    navigatorState.recording=true;navigatorState.speechRecognition=recognition;scheduleMount();
  }catch(e){
    navigatorState.error='启动语音输入失败';scheduleMount();
    setTimeout(()=>{navigatorState.error='';scheduleMount();},3000);
  }
}
function stopVoiceInput(){
  if(navigatorState.speechRecognition){try{navigatorState.speechRecognition.stop();}catch(e){}}
  navigatorState.recording=false;navigatorState.speechRecognition=null;scheduleMount();
}

/* ─── 切换模型 ─── */
async function switchModel(model){
  if(!model||navigatorState.busy)return;
  navigatorState.busy=true;scheduleMount();
  try{
    const payload=await jsonRequest('/api/harness/switch-model',{method:'POST',body:JSON.stringify({model})});
    if(payload.status)navigatorState.status=payload.status;
  }catch(error){
    navigatorState.error=error.message||'模型切换失败';
  }finally{
    navigatorState.busy=false;scheduleMount();
  }
}

/* ─── 调整大小 ─── */
function beginResize(event){
  const handle=event.target.closest?.('[data-harness-resize]');
  if(!handle||event.button!==0||window.innerWidth<=900)return;
  event.preventDefault();
  const startX=event.clientX;
  const current=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-panel-width'))||DEFAULT_PANEL_WIDTH;
  document.documentElement.classList.add('dsh-resizing');
  const move=moveEvent=>applyPanelWidth(current+(startX-moveEvent.clientX));
  const end=endEvent=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',end);document.documentElement.classList.remove('dsh-resizing');applyPanelWidth(current+(startX-endEvent.clientX));};
  document.addEventListener('pointermove',move);document.addEventListener('pointerup',end,{once:true});document.addEventListener('pointercancel',end,{once:true});
}

/* ─── 事件绑定 ─── */
document.addEventListener('pointerdown',beginResize);

document.addEventListener('click',event=>{
  const trigger=event.target.closest?.('[data-ux-action="morning-focus"]');
  if(!trigger||!document.querySelector('.ai-panel.harness-primary'))return;
  event.preventDefault();event.stopImmediatePropagation();
  void sendMessage('开始早晨对焦：请先读取我的今日、最近待办和临近截止项目，用简短问题和我确认今天真正要推进的事项。不要自动调整优先级或修改任务。');
},true);

document.addEventListener('submit',event=>{
  const form=event.target.closest?.('[data-harness-form]');
  if(!form)return;
  event.preventDefault();
  const input=form.elements.message;
  const message=input?.value||'';
  if(input){input.value='';input.style.height='auto';}
  void sendMessage(message);
});

document.addEventListener('keydown',event=>{
  const input=event.target.closest?.('[data-harness-form] textarea[name="message"]');
  if(!input||event.key!=='Enter'||event.shiftKey||event.isComposing)return;
  event.preventDefault();input.form?.requestSubmit();
});

document.addEventListener('input',event=>{
  const input=event.target.closest?.('[data-harness-form] textarea[name="message"]');
  if(!input)return;
  input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,180)}px`;
});

document.addEventListener('click',event=>{
  // 快捷提示
  const suggestion=event.target.closest?.('[data-harness-suggest]');
  if(suggestion){void sendMessage(suggestion.dataset.harnessSuggest);return;}
  // 新对话
  if(event.target.closest?.('[data-harness-new]')){
    if(navigatorState.busy)return;
    createSession();scheduleMount();return;
  }
  // 重新检查
  if(event.target.closest?.('[data-harness-refresh]')){void loadStatus(true);return;}
  // 停止生成
  if(event.target.closest?.('[data-harness-stop]')){stopGeneration();return;}
  // 语音输入
  if(event.target.closest?.('[data-harness-mic]')){toggleVoiceInput();return;}
  // 模型切换
  const modelSelect=event.target.closest?.('[data-harness-model-switch]');
  if(modelSelect&&event.type==='change'){void switchModel(modelSelect.value);return;}
  // 标签切换
  const tabBtn=event.target.closest?.('[data-tab]');
  if(tabBtn){
    navigatorState.activeTab=tabBtn.dataset.tab;
    scheduleMount();return;
  }
  // 会话列表切换
  const sessionsToggle=event.target.closest?.('[data-harness-sessions-toggle]');
  if(sessionsToggle){
    const panel=document.querySelector('[data-sessions-panel]');
    if(panel)panel.style.display=panel.style.display==='none'?'block':'none';
    return;
  }
  if(event.target.closest?.('[data-harness-sessions-close]')){
    const panel=document.querySelector('[data-sessions-panel]');
    if(panel)panel.style.display='none';
    return;
  }
  const sessionItem=event.target.closest?.('[data-session-id]');
  if(sessionItem&&!event.target.closest('[data-del-session]')){
    switchSession(sessionItem.dataset.sessionId);return;
  }
  const delBtn=event.target.closest?.('[data-del-session]');
  if(delBtn){deleteSession(delBtn.dataset.delSession);scheduleMount();return;}
  // 复制
  const copyBtn=event.target.closest?.('[data-copy-idx]');
  if(copyBtn){
    const idx=parseInt(copyBtn.dataset.copyIdx);
    const msg=navigatorState.messages[idx];
    if(msg){navigator.clipboard.writeText(msg.text).then(()=>{copyBtn.textContent='已复制';setTimeout(()=>copyBtn.textContent='复制',1500);});}
    return;
  }
  // 分支
  const branchBtn=event.target.closest?.('[data-branch-idx]');
  if(branchBtn){branchSession(parseInt(branchBtn.dataset.branchIdx));return;}
  // 反馈
  const fbBtn=event.target.closest?.('[data-fb-idx]');
  if(fbBtn){
    const idx=parseInt(fbBtn.dataset.fbIdx);
    const msg=navigatorState.messages[idx];
    if(msg){msg.feedback=fbBtn.dataset.fb;scheduleMount();}
    return;
  }
});

window.addEventListener('resize',()=>applyPanelWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-panel-width'))||DEFAULT_PANEL_WIDTH));

/* ─── 初始化 ─── */
new MutationObserver(scheduleMount).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
window.addEventListener('hashchange',scheduleMount);
loadPanelWidth();
navigatorState.sessions=loadSessions();
loadStatus();
setInterval(()=>{if(!navigatorState.status||navigatorState.status.reason==='auth_required')void loadStatus(true);},3000);
scheduleMount();
