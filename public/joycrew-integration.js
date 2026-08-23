const {esc:jcEscape,attr:jcAttr,compact:jcCompact,fmtTime:jcTime}=window.WB;
const joycrewFetch=window.fetch.bind(window);
const operationsState={
  status:null,
  overview:null,
  detail:null,
  actions:[],
  selectedProjectId:null,
  loading:false,
  detailLoading:false,
  error:'',
  notice:'',
  revision:0,
  loaded:false
};
let operationsScheduled=false;

function jcDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleDateString('zh-CN',{year:'numeric',month:'numeric',day:'numeric'});}
function jcRoute(){return window.WB.currentView();}
function isOperations(){return jcRoute()==='operations';}
function markOperationsDirty(){operationsState.revision+=1;scheduleOperationsMount();}

async function jcJson(url,options={}){
  const response=await joycrewFetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(payload.error||payload.message||`请求失败 ${response.status}`);error.code=payload.code||payload.errorCode;throw error;}
  return payload;
}

function statusReason(reason){
  const reasons={
    disabled:'尚未启用 Joycrew 服务连接。',
    base_url_invalid:'JOYCREW_BASE_URL 无效。',
    base_url_unsafe:'Joycrew 地址不能包含用户名、密码、查询参数或片段。',
    base_url_protocol:'Joycrew 地址只允许 HTTP 或 HTTPS。',
    https_required:'公网 Joycrew 必须使用 HTTPS。',
    loopback_required:'local_loopback 模式只允许本机回环地址。',
    private_host_required:'private_http 模式只允许私网地址。',
    auth_mode_invalid:'Joycrew 认证模式无效。',
    fixture_forbidden:'生产环境禁止 Fixture 身份。',
    proxy_token_missing:'Trusted Proxy Token 尚未配置或长度不足。',
    session_token_missing:'Signed Session Token 尚未配置。',
    role_invalid:'Joycrew 角色配置无效。'
  };
  return reasons[reason]||'Joycrew 当前不可用。';
}

function operationsData(){
  const overview=operationsState.overview||{};
  const bootstrap=overview.bootstrap||{};
  return{
    overview,
    bootstrap,
    projects:Array.isArray(bootstrap.projects)?bootstrap.projects:[],
    employees:Array.isArray(bootstrap.employees)?bootstrap.employees:[],
    runs:Array.isArray(bootstrap.runs)?bootstrap.runs:[],
    approvals:Array.isArray(bootstrap.approvals)?bootstrap.approvals:[],
    deliverables:Array.isArray(bootstrap.deliverables)?bootstrap.deliverables:[],
    customers:Array.isArray(overview.customers)?overview.customers:[],
    tasks:Array.isArray(overview.tasks)?overview.tasks:[]
  };
}

function upgradeHarnessCard(){
  const card=document.querySelector('[data-harness-navigator]');
  if(!card)return;
  const signature=operationsState.status?.available?'connected':'disconnected';
  if(card.dataset.joycrewUnified===signature)return;
  card.dataset.joycrewUnified=signature;
  const kicker=card.querySelector('.harness-nav-kicker');if(kicker&&kicker.textContent!=='DEEPSEEK HARNESS · UNIFIED')kicker.textContent='DEEPSEEK HARNESS · UNIFIED';
  const title=card.querySelector('.harness-nav-head strong');if(title&&title.textContent!=='统一工作 Copilot')title.textContent='统一工作 Copilot';
  const subtitle=card.querySelector('.harness-nav-head p');if(subtitle&&subtitle.textContent!=='连续会话 · Workbench + Joycrew · 操作预览')subtitle.textContent='连续会话 · Workbench + Joycrew · 操作预览';
  const boundary=card.querySelector('.harness-nav-boundary');
  if(boundary)boundary.innerHTML='<span>读取个人与业务状态</span><span>生成操作预览</span><span>无 Shell</span><span>外部改变需页面确认</span>';
  const status=card.querySelector('.harness-nav-status.ready');if(status&&status.textContent==='只读就绪')status.textContent='协同就绪';
  const foot=card.querySelector('.harness-nav-foot');
  if(foot)foot.innerHTML=`${operationsState.status?.available?'Joycrew 已连接 · ':''}改变 Joycrew 的动作只生成短时预览；请到“业务执行”页面确认。`;
  const suggestions=card.querySelector('.harness-nav-suggestions');
  if(suggestions&&!suggestions.querySelector('[data-joycrew-harness-suggest]')){
    const button=document.createElement('button');button.type='button';button.dataset.harnessSuggest='打开业务执行并查看业务总览';button.dataset.joycrewHarnessSuggest='';button.textContent='查看业务总览';suggestions.append(button);
  }
}

