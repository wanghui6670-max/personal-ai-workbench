const {esc,fmtTime,json}=window.WB;
let mediaStatus=null;
let mediaBusy=false;
let scheduled=false;

function notify(message,error=false){window.WB.toast(message,error,3200);}
async function rpc(name,args={},confirmed=false){
  const data=await json('/api/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:`media-${Date.now()}`,method:'tools/call',params:{name,arguments:args,confirmed}})});
  if(data.error)throw new Error(data.error.message||'MCP 工具执行失败');
  return data.result?.structuredContent?.result??data.result;
}
function currentView(){return(location.hash||'#today').slice(1).split('/')[0]||'today';}

function ensureNav(){
  const cleanup=document.querySelector('[data-action="toggle-cleanup"]');if(!cleanup||document.querySelector('.v3-nav-media'))return;
  const link=document.createElement('a');link.className=`v3-nav-media${currentView()==='media'?' active':''}`;link.href='#media';link.textContent='◉ 自媒体';cleanup.insertAdjacentElement('beforebegin',link);
}
function statusHtml(status){
  if(!status?.configured)return `<div class="v3-notice">“自媒体”业务会在第一次确认同步时自动建立，并创建固定的“得到大脑内容”本地目录。</div>`;
  return `<div class="v3-source"><span class="pill blue">本地内容库</span><span class="v3-media-path">${esc(status.directory||'')}</span><span>最近同步：${fmtTime(status.lastSyncAt)}</span><span>已索引 ${Number(status.noteCount||0)} 篇</span></div>`;
}
function noteList(status){
  const notes=Array.isArray(status?.notes)?status.notes:[];
  if(!notes.length)return'<div class="v3-empty">还没有同步到本地的得到大脑内容。</div>';
  return `<div class="v3-note-list">${notes.map(note=>`<div class="v3-note-row"><strong>${esc(note.title||'未命名笔记')}</strong><span>${esc(note.filename||'')} · 更新 ${note.updatedAt?fmtTime(note.updatedAt):'—'}</span></div>`).join('')}</div>`;
}
function mediaPageHtml(status){
  const errors=Array.isArray(status?.errors)?status.errors:[];
  return `<div id="v3-media-page" class="v3-media-page"><section class="v3-card"><div class="v3-card-head"><div><h2>得到大脑 → 自媒体本地内容库</h2><p>得到大脑仍然保留，但它不再进入个人待办主链路。这里只做只读内容采集，保存到本地 Markdown。</p></div><button class="btn primary" data-media-action="sync" ${mediaBusy?'disabled':''}>${mediaBusy?'同步中…':'确认同步最近 50 篇'}</button></div><div class="v3-notice">边界：不创建待办、不加入 Today、不写回得到大脑、不删除本地历史文件。只有点击同步按钮后才会读取并写入本地。</div>${statusHtml(status)}</section><section class="v3-card"><div class="v3-card-head"><div><h2>最近本地内容</h2><p>文件名保持稳定；内容变化时更新同一文件，并维护本地索引。</p></div></div>${noteList(status)}</section>${errors.length?`<section class="v3-card"><div class="v3-card-head"><div><h2>本次未能读取的内容</h2><p>原文不可用的笔记会失败关闭，不会用 AI 摘要冒充原文。</p></div></div>${errors.map(error=>`<div class="v3-notice">${esc(error.title||error.noteId)} · ${esc(error.message||error.code)}</div>`).join('')}</section>`:''}</div>`;
}

async function refreshStatus(){
  try{mediaStatus=await rpc('getnote_content_status',{},false);}catch(error){mediaStatus={configured:false,error:error.message};}
  renderMedia();
}
function renderMedia(){
  ensureNav();if(currentView()!=='media')return;
  const main=document.querySelector('.main');if(!main)return;
  const h=document.querySelector('.top-left h1');if(h)h.textContent='自媒体';
  const p=document.querySelector('.top-left p');if(p)p.textContent='得到大脑只做内容来源：同步到本地文件夹，再用于内容分析与创作。';
  for(const child of [...main.children]){if(child.id!=='v3-media-page')child.classList.add('v3-hidden');}
  main.querySelector('#v3-media-page')?.remove();
  const holder=document.createElement('div');holder.innerHTML=mediaPageHtml(mediaStatus);main.prepend(holder.firstElementChild);
}
async function syncContent(target){
  if(mediaBusy)return;mediaBusy=true;renderMedia();
  try{
    const result=await rpc('getnote_content_sync',{limit:50},true);
    notify(`得到大脑内容已同步：新增 ${result.created||0}，更新 ${result.updated||0}，未变化 ${result.skipped||0}，失败 ${result.failed||0}`,(result.failed||0)>0);
    mediaBusy=false;await refreshStatus();
  }catch(error){mediaBusy=false;notify(error.message,true);renderMedia();}
}

document.addEventListener('click',event=>{const target=event.target.closest?.('[data-media-action]');if(!target)return;event.preventDefault();event.stopImmediatePropagation();if(target.dataset.mediaAction==='sync')void syncContent(target);},true);
window.addEventListener('hashchange',()=>{schedule();if(currentView()==='media')void refreshStatus();});
new MutationObserver(schedule).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;ensureNav();renderMedia();});}
void refreshStatus();schedule();
