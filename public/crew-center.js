// crew-center.js — AI 员工调度 + 技能入口 + 底座状态（场景 #39「个人工作台」）
// 数据源：GET /api/crew（服务端只读盘点 Codex agents / Codex skills / dsh skills / Hermes skills / dsh web 状态）
// 路由：#crew（员工调度） #skills（技能入口）
// 采用与 workbench-v3.js 一致的增强模式：不修改 app.js 渲染主链，渲染后替换 .main 内容。

const CREW_CACHE_KEY='crew-center-catalog-v1';
const FAV_KEY='crew-center-favorites-v1';
const SAFE_AGENT_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
let crewState=null; // {agents,skills,counts,harness,scannedAt}
let crewBusy=false;
let rendered=false;
let scheduled=false;

const {esc,attr,routePart,fmtTime,json,currentView,setTop,hideLegacyMain}=window.WB;
const shellQuote=value=>`'${String(value??'').replaceAll("'","'\"'\"")}'`;

function notify(message,error=false){
  window.WB.toast(message,error,3000);
}
// currentView provided by window.WB
function copyText(text){
  if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text).then(()=>true).catch(()=>false);
  try{const el=document.createElement('textarea');el.value=text;document.body.appendChild(el);el.select();const ok=document.execCommand('copy');el.remove();return Promise.resolve(ok);}catch{return Promise.resolve(false);}
}

function loadFavorites(){
  try{const raw=JSON.parse(localStorage.getItem(FAV_KEY)||'[]');return Array.isArray(raw)?new Set(raw.filter(x=>typeof x==='string')):new Set();}catch{return new Set();}
}
function saveFavorites(set){try{localStorage.setItem(FAV_KEY,JSON.stringify([...set]));}catch{}}
function favoriteKeys(){return loadFavorites();}
function toggleFavorite(key){
  const set=loadFavorites();if(set.has(key))set.delete(key);else set.add(key);saveFavorites(set);return set;
}

async function loadCrew(force=false){
  if(crewState&&!force)return crewState;
  if(crewBusy)return crewState||{agents:[],skills:[],counts:{},harness:{}};
  crewBusy=true;
  try{
    const data=await json('/api/crew');
    crewState={...data,loadedAt:Date.now()};
    try{sessionStorage.setItem(CREW_CACHE_KEY,JSON.stringify({at:Date.now(),data:{...data}}));}catch{}
  }catch(error){
    notify(`员工与技能目录读取失败：${error.message}`,true);
    try{const cached=JSON.parse(sessionStorage.getItem(CREW_CACHE_KEY)||'null');if(cached?.data)crewState=cached.data;}catch{}
  }finally{crewBusy=false;}
  return crewState||{agents:[],skills:[],counts:{},harness:{}};
}

// ---------- 底座状态 ----------
function harnessStatusHtml(h){
  if(!h)return'';
  const web=h.web||{};
  const alive=web.alive;
  return `<div class="crew-status-row">
    <div class="crew-status-item"><span class="crew-dot ${alive?'ok':'off'}"></span><div><strong>DeepSeek Harness Web</strong><span>${alive?`运行中 · ${web.port} · PID ${esc(web.pid||'—')}`:'离线'}</span></div>${alive?`<a class="btn small" href="http://127.0.0.1:${web.port}/" target="_blank" rel="noopener noreferrer">打开底座</a>`:''}</div>
    <div class="crew-status-item"><span class="crew-dot ${alive?'ok':'off'}"></span><div><strong>Harness 运行时</strong><span>${esc(h.version||'unknown')} · SDK Sidecar 模式</span></div></div>
  </div>`;
}