function mountOperationsNavigation(){
  upgradeHarnessCard();
  const nav=document.querySelector('.sidebar .nav');
  if(!nav)return;
  let link=nav.querySelector('[data-joycrew-nav]');
  if(!link){
    const journal=nav.querySelector('a[href="#journal"]');
    const holder=document.createElement('div');
    holder.className='joycrew-nav-holder';
    holder.innerHTML='<a href="#operations" data-joycrew-nav><span aria-hidden="true">✦</span> 业务执行<span class="joycrew-nav-dot"></span></a>';
    if(journal?.parentElement===nav)journal.insertAdjacentElement('afterend',holder);
    else nav.prepend(holder);
    link=holder.querySelector('[data-joycrew-nav]');
  }
  link.classList.toggle('active',isOperations());
  const dot=link.querySelector('.joycrew-nav-dot');
  if(dot){
    const status=operationsState.status;
    dot.className=`joycrew-nav-dot ${status?.available?'ready':status?.enabled?'warning':'muted'}`;
    dot.title=status?.available?'Joycrew 已连接':statusReason(status?.reason);
  }
}

function statusCard(){
  const status=operationsState.status;
  if(operationsState.loading&&!status)return'<section class="jc-card jc-status"><div class="jc-spinner"></div><div><strong>正在连接 Joycrew</strong><p>个人今日、收件箱和项目文件不受影响。</p></div></section>';
  if(!status)return'<section class="jc-card jc-status warning"><div><strong>尚未读取 Joycrew 状态</strong><p>点击刷新检查连接。</p></div></section>';
  if(!status.available){
    return`<section class="jc-card jc-status warning"><div><strong>${status.enabled?'Joycrew 配置尚未就绪':'Joycrew 尚未启用'}</strong><p>${jcEscape(status.error||statusReason(status.reason))}</p><details><summary>服务端配置边界</summary><pre>JOYCREW_ENABLED=1\nJOYCREW_BASE_URL=http://127.0.0.1:4000\nJOYCREW_NETWORK_ZONE=local_loopback\nJOYCREW_AUTH_MODE=trusted_proxy\nJOYCREW_TRUSTED_PROXY_TOKEN=...\nJOYCREW_WORKSPACE_ID=ws-dongjue\nJOYCREW_USER_ID=user-chris\nJOYCREW_ROLE=admin</pre><p>凭据只保存在 Workbench 服务端环境变量中，不进入浏览器和工作台状态。</p></details></div></section>`;
  }
  const health=status.health||{};
  return`<section class="jc-card jc-status ready"><div class="jc-status-icon">✓</div><div><strong>Joycrew 已连接</strong><p>${jcEscape(health.persistence||'unknown')} 持久化 · ${jcEscape(health.authMode||status.authMode||'unknown')} 身份 · ${jcEscape(health.runtime||'runtime unknown')} · 按需读取</p></div><span class="jc-chip success">${jcEscape(status.workspaceId||'workspace')}</span></section>`;
}

function metricCard(label,value,note){return`<div class="jc-metric"><strong>${Number.isFinite(Number(value))?Number(value):0}</strong><span>${jcEscape(label)}</span><small>${jcEscape(note||'')}</small></div>`;}
function pill(value,tone=''){return`<span class="jc-pill ${tone}">${jcEscape(value||'—')}</span>`;}
function projectStatusTone(value){return value==='blocked'?'danger':value==='active'?'blue':value==='completed'?'success':value==='waiting'?'warning':'';}
function runStatusTone(value){return value==='succeeded'?'success':value==='failed'?'danger':value==='running'?'blue':value==='queued'?'warning':'';}

