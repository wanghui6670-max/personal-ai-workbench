const INDEX_ID='project-knowledge-index';
const CHIPS_ID='project-knowledge-chips';
const CHAPTERS=Object.freeze([
  {id:'assets',label:'资产盘点'},
  {id:'feishu',label:'飞书记录'},
  {id:'todos',label:'待办与卡点'},
  {id:'git',label:'本地 Git'},
  {id:'constraints',label:'约束'}
]);

let activeProjectId=null;
let scheduled=false;

function projectIdFromHash(){
  const match=(location.hash||'').match(new RegExp('^#project/([^/]+)$'));
  if(!match)return null;
  try{return decodeURIComponent(match[1]);}catch{return null;}
}

function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}

async function jsonRequest(url,options={}){
  const response=await fetch(url,{
    ...options,
    headers:{'Content-Type':'application/json',...(options.headers||{})}
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||`请求失败 ${response.status}`);
  return data;
}

async function resolveProject(projectId){
  const state=await jsonRequest('/api/state');
  return Array.isArray(state.projects)?state.projects.find(project=>project.id===projectId)||null:null;
}

function hideGlobalNav(nav,hide){
  if(!nav)return;
  for(const child of [...nav.children]){
    if(child.id===INDEX_ID)continue;
    child.classList.toggle('pk-nav-hidden',hide);
  }
}

const CHIP_SPECS=Object.freeze([
  {attr:'data-pk-chip="project"',fallback:'项目'},
  {attr:'data-pk-chip="live"',fallback:'live'},
  {attr:'data-pk-chip="git"',fallback:'Git'},
  {attr:'data-pk-chip="feishu"',fallback:'飞书'},
  {attr:'data-pk-chip="capability"',fallback:'read'}
]);

function createChip(spec,label){
  const chip=element('span','pk-chip',label||spec.fallback);
  const key=String(spec.attr).slice('data-pk-chip="'.length,-1);
  chip.setAttribute('data-pk-chip',key);
  return chip;
}

function createIndex(project){
  const wrap=element('div','pk-index');
  wrap.id=INDEX_ID;
  wrap.append(element('div','pk-index-kicker','项目知识'));
  wrap.append(element('div','pk-index-title',project?.name||'当前项目'));
  const chips=element('div','pk-chips');
  chips.id=CHIPS_ID;
  chips.append(
    createChip(CHIP_SPECS[0],project?.name||CHIP_SPECS[0].fallback),
    createChip(CHIP_SPECS[1],CHIP_SPECS[1].fallback),
    createChip(CHIP_SPECS[2],'Git'),
    createChip(CHIP_SPECS[3],'飞书'),
    createChip(CHIP_SPECS[4],CHIP_SPECS[4].fallback)
  );
  wrap.append(chips);
  const list=element('nav','pk-chapters');
  for(const chapter of CHAPTERS){
    const button=element('button','pk-chapter',chapter.label);
    button.type='button';
    button.dataset.pkChapter=chapter.id;
    list.append(button);
  }
  wrap.append(list);
  const back=element('a','pk-back','返回工作台');
  back.href="#today";
  wrap.append(back);
  return wrap;
}

function setChip(key,text){
  const chip=document.querySelector(`#${CHIPS_ID} [data-pk-chip="${key}"]`);
  if(chip)chip.textContent=text;
}

async function renderChips(project){
  if(!document.getElementById(CHIPS_ID))return;
  setChip('project',project?.name||'项目');
  setChip('live','live');
  setChip('git',project?.git?'Git 已绑定':'Git 未设');
  setChip('feishu',project?.feishu?'飞书已绑定':'飞书未绑');
  try{
    const status=await jsonRequest('/api/harness/status');
    const capabilityMode=status.capabilityMode||status.navigator?.capabilityMode||'read_and_preview';
    setChip('capability',String(capabilityMode));
  }catch{
    setChip('capability','offline');
  }
}

function markKnowledgeTargets(){
  const root=document.querySelector('.main');
  if(!root)return;
  for(const title of root.querySelectorAll('.section-title')){
    const text=title.textContent||'';
    if(/当前进度|当前卡点|项目待办/.test(text))title.dataset.pkTarget='todos';
    if(/资料入口/.test(text))title.dataset.pkTarget='assets';
    if(/项目记录/.test(text))title.dataset.pkTarget='constraints';
  }
  const records=document.getElementById('project-records-panel');
  if(records)records.dataset.pkTarget='feishu';
  for(const row of root.querySelectorAll('.paths .row')){
    const label=row.querySelector('.k')?.textContent||'';
    if(label.includes('本地项目文件夹'))row.dataset.pkTarget='assets';
    if(label.includes('Git'))row.dataset.pkTarget='git';
    if(label.includes('飞书'))row.dataset.pkTarget='feishu';
  }
  const hero=root.querySelector('.project-hero');
  if(hero)hero.dataset.pkTarget='constraints';
  const dates=root.querySelector('.kv');
  if(dates&&!dates.dataset.pkTarget)dates.dataset.pkTarget='constraints';
}

function scrollToChapter(chapter){
  markKnowledgeTargets();
  const target=document.querySelector(`[data-pk-target="${chapter}"]`);
  if(target&&typeof target.scrollIntoView==='function')target.scrollIntoView({block:'start',behavior:'smooth'});
}

function pruneDuplicateIndexes(){
  const nodes=[...document.querySelectorAll(`#${INDEX_ID}`)];
  for(const node of nodes.slice(1))node.remove();
}

async function hydrateIndex(projectId){
  let project=null;
  try{project=await resolveProject(projectId);}catch{project=null;}
  if(projectIdFromHash()!==projectId||!document.getElementById(INDEX_ID))return;
  const title=document.querySelector(`#${INDEX_ID} .pk-index-title`);
  if(title)title.textContent=project?.name||'当前项目';
  void renderChips(project);
}

async function ensureIndex(){
  scheduled=false;
  const projectId=projectIdFromHash();
  const nav=document.querySelector('.nav');
  const sidebar=nav?.closest('.sidebar');
  if(!projectId||!nav||!sidebar){
    document.getElementById(INDEX_ID)?.remove();
    hideGlobalNav(nav,false);
    activeProjectId=null;
    return;
  }
  hideGlobalNav(nav,true);
  pruneDuplicateIndexes();
  const existing=document.getElementById(INDEX_ID);
  if(!existing||projectId!==activeProjectId){
    existing?.remove();
    activeProjectId=projectId;
    sidebar.insertBefore(createIndex(null),nav);
    void hydrateIndex(projectId);
  }
  markKnowledgeTargets();
}

function scheduleEnsure(){
  if(scheduled)return;
  scheduled=true;
  queueMicrotask(ensureIndex);
}

document.addEventListener('click',event=>{
  const chapter=event.target.closest?.('[data-pk-chapter]');
  if(!chapter)return;
  event.preventDefault();
  scrollToChapter(chapter.dataset.pkChapter);
});

window.addEventListener('hashchange',scheduleEnsure);
const app=document.getElementById('app');
if(app)new MutationObserver(scheduleEnsure).observe(app,{childList:true,subtree:true});
scheduleEnsure();