// ---------- 员工调度 ----------
function deptGroup(agent){
  const raw=String(agent.dept||'未标部门').replace(/。$/,'').trim();
  return raw.split('/')[0].trim()||'未标部门';
}
function riskBadge(risk){
  const r=String(risk||'');
  if(r.includes('高'))return'<span class="pill red">风险高</span>';
  if(r.includes('中'))return'<span class="pill amber">风险中</span>';
  if(r.includes('低'))return'<span class="pill green">风险低</span>';
  return'';
}
function sandboxBadge(sb){
  if(sb==='read-only')return'<span class="pill blue">只读</span>';
  if(sb==='workspace-write')return'<span class="pill amber">可写工作区</span>';
  return sb?`<span class="pill">${esc(sb)}</span>`:'';
}
function agentCard(a){
  const fav=favoriteKeys();
  const id=`agent:${a.id}`;
  const star=fav.has(id)?'★':'☆';
  const displayName=a.title||a.name;
  return `<div class="crew-agent">
    <div class="crew-agent-top"><div><div class="crew-agent-name">${esc(displayName)}</div><div class="crew-agent-meta">${riskBadge(a.risk)}${sandboxBadge(a.sandbox)}<span class="pill">${esc(a.name)}</span></div></div><button class="crew-star" data-crew-action="fav" data-key="${attr(id)}" title="常用置顶">${star}</button></div>
    <div class="crew-agent-desc">${esc(a.description||'（无岗位描述）')}</div>
    <div class="crew-actions"><button class="btn small" data-crew-action="copy-path" data-path="${attr(a.path)}">复制岗位文件路径</button><button class="btn small" data-crew-action="copy-dispatch" data-name="${attr(displayName)}" data-id="${attr(a.id)}">复制派单命令</button></div>
  </div>`;
}
function agentsByDept(agents){
  const map=new Map();
  for(const a of agents){
    const d=deptGroup(a);if(!map.has(d))map.set(d,[]);map.get(d).push(a);
  }
  return [...map.entries()].sort((x,y)=>x[0].localeCompare(y[0],'zh'));
}
function crewPageHtml(state){
  const agents=state.agents||[],counts=state.counts||{};
  const favs=favoriteKeys();
  const favAgents=agents.filter(a=>favs.has(`agent:${a.id}`));
  const rest=agents.filter(a=>!favs.has(`agent:${a.id}`));
  const groups=[...agentsByDept(rest)];
  const totalSkill=Number(counts.totalSkills||0);
  return `<div id="crew-center" class="crew-page">
    <div class="crew-hero">
      <div class="crew-metric"><strong>${agents.length}</strong><span>数字员工</span></div>
      <div class="crew-metric"><strong>${counts.codexSkills||0}</strong><span>Codex 技能</span></div>
      <div class="crew-metric"><strong>${counts.hermesSkills||0}</strong><span>Hermes 技能</span></div>
      <div class="crew-metric"><strong>${counts.harnessSkills||0}</strong><span>Harness 技能</span></div>
    </div>
    <section class="v3-card"><div class="v3-card-head"><div><h2>底座状态 · DeepSeek Harness</h2><p>dsh web 服务与运行时；技能来自 Codex / Hermes / dsh 三个来源，全部本机只读盘点。</p></div></div>${harnessStatusHtml(state.harness)}<div class="crew-source-note">共 ${totalSkill} 个技能（Codex ${counts.codexSkills||0} · Hermes ${counts.hermesSkills||0} · Harness ${counts.harnessSkills||0}）· 扫描于 ${state.scannedAt?fmtTime(state.scannedAt):'—'}</div></section>
    <section class="v3-card"><div class="v3-card-head"><div><h2>数字员工</h2><p>来自 ~/.codex/agents 的岗位模板；「派单命令」可直接复制到 Codex 使用。</p></div></div>
      ${favAgents.length?`<div class="crew-dept-title">★ 常用</div><div class="crew-grid">${favAgents.map(agentCard).join('')}</div>`:''}
      ${groups.map(([dept,list])=>`<div class="crew-dept-title">${esc(dept)}</div><div class="crew-grid">${list.map(agentCard).join('')}</div>`).join('')||'<div class="v3-empty">没有可用员工。</div>'}
    </section>
  </div>`;
}