function projectListHtml(projects){
  if(!projects.length)return'<div class="jc-empty">当前 Workspace 没有 Joycrew 项目。</div>';
  return projects.map(project=>`<button type="button" class="jc-project-row ${operationsState.selectedProjectId===project.id?'selected':''}" data-joycrew-action="open-project" data-project-id="${jcAttr(project.id)}"><span><strong>${jcEscape(project.title)}</strong><small>${jcEscape(project.stage||'未设置阶段')}</small></span><span>${pill(project.status,projectStatusTone(project.status))}<small>${project.dueAt?`截止 ${jcEscape(jcDate(project.dueAt))}`:jcEscape(project.priority||'')}</small></span></button>`).join('');
}

function employeeHtml(employees){
  if(!employees.length)return'<div class="jc-empty">当前身份没有可调用的 AI 员工。</div>';
  return employees.map(employee=>`<div class="jc-employee"><div class="jc-avatar">AI</div><div><strong>${jcEscape(employee.name)}</strong><p>${jcEscape(employee.role)}</p><small>${jcEscape((employee.skillVersions||[]).join(' · '))}</small></div>${pill(employee.readiness,employee.readiness==='ready'?'success':'warning')}</div>`).join('');
}

function runHtml(runs,{detail=false}={}){
  if(!runs.length)return'<div class="jc-empty">还没有 Run。运行 AI 员工后，Evidence 会在这里出现。</div>';
  return runs.slice(0,detail?30:8).map(run=>{
    const evidence=run.evidence;
    const deliverableAction=run.status==='succeeded'&&run.evidencePackageId?`<button class="btn small" type="button" data-joycrew-action="prepare-deliverable" data-run-id="${jcAttr(run.id)}" data-run-title="${jcAttr(run.output?.summary||run.task||'阶段分析')}">生成交付预览</button>`:'';
    return`<article class="jc-run"><div class="jc-row-head"><div><strong>${jcEscape(run.output?.summary||run.task||run.id)}</strong><small>${jcEscape(run.employeeId||'AI 员工')} · ${jcTime(run.startedAt)}</small></div>${pill(run.status,runStatusTone(run.status))}</div>${run.errorMessage?`<p class="jc-error-text">${jcEscape(run.errorMessage)}</p>`:''}${evidence?evidenceSummary(evidence):''}<div class="jc-actions">${deliverableAction}</div></article>`;
  }).join('');
}

function evidenceSummary(evidence){
  const facts=Array.isArray(evidence.facts)?evidence.facts:[];
  const conflicts=Array.isArray(evidence.conflicts)?evidence.conflicts:[];
  const missing=Array.isArray(evidence.missingInformation)?evidence.missingInformation:[];
  return`<div class="jc-evidence"><span>Evidence ${jcEscape(evidence.evidencePackageId||'')}</span><div><b>${facts.length}</b> 事实 · <b>${conflicts.length}</b> 冲突 · <b>${missing.length}</b> 缺失 · 数据截至 ${jcEscape(jcTime(evidence.dataAsOf))}</div>${facts.slice(0,3).map(item=>`<p>• ${jcEscape(item.statement)}</p>`).join('')}${conflicts.slice(0,2).map(item=>`<p class="warn">冲突：${jcEscape(item.statement)}</p>`).join('')}${missing.slice(0,2).map(item=>`<p class="muted">缺失：${jcEscape(item)}</p>`).join('')}</div>`;
}

