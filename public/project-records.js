const PANEL_ID='project-records-panel';
const PAGE_SIZE=10;
let activeProjectId=null;
let activeProject=null;
let records=[];
let nextCursor=null;
let loading=false;
let scheduled=false;

function projectIdFromHash(){
  const match=(location.hash||'').match(/^#project\/([^/]+)$/);
  if(!match)return null;
  try{return decodeURIComponent(match[1]);}catch{return null;}
}

function validFeishuUrl(value){
  try{
    const url=new URL(String(value||''));
    const host=url.hostname.toLowerCase();
    const official=['feishu.cn','larksuite.com','larkoffice.com'].some(root=>host===root||host.endsWith(`.${root}`));
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&official&&/^\/(?:wiki|docx|docs)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  }catch{return false;}
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

async function callProjectRecords(projectId,{beforeBlockId=null}={}){
  const requestId=`project-records-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const argumentsPayload={projectId,limit:PAGE_SIZE};
  if(beforeBlockId)argumentsPayload.beforeBlockId=beforeBlockId;
  const response=await jsonRequest('/api/mcp',{
    method:'POST',
    body:JSON.stringify({
      jsonrpc:'2.0',
      id:requestId,
      method:'tools/call',
      params:{name:'project_records_read',arguments:argumentsPayload}
    })
  });
  if(response.error)throw new Error(response.error.message||'读取飞书项目记录失败。');
  const result=response.result?.structuredContent?.result;
  if(!result||!Array.isArray(result.records))throw new Error('飞书项目记录返回格式不完整。');
  return result;
}

function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}

function setStatus(message,{error=false}={}){
  const status=document.querySelector(`#${PANEL_ID} [data-project-record-status]`);
  if(!status)return;
  status.textContent=message;
  status.classList.toggle('error',error);
}

function renderRecords(){
  const panel=document.getElementById(PANEL_ID);
  if(!panel)return;
  const list=panel.querySelector('[data-project-record-list]');
  const older=panel.querySelector('[data-project-record-older]');
  list.replaceChildren();
  if(records.length===0){
    list.append(element('div','project-record-empty','尚未读取项目分析与总结。正文只会从飞书临时读入当前页面。'));
  }else{
    for(const record of records){
      const item=element('article','project-record-item');
      const head=element('div','project-record-item-head');
      head.append(
        element('span',`project-record-kind ${record.kind==='summary'?'summary':'analysis'}`,record.kind==='summary'?'阶段总结':'项目分析'),
        element('span','project-record-operation',record.operationId?`ID · ${record.operationId}`:'历史记录')
      );
      item.append(head,element('div','project-record-text',record.text||''));
      list.append(item);
    }
  }
  older.hidden=!nextCursor;
  older.disabled=loading;
}

async function loadRecords({older=false}={}){
  if(loading||!activeProjectId||!activeProject||!validFeishuUrl(activeProject.feishu))return;
  loading=true;
  const loadButton=document.querySelector(`#${PANEL_ID} [data-project-record-load]`);
  const olderButton=document.querySelector(`#${PANEL_ID} [data-project-record-older]`);
  if(loadButton)loadButton.disabled=true;
  if(olderButton)olderButton.disabled=true;
  setStatus(older?'正在读取更早记录…':'正在从飞书读取最近记录…');
  try{
    const result=await callProjectRecords(activeProjectId,{beforeBlockId:older?nextCursor:null});
    records=older?[...records,...result.records]:result.records;
    nextCursor=result.nextCursor||null;
    setStatus(`已从飞书读回 ${records.length} 条记录；未写入本地状态。`);
  }catch(error){
    setStatus(error.message||'读取失败。',{error:true});
  }finally{
    loading=false;
    if(loadButton)loadButton.disabled=false;
    renderRecords();
  }
}

function createPanel(project){
  const panel=element('section','project-record-panel');
  panel.id=PANEL_ID;
  const title=element('div','project-record-title','飞书项目记忆');
  const desc=element('div','project-record-desc','项目分析、阶段总结、复盘和恢复摘要只从飞书云文档读取；此处不建立本地正文副本。');
  const toolbar=element('div','project-record-toolbar');
  const load=element('button','btn small primary','读取最新分析与总结');
  load.type='button';
  load.dataset.projectRecordLoad='1';
  toolbar.append(load);
  if(validFeishuUrl(project.feishu)){
    const open=element('a','btn small','打开飞书云文档');
    open.href=project.feishu;
    open.target='_blank';
    open.rel='noopener noreferrer';
    toolbar.append(open);
  }
  const status=element('div','project-record-status',validFeishuUrl(project.feishu)?'尚未读取。':'项目尚未绑定有效的飞书项目文档。');
  status.dataset.projectRecordStatus='1';
  const list=element('div','project-record-list');
  list.dataset.projectRecordList='1';
  const older=element('button','btn small project-record-older','读取更早记录');
  older.type='button';
  older.dataset.projectRecordOlder='1';
  older.hidden=true;
  if(!validFeishuUrl(project.feishu))load.disabled=true;
  panel.append(title,desc,toolbar,status,list,older);
  return panel;
}

async function ensurePanel(){
  scheduled=false;
  const projectId=projectIdFromHash();
  if(!projectId){
    activeProjectId=null;
    activeProject=null;
    records=[];
    nextCursor=null;
    document.getElementById(PANEL_ID)?.remove();
    return;
  }
  if(projectId!==activeProjectId){
    activeProjectId=projectId;
    activeProject=null;
    records=[];
    nextCursor=null;
  }
  const existing=document.getElementById(PANEL_ID);
  if(existing){renderRecords();return;}
  const asides=[...document.querySelectorAll('.main .grid > aside.card.pad')];
  const target=asides[0];
  if(!target)return;
  try{
    if(!activeProject)activeProject=await resolveProject(projectId);
    if(!activeProject)return;
    target.append(createPanel(activeProject));
    renderRecords();
  }catch(error){
    const panel=createPanel({feishu:''});
    target.append(panel);
    setStatus(error.message||'无法读取项目状态。',{error:true});
  }
}

function scheduleEnsure(){
  if(scheduled)return;
  scheduled=true;
  queueMicrotask(ensurePanel);
}

document.addEventListener('click',event=>{
  const load=event.target.closest?.('[data-project-record-load]');
  if(load){event.preventDefault();loadRecords();return;}
  const older=event.target.closest?.('[data-project-record-older]');
  if(older){event.preventDefault();loadRecords({older:true});}
});

window.addEventListener('hashchange',scheduleEnsure);
new MutationObserver(scheduleEnsure).observe(document.getElementById('app'),{childList:true,subtree:true});
scheduleEnsure();