// ---------- 技能入口 ----------
function sourceLabel(src){
  if(src==='codex')return'Codex';
  if(src==='hermes')return'Hermes';
  if(src==='harness')return'Harness';
  return src||'—';
}
function skillsListHtml(state){
  const skills=state.skills||[];
  const favs=favoriteKeys();
  const sourceFilter=window.__crewSourceFilter||'all';
  const q=(window.__crewSkillQuery||'').toLowerCase().trim();
  const list=skills.filter(s=>{
    if(sourceFilter!=='all'&&s.source!==sourceFilter)return false;
    if(!q)return true;
    return `${s.name} ${s.description} ${s.parent} ${s.dir}`.toLowerCase().includes(q);
  }).sort((a,b)=>{
    const fa=favs.has(`skill:${a.id}`)?0:1,fb=favs.has(`skill:${b.id}`)?0:1;
    if(fa!==fb)return fa-fb;
    return String(a.name).localeCompare(String(b.name),'zh');
  });
  return list.length?`<div class="crew-skill-grid">${list.map(skillCard).join('')}</div>`:'<div class="v3-empty">没有匹配的技能。</div>';
}
function skillsPageHtml(state){
  const skills=state.skills||[];
  const sourceFilter=window.__crewSourceFilter||'all';
  const chip=(key,label,count)=>`<button class="crew-chip ${sourceFilter===key?'on':''}" data-crew-action="filter" data-filter="${key}">${label}<span>${count||''}</span></button>`;
  return `<div id="skills-center" class="crew-page">
    <div class="crew-toolbar"><input id="crew-skill-search" class="crew-search" type="search" placeholder="搜索技能名称、描述或路径…" value="${esc(window.__crewSkillQuery||'')}" autocomplete="off">
      <div class="crew-chips">${chip('all','全部',skills.length)}${chip('codex','Codex',skills.filter(s=>s.source==='codex').length)}${chip('hermes','Hermes',skills.filter(s=>s.source==='hermes').length)}${chip('harness','Harness',skills.filter(s=>s.source==='harness').length)}</div>
    </div>
    <section class="v3-card"><div class="v3-card-head"><div><h2>技能入口</h2><p>★ 为常用技能，自动置顶；点星切换。所有技能来自本机目录，路径可复制。</p></div></div>
      <div id="crew-skill-list">${skillsListHtml(state)}</div>
    </section>
  </div>`;
}
function skillCard(s){
  const fav=favoriteKeys();
  const id=`skill:${s.id}`;
  const star=fav.has(id)?'★':'☆';
  const parent=s.parent?`${esc(s.parent)}/`:'';
  return `<div class="crew-skill">
    <div class="crew-skill-top"><div class="crew-skill-name">${esc(s.name)}<span class="crew-skill-src ${s.source}">${sourceLabel(s.source)}</span></div><button class="crew-star" data-crew-action="fav" data-key="${attr(id)}" title="常用置顶">${star}</button></div>
    <div class="crew-skill-desc">${esc(s.description||'（无描述）')}</div>
    <div class="crew-skill-path">${parent}${esc(s.dir)}</div>
    <div class="crew-actions"><button class="btn small" data-crew-action="copy-path" data-path="${attr(s.path)}">复制 SKILL.md 路径</button></div>
  </div>`;
}