function actionHtml(actions){
  if(!actions.length)return'<div class="jc-empty">没有等待确认或需要核对的 Joycrew 操作。Harness 和页面生成的预览都会集中在这里。</div>';
  return actions.map(action=>{
    const uncertain=action.status==='uncertain';
    const controls=uncertain
      ?'<button class="btn small primary" type="button" data-joycrew-action="refresh">刷新业务状态并核对</button>'
      :`<button class="btn small" type="button" data-joycrew-action="cancel-action" data-action-id="${jcAttr(action.id)}">取消</button><button class="btn small primary" type="button" data-joycrew-action="confirm-action" data-action-id="${jcAttr(action.id)}">确认并执行</button>`;
    const warning=uncertain?`<div class="jc-action-warning">${jcEscape(action.error?.message||'结果不确定。为避免重复创建 Run、交付或写回，系统已禁止直接重试。')}</div>`:'';
    return`<article class="jc-action-card ${uncertain?'uncertain':''}"><div class="jc-row-head"><div><small>${jcEscape(action.type)} · ${jcEscape(action.source)}</small><strong>${jcEscape(action.title)}</strong></div>${pill(action.status,uncertain?'danger':action.status==='pending'?'warning':'blue')}</div><p>${jcEscape(action.summary)}</p>${warning}<ul>${(action.effects||[]).map(effect=>`<li>${jcEscape(effect)}</li>`).join('')}</ul><details><summary>参数与摘要</summary><pre>${jcEscape(JSON.stringify(action.payload,null,2))}</pre><small>${jcEscape(action.digest)}</small></details><div class="jc-actions">${controls}</div></article>`;
  }).join('');
}

function approvalHtml(approvals){
  if(!approvals.length)return'<div class="jc-empty">没有可见的写回审批。</div>';
  return approvals.slice(0,10).map(approval=>`<article class="jc-approval"><div><strong>${jcEscape(approval.proposal?.change?.field||'写回审批')}</strong><p>${jcEscape(approval.proposal?.reason||approval.id)}</p><small>${jcEscape(approval.projectId)} · ${jcTime(approval.requestedAt)}</small></div>${pill(approval.status,approval.status==='pending'?'warning':approval.status==='executed'?'success':'')}${approval.status==='pending'?`<div class="jc-actions"><button class="btn small" type="button" data-joycrew-action="prepare-approval" data-approval-id="${jcAttr(approval.id)}" data-decision="reject">拒绝预览</button><button class="btn small primary" type="button" data-joycrew-action="prepare-approval" data-approval-id="${jcAttr(approval.id)}" data-decision="approve">批准预览</button></div>`:''}</article>`).join('');
}

function deliverableHtml(deliverables){
  if(!deliverables.length)return'<div class="jc-empty">还没有正式交付。</div>';
  return deliverables.slice(0,12).map(item=>`<div class="jc-deliverable"><div><strong>${jcEscape(item.title)}</strong><p>${jcEscape(item.relativePath||item.uri)}</p><small>Run ${jcEscape(item.runId)} · ${jcTime(item.createdAt)}</small></div><span class="jc-hash">${jcEscape(String(item.contentHash||'').slice(0,12))}</span></div>`).join('');
}

function businessHtml(customers,tasks){
  const activeTasks=tasks.filter(task=>!['done','cancelled'].includes(task.status));
  return`<div class="jc-business-grid"><section><div class="jc-section-head"><strong>客户</strong><span>${customers.length}</span></div>${customers.slice(0,8).map(customer=>`<div class="jc-business-row"><div><strong>${jcEscape(customer.name)}</strong><small>${jcEscape(customer.nextAction||customer.contactName||'暂无下一步')}</small></div>${pill(customer.status,customer.status==='active'?'success':'')}</div>`).join('')||'<div class="jc-empty">暂无客户。</div>'}</section><section><div class="jc-section-head"><strong>业务任务</strong><span>${activeTasks.length}</span></div>${activeTasks.slice(0,8).map(task=>`<div class="jc-business-row"><div><strong>${jcEscape(task.title)}</strong><small>${jcEscape(task.description||task.projectId||'独立业务任务')}</small></div>${pill(task.status,task.status==='blocked'?'danger':task.status==='in_progress'?'blue':'')}</div>`).join('')||'<div class="jc-empty">暂无未完成业务任务。</div>'}</section></div>`;
}

function sourceRows(project){
  const sources=Array.isArray(project?.sources)?project.sources:[];
  const supported=sources.filter(source=>source.type==='feishu_bitable'||['local_filesystem_bridge','server_filesystem'].includes(source.type));
  if(!supported.length)return'<div class="jc-empty">此项目没有可供 Run 使用的 DataWeave 来源。</div>';
  return supported.map((source,index)=>{
    const records=source.type==='feishu_bitable';
    const path=source.relativePath?`${String(source.relativePath).replace(/\/$/,'')}/docs/project-context.md`:'';
    const checked=records||source.type==='server_filesystem';
    return`<label class="jc-source"><input type="checkbox" name="jc-source" value="${jcAttr(source.sourceId)}" data-source-index="${index}" ${checked?'checked':''}><span><strong>${jcEscape(source.role||source.type)}</strong><small>${jcEscape(source.type)} · ${jcEscape(source.access||'read_on_demand')}</small>${records?'':`<input class="jc-source-path" data-path-source="${jcAttr(source.sourceId)}" value="${jcAttr(path)}" placeholder="受控项目文件相对路径">`}</span></label>`;
  }).join('');
}

function runComposer(projects,employees){
  if(!projects.length||!employees.length)return'<div class="jc-empty">需要至少一个可访问项目和一个已授权 AI 员工。</div>';
  const selected=projects.find(item=>item.id===operationsState.selectedProjectId)||projects[0];
  operationsState.selectedProjectId=selected.id;
  return`<form class="jc-run-form" data-joycrew-run-form><label>企业项目<select name="projectId" data-joycrew-project-select>${projects.map(project=>`<option value="${jcAttr(project.id)}" ${project.id===selected.id?'selected':''}>${jcEscape(project.title)} · ${jcEscape(project.stage||project.status)}</option>`).join('')}</select></label><label>AI 员工<select name="employeeId">${employees.map(employee=>`<option value="${jcAttr(employee.id)}">${jcEscape(employee.name)} · ${jcEscape(employee.version)}</option>`).join('')}</select></label><label class="jc-wide">交给 AI 员工的明确任务<textarea name="task" rows="4" minlength="3" maxlength="4000" required>读取当前项目状态和所选资料，区分事实、推论、冲突与缺失信息，给出已完成、当前判断、阻塞和下一步建议。</textarea></label><fieldset class="jc-wide"><legend>本次明确读取的数据源</legend><p>不自动同步；只有勾选的来源会交给 DataWeave。</p>${sourceRows(selected)}</fieldset><div class="jc-wide jc-actions"><button type="submit" class="btn primary">生成 Run 操作预览</button></div></form>`;
}

function projectDetailHtml(detail){
  if(operationsState.detailLoading)return'<section class="jc-card"><div class="jc-spinner"></div> 正在读取项目 Run 与 Evidence…</section>';
  if(!detail)return'';
  const project=detail.project||{};
  return`<section class="jc-card jc-detail"><div class="jc-section-head"><div><small>项目详情</small><h2>${jcEscape(project.title||project.id)}</h2><p>${jcEscape(project.stage||'')}</p></div><button class="btn small" type="button" data-joycrew-action="close-project">关闭</button></div><div class="jc-context-grid"><div><span>上次完成</span><p>${jcEscape(project.lastCompleted||'以飞书项目文档为长期叙事真源')}</p></div><div><span>当前判断</span><p>${jcEscape(project.currentThinking||'按需读取')}</p></div><div><span>下一步</span><p>${jcEscape(project.nextAction||'尚未记录')}</p></div><div><span>阻塞</span><p>${jcEscape(project.blocker||'无')}</p></div></div><div class="jc-section-head"><strong>Run 与 Evidence</strong><span>${(detail.runs||[]).length}</span></div>${runHtml(detail.runs||[],{detail:true})}<div class="jc-two-col"><section><div class="jc-section-head"><strong>项目审批</strong></div>${approvalHtml(detail.approvals||[])}</section><section><div class="jc-section-head"><strong>项目交付</strong></div>${deliverableHtml(detail.deliverables||[])}</section></div></section>`;
}

let jcOperationsTab='main';