// ---------- 渲染与路由 ----------
// setTop and hideLegacyMain provided by window.WB
function enhanceSidebar(){
  const nav=document.querySelector('.nav');if(!nav)return;
  let crew=nav.querySelector('a[href="#crew"]');
  let skills=nav.querySelector('a[href="#skills"]');
  if(!crew||!skills){
    const crewEl=document.createElement('a');crewEl.href='#crew';crewEl.textContent='◈ AI 员工';
    const skillsEl=document.createElement('a');skillsEl.href='#skills';skillsEl.textContent='▤ 技能入口';
    const businessTitle=nav.querySelector('.nav-title');
    if(businessTitle){businessTitle.insertAdjacentElement('beforebegin',skillsEl);skillsEl.insertAdjacentElement('beforebegin',crewEl);}
    else{nav.appendChild(crewEl);nav.appendChild(skillsEl);}
    crew=crewEl;skills=skillsEl;
  }
  const view=currentView();
  crew.classList.toggle('active',view==='crew');
  skills.classList.toggle('active',view==='skills');
}
function renderCrew(){
  const main=document.querySelector('.main');if(!main)return;
  setTop('AI 员工调度','本机数字员工岗位模板与派单命令；底座状态实时探测。');
  hideLegacyMain(main,true);
  const state=crewState||{agents:[],skills:[],counts:{},harness:{}};
  const favLen=[...favoriteKeys()].length;
  let node=main.querySelector('#crew-center');
  if(node&&node.dataset.stamp===String(crewState?.loadedAt||0)&&node.dataset.favs===String(favLen))return;
  node?.remove();
  const holder=document.createElement('div');holder.innerHTML=crewPageHtml(state);
  node=holder.firstElementChild;
  node.dataset.stamp=String(crewState?.loadedAt||0);
  node.dataset.favs=String(favLen);
  const capture=main.querySelector('.capture');if(capture)capture.insertAdjacentElement('afterend',node);else main.prepend(node);
}
function updateSkillsList(){
  const list=document.querySelector('#crew-skill-list');
  if(!list||!crewState)return;
  list.innerHTML=skillsListHtml(crewState);
}
function renderSkills(){
  const main=document.querySelector('.main');if(!main)return;
  setTop('技能入口','Codex · Hermes · Harness 三个来源的技能库，搜索与常用置顶。');
  hideLegacyMain(main,true);
  const state=crewState||{agents:[],skills:[],counts:{},harness:{}};
  const favLen=[...favoriteKeys()].length;
  let node=main.querySelector('#skills-center');
  if(node&&node.dataset.stamp===String(crewState?.loadedAt||0)&&node.dataset.favs===String(favLen)){
    updateSkillsList();
    return;
  }
  node?.remove();
  const holder=document.createElement('div');holder.innerHTML=skillsPageHtml(state);
  node=holder.firstElementChild;
  node.dataset.stamp=String(crewState?.loadedAt||0);
  node.dataset.favs=String(favLen);
  const capture=main.querySelector('.capture');if(capture)capture.insertAdjacentElement('afterend',node);else main.prepend(node);
  const search=document.querySelector('#crew-skill-search');
  if(search&&!search.dataset.bound){search.dataset.bound='1';search.addEventListener('input',e=>{window.__crewSkillQuery=e.target.value;updateSkillsList();});}
}
async function renderEnhancements(){
  if(rendered)return;rendered=true;
  try{
    enhanceSidebar();
    const view=currentView();
    if(view==='crew'){const state=await loadCrew();if(crewState)renderCrew();}
    else if(view==='skills'){const state=await loadCrew();if(crewState)renderSkills();}
  }finally{rendered=false;}
}
function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;void renderEnhancements();});}

// ---------- 交互 ----------
async function handleCrewAction(target){
  const action=target.dataset.crewAction;
  if(action==='fav'){
    const set=toggleFavorite(target.dataset.key);
    target.textContent=set.has(target.dataset.key)?'★':'☆';
    const view=currentView();
    if(view==='crew')renderCrew();
    else if(view==='skills'){
      updateSkillsList();
      const main=document.querySelector('.main');
      if(main){const node=main.querySelector('#skills-center');if(node)node.dataset.favs=String([...set].length);}
    }
    return;
  }
  if(action==='copy-path'){
    const ok=await copyText(target.dataset.path||'');
    notify(ok?'路径已复制到剪贴板':'复制失败，请手动选择路径',!ok);
    return;
  }
  if(action==='copy-dispatch'){
    const name=target.dataset.name,id=target.dataset.id;
    if(!SAFE_AGENT_ID.test(String(id||''))){
      notify('员工 ID 不安全，已拒绝生成派单命令',true);
      return;
    }
    const cmd=`codex exec --agent ${shellQuote(id)} "在这里输入任务"`;
    const ok=await copyText(cmd);
    notify(ok?`已复制派单命令（员工 ${name}）`:'复制失败',!ok);
    return;
  }
  if(action==='filter'){
    window.__crewSourceFilter=target.dataset.filter||'all';
    document.querySelectorAll('.crew-chip').forEach(chip=>chip.classList.toggle('on',chip.dataset.filter===window.__crewSourceFilter));
    updateSkillsList();
  }
}
document.addEventListener('click',event=>{
  const target=event.target.closest?.('[data-crew-action]');
  if(target){event.preventDefault();void handleCrewAction(target);}
},true);

// Expose render functions for app.js direct calls
window.WB.renderCrew=renderCrew;
window.WB.renderSkills=renderSkills;
window.WB.crewLoad=()=>loadCrew(true);

window.addEventListener('hashchange',()=>{schedule();void renderEnhancements();});
window.addEventListener('workbench:enhance',schedule);
schedule();