function operationsHtml(){
  const data=operationsData();
  const status=operationsState.status;
  const connected=Boolean(status?.available&&operationsState.overview);
  const pending=operationsState.actions.filter(action=>['pending','executing','uncertain'].includes(action.status));
  const tabBtn=(key,label,count)=>`<button type="button" class="jc-tab ${jcOperationsTab===key?'on':''}" data-jc-tab="${key}">${label}${count!=null?`<span class="jc-tab-count">${count}</span>`:''}</button>`;
  const pendingCount=pending.length;
  const tabHtml=`<div class="jc-tabs">${tabBtn('main','项目与运行',data.projects.length)}${tabBtn('crew','AI 员工与 Run',null)}${tabBtn('pending','待确认',pendingCount)}${tabBtn('review','审批与交付',null)}${tabBtn('business','客户任务',null)}</div>`;
  let tabContent='';
  if(jcOperationsTab==='main')tabContent=`<section class="jc-grid-main"><div class="jc-stack"><section class="jc-card"><div class="jc-section-head"><div><strong>企业项目</strong><p>业务执行上下文；个人今日仍由 Workbench 管理。</p></div><span>${data.projects.length}</span></div>${projectListHtml(data.projects)}</section><section class="jc-card"><div class="jc-section-head"><div><strong>运行 AI 员工</strong><p>先生成预览，确认后才创建 Joycrew Run。</p></div></div>${runComposer(data.projects,data.employees)}</section></div><aside class="jc-stack"><section class="jc-card"><div class="jc-section-head"><strong>最近 Run</strong><span>${data.runs.length}</span></div>${runHtml(data.runs)}</section></aside></section>${projectDetailHtml(operationsState.detail)}`;
  else if(jcOperationsTab==='crew')tabContent=`<section class="jc-grid-main"><aside class="jc-stack"><section class="jc-card"><div class="jc-section-head"><strong>AI 员工</strong><span>${data.employees.length}</span></div>${employeeHtml(data.employees)}</section><section class="jc-card"><div class="jc-section-head"><strong>Run 历史</strong><span>${data.runs.length}</span></div>${runHtml(data.runs,{detail:true})}</section></aside></section>${projectDetailHtml(operationsState.detail)}`;
  else if(jcOperationsTab==='pending')tabContent=`<section class="jc-card jc-pending"><div class="jc-section-head"><div><strong>等待你确认</strong><p>Harness 与页面只会生成预览；这里是唯一执行入口。</p></div><span>${pending.length}</span></div>${actionHtml(pending)}</section>`;
  else if(jcOperationsTab==='review')tabContent=`<section class="jc-two-col"><div class="jc-card"><div class="jc-section-head"><strong>写回审批</strong><span>${data.approvals.length}</span></div>${approvalHtml(data.approvals)}</div><div class="jc-card"><div class="jc-section-head"><strong>正式交付</strong><span>${data.deliverables.length}</span></div>${deliverableHtml(data.deliverables)}</div></section>`;
  else if(jcOperationsTab==='business')tabContent=`<section class="jc-card"><div class="jc-section-head"><div><strong>客户与业务任务</strong><p>此处为 Joycrew 当前业务视图；个人收件箱不在此复制。</p></div></div>${businessHtml(data.customers,data.tasks)}</section>`;
  return`<div class="jc-page" id="jc-operations-page">${operationsState.error?`<div class="jc-banner error">${jcEscape(operationsState.error)}<button type="button" data-joycrew-action="dismiss-error">×</button></div>`:''}${operationsState.notice?`<div class="jc-banner success">${jcEscape(operationsState.notice)}<button type="button" data-joycrew-action="dismiss-notice">×</button></div>`:''}${statusCard()}${connected?`<section class="jc-metrics">${metricCard('企业项目',data.projects.length,'Joycrew Workspace')}${metricCard('可用 AI 员工',data.employees.filter(item=>item.readiness==='ready').length,'Employee Grant 后可见')}${metricCard('待审批写回',data.approvals.filter(item=>item.status==='pending').length,'仍需人工确认')}${metricCard('正式交付',data.deliverables.length,'可回链到 Run/Evidence')}</section>${tabHtml}${tabContent}`:'<section class="jc-card"><div class="jc-empty"><strong>个人工作台已正常运行。</strong><p>配置并启动 Joycrew 后，这里会原生显示企业项目、AI 员工、Run、Evidence、审批和交付，不需要打开第二套工作台。</p></div></section>'}</div>`;
}

function mountOperationsPage(force=false){
  mountOperationsNavigation();
  if(!isOperations())return;
  const main=document.querySelector('.content .main');
  const title=document.querySelector('.content .topbar h1');
  const description=document.querySelector('.content .topbar p');
  const actions=document.querySelector('.content .topbar .actions');
  if(!main)return;
  if(title&&title.textContent!=='业务执行')title.textContent='业务执行';
  if(description&&description.textContent!=='Joycrew AI 员工 · Run · Evidence · 审批 · 交付')description.textContent='Joycrew AI 员工 · Run · Evidence · 审批 · 交付';
  if(actions&&!actions.dataset.joycrewActions){actions.dataset.joycrewActions='1';actions.innerHTML='<button class="btn" type="button" data-joycrew-action="refresh">刷新业务执行</button><a class="btn" href="#today">返回我的今日</a>';}
  const revision=String(operationsState.revision);
  if(!force&&main.dataset.joycrewOperations===revision)return;
  main.dataset.joycrewOperations=revision;
  main.innerHTML=operationsHtml();
  if(!operationsState.loaded&&!operationsState.loading)void loadOperations();
}

function scheduleOperationsMount(){
  if(operationsScheduled)return;
  operationsScheduled=true;
  queueMicrotask(()=>{operationsScheduled=false;mountOperationsPage();});
}

async function loadOperations(){
  operationsState.loading=true;operationsState.error='';markOperationsDirty();
  try{
    const statusPayload=await jcJson('/api/joycrew/status');
    operationsState.status=statusPayload.joycrew||null;
    const actionsPromise=jcJson('/api/joycrew/actions').catch(()=>({actions:[]}));
    if(operationsState.status?.available){
      const [overviewPayload,actionsPayload]=await Promise.all([jcJson('/api/joycrew/overview'),actionsPromise]);
      operationsState.overview=overviewPayload.overview||null;
      operationsState.actions=Array.isArray(actionsPayload.actions)?actionsPayload.actions:[];
      const projects=operationsData().projects;
      if(!projects.some(item=>item.id===operationsState.selectedProjectId))operationsState.selectedProjectId=projects[0]?.id||null;
    }else{
      operationsState.overview=null;
      const actionsPayload=await actionsPromise;
      operationsState.actions=Array.isArray(actionsPayload.actions)?actionsPayload.actions:[];
    }
    operationsState.loaded=true;
  }catch(error){operationsState.error=error.message||'无法读取 Joycrew。';operationsState.loaded=true;}
  finally{operationsState.loading=false;markOperationsDirty();}
}

async function loadActions(){
  const payload=await jcJson('/api/joycrew/actions');
  operationsState.actions=Array.isArray(payload.actions)?payload.actions:[];
}

async function openProject(projectId){
  operationsState.selectedProjectId=projectId;
  operationsState.detailLoading=true;operationsState.detail=null;operationsState.error='';markOperationsDirty();
  try{const payload=await jcJson(`/api/joycrew/projects/${encodeURIComponent(projectId)}`);operationsState.detail=payload.detail||null;}
  catch(error){operationsState.error=error.message;}
  finally{operationsState.detailLoading=false;markOperationsDirty();}
}

function selectedRunSources(form,project){
  const selected=[...form.querySelectorAll('input[name="jc-source"]:checked')].map(input=>input.value);
  const sources=[];
  for(const source of project.sources||[]){
    if(!selected.includes(source.sourceId))continue;
    if(source.type==='feishu_bitable')sources.push({kind:'records',sourceId:source.sourceId,entity:'Project',filters:[{field:'global_id',op:'eq',value:project.id}]});
    else if(['local_filesystem_bridge','server_filesystem'].includes(source.type)){
      const input=form.querySelector(`[data-path-source="${CSS.escape(source.sourceId)}"]`);
      const relativePath=String(input?.value||'').trim();
      if(!relativePath)throw new Error(`${source.role||source.sourceId} 需要明确文件相对路径。`);
      sources.push({kind:'file',sourceId:source.sourceId,relativePath});
    }
  }
  if(!sources.length)throw new Error('至少选择一个可读取的数据源。');
  return sources;
}

async function prepareAction(type,payload,source='operations-ui'){
  const response=await jcJson('/api/joycrew/actions/prepare',{method:'POST',body:JSON.stringify({type,payload,source})});
  operationsState.notice=`已生成「${response.action?.title||type}」预览。确认前 Joycrew 没有改变。`;
  await loadActions();
  markOperationsDirty();
}

async function submitRun(form){
  const data=operationsData();
  const formData=new FormData(form);
  const projectId=String(formData.get('projectId')||'');
  const project=data.projects.find(item=>item.id===projectId);
  if(!project)throw new Error('目标 Joycrew 项目不存在。');
  const payload={
    projectId,
    employeeId:String(formData.get('employeeId')||''),
    task:String(formData.get('task')||'').trim(),
    sources:selectedRunSources(form,project)
  };
  await prepareAction('run.create',payload);
}

async function executeAction(actionId){
  operationsState.notice='';operationsState.error='';markOperationsDirty();
  const payload=await jcJson(`/api/joycrew/actions/${encodeURIComponent(actionId)}/execute`,{method:'POST',body:JSON.stringify({confirmed:true})});
  operationsState.notice=`「${payload.action?.title||'Joycrew 操作'}」已执行并读回结果。`;
  operationsState.detail=null;
  await loadOperations();
}

async function cancelAction(actionId){
  await jcJson(`/api/joycrew/actions/${encodeURIComponent(actionId)}/cancel`,{method:'POST',body:'{}'});
  operationsState.notice='操作预览已取消，Joycrew 没有改变。';
  await loadActions();markOperationsDirty();
}

async function handleOperationsAction(element){
  const action=element.dataset.joycrewAction;
  try{
    element.disabled=true;
    if(action==='refresh'){operationsState.loaded=false;await loadOperations();return;}
    if(action==='dismiss-error'){operationsState.error='';markOperationsDirty();return;}
    if(action==='dismiss-notice'){operationsState.notice='';markOperationsDirty();return;}
    if(action==='open-project'){await openProject(element.dataset.projectId);return;}
    if(action==='close-project'){operationsState.detail=null;markOperationsDirty();return;}
    if(action==='confirm-action'){await executeAction(element.dataset.actionId);return;}
    if(action==='cancel-action'){await cancelAction(element.dataset.actionId);return;}
    if(action==='prepare-deliverable'){
      const title=window.prompt('正式交付标题',jcCompact(element.dataset.runTitle||'阶段分析',100));
      if(!title)return;
      await prepareAction('deliverable.create',{runId:element.dataset.runId,title});return;
    }
    if(action==='prepare-approval'){await prepareAction('approval.decide',{approvalId:element.dataset.approvalId,decision:element.dataset.decision});return;}
  }catch(error){operationsState.error=error.message||'业务执行失败。';markOperationsDirty();}
  finally{element.disabled=false;}
}

document.addEventListener('submit',event=>{
  const form=event.target.closest?.('[data-joycrew-run-form]');
  if(!form)return;
  event.preventDefault();event.stopImmediatePropagation();
  void submitRun(form).catch(error=>{operationsState.error=error.message;markOperationsDirty();});
},true);

document.addEventListener('click',event=>{
  const element=event.target.closest?.('[data-joycrew-action]');
  if(!element)return;
  event.preventDefault();event.stopImmediatePropagation();
  void handleOperationsAction(element);
},true);

document.addEventListener('click',event=>{
  const tab=event.target.closest?.('[data-jc-tab]');
  if(!tab)return;
  event.preventDefault();event.stopImmediatePropagation();
  jcOperationsTab=tab.dataset.jcTab;
  markOperationsDirty();
},true);

document.addEventListener('change',event=>{
  const select=event.target.closest?.('[data-joycrew-project-select]');
  if(!select)return;
  operationsState.selectedProjectId=select.value;markOperationsDirty();
});

// Expose render function for app.js direct calls
window.WB.renderOperations=()=>mountOperationsPage(true);
window.WB.operationsLoad=loadOperations;

window.addEventListener('hashchange',()=>{
  mountOperationsNavigation();
  if(isOperations()){operationsState.error='';scheduleOperationsMount();}
});
window.addEventListener('workbench:enhance',scheduleOperationsMount);
scheduleOperationsMount();
