const PIPELINE_KEY='externalTaskPipeline';
let getnoteState=null;
let getnoteBusy=false;
let scheduled=false;

function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function pipeline(){return getnoteState?.config?.settings?.[PIPELINE_KEY]||{enabled:false,provider:'getnote_cli',noteLimit:100,journalDocumentUrl:'',journalHeading:'每日工作日记',calendarEnabled:true,calendarName:'个人 AI 工作台'};}

async function json(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||data.question||`请求失败 ${response.status}`);
  return data;
}

async function rpc(name,args={},confirmed=true){
  const data=await json('/api/mcp',{
    method:'POST',
    body:JSON.stringify({jsonrpc:'2.0',id:`getnote-${Date.now()}`,method:'tools/call',params:{name,arguments:args,confirmed}})
  });
  if(data.error)throw new Error(data.error.message||'MCP 工具执行失败');
  return data.result?.structuredContent?.result??data.result;
}

async function refreshState(){
  try{getnoteState=await json('/api/state');schedule();}catch{}
}

function receipt(title,detail='',error=false){
  const main=document.querySelector('.main');
  if(!main)return;
  main.querySelector('.getnote-integration-receipt')?.remove();
  const section=document.createElement('section');
  section.className=`getnote-integration-receipt${error?' error':''}`;
  const text=document.createElement('div');
  const strong=document.createElement('strong');strong.textContent=title;text.append(strong);
  if(detail){const span=document.createElement('span');span.textContent=detail;text.append(span);}
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.addEventListener('click',()=>section.remove());
  section.append(text,close);
  const capture=main.querySelector('.capture');
  if(capture)capture.insertAdjacentElement('afterend',section);else main.prepend(section);
}

function integrationSettingsHtml(value){
  const enabled=value.enabled===true;
  const noteLimit=Number.isInteger(Number(value.noteLimit))?Number(value.noteLimit):100;
  return `<section class="getnote-settings" id="getnote-settings">
    <div class="section-title">得到大脑待办来源与沉淀</div>
    <label class="getnote-check"><input id="getnote-enabled" type="checkbox" ${enabled?'checked':''}> 启用得到大脑 CLI 单向同步</label>
    <div class="getnote-settings-grid">
      <label><span>每次扫描最近笔记数</span><input id="getnote-note-limit" type="number" min="20" max="500" step="20" value="${noteLimit}"></label>
      <label><span>本机日历名称</span><input id="getnote-calendar-name" value="${esc(value.calendarName||'个人 AI 工作台')}"></label>
    </div>
    <label><span>飞书每日工作日记 URL</span><input id="getnote-journal-url" type="url" placeholder="https://你的租户.feishu.cn/wiki/..." value="${esc(value.journalDocumentUrl||'')}"></label>
    <label class="getnote-check"><input id="getnote-calendar-enabled" type="checkbox" ${value.calendarEnabled!==false?'checked':''}> 同步生成本机 ICS 日历</label>
    <p>程序固定执行 <code>getnote notes ... -o json</code> 和 <code>getnote note todos &lt;note_id&gt; -o json</code>。得到大脑只作为笔记和会议待办来源；飞书只保存待办快照与每日总结。只有待办文字中能确定日期的事项才进入本机日历，其余进入收件箱等待人工定日期。</p>
    ${value.lastSyncAt?`<div class="getnote-status"><strong>最近同步</strong><span>${esc(new Date(value.lastSyncAt).toLocaleString('zh-CN'))} · ${value.lastSyncStatus==='ok'?'成功':value.lastSyncStatus==='needs_reconfiguration'?'需要重新配置':'失败'} · 扫描 ${Number(value.lastSourceNoteCount||0)} 篇笔记 · 解析 ${Number(value.lastParsedTodoCount||0)} 条待办${value.lastSyncError?` · ${esc(value.lastSyncError)}`:''}</span>${value.lastCalendarPath?`<code>${esc(value.lastCalendarPath)}</code>`:''}</div>`:''}
  </section>`;
}

function enhanceSettings(){
  const legacyInput=document.querySelector('#feishu-journal-url');
  const modal=legacyInput?.closest('.modal');
  if(!modal)return;
  const existing=modal.querySelector('#getnote-settings');
  if(existing)return;
  const label=legacyInput.previousElementSibling;
  label?.setAttribute('hidden','');
  legacyInput.setAttribute('hidden','');
  const legacyHelp=legacyInput.nextElementSibling;
  if(legacyHelp?.tagName==='P')legacyHelp.setAttribute('hidden','');
  const holder=document.createElement('div');
  holder.innerHTML=integrationSettingsHtml(pipeline());
  legacyInput.insertAdjacentElement('beforebegin',holder.firstElementChild);
  const intro=modal.querySelector('h3 + p');
  if(intro)intro.textContent='本地项目文件夹保存工作产物；得到大脑 CLI 提供笔记中的会议待办；飞书云文档保存工作日记；本机 ICS 文件提供日历镜像。';
}

function enhanceSyncButtons(){
  const value=pipeline();
  for(const button of document.querySelectorAll('[data-action="sync-feishu"]')){
    button.textContent=value.enabled?'同步得到大脑待办':'配置得到大脑';
    button.title=value.enabled?'从 getnote CLI 读取最近笔记的会议待办，写入飞书日记并更新本机日历':'先配置得到大脑 CLI、飞书日记与本机日历';
  }
  const actions=document.querySelector('.topbar .actions');
  if(actions&&!actions.querySelector('[data-getnote-action="publish-summary"]')){
    const button=document.createElement('button');
    button.type='button';button.className='btn desktop-only';button.dataset.getnoteAction='publish-summary';button.textContent='沉淀今日总结';
    actions.prepend(button);
  }
}

function enhanceInboxCopy(){
  const value=pipeline();
  for(const element of document.querySelectorAll('.card-desc')){
    if(element.textContent.includes('飞书云文档是来源')||element.textContent.includes('滴答清单 CLI 是待办来源')){
      element.textContent='得到大脑 CLI 是笔记待办来源；飞书云文档只保存待办快照和每日总结。没有明确日期的事项会进入这里等待你处理。';
    }
  }
  for(const title of document.querySelectorAll('.alert .a-title')){
    if(title.textContent.includes('当前还没有配置飞书日记来源')||title.textContent.includes('滴答 CLI')){
      title.textContent=value.enabled?'得到大脑 CLI 待办来源已启用':'尚未配置得到大脑 CLI 待办来源';
      const text=title.nextElementSibling;
      if(text)text.textContent=value.enabled?'点击顶部“同步得到大脑待办”开始读取最近笔记':'打开设置，配置得到大脑 CLI、飞书每日工作日记和本机日历。';
    }else if(title.textContent.startsWith('数据来源：飞书云文档')||title.textContent.includes('滴答清单 CLI')){
      title.textContent='待办来源：得到大脑 CLI；沉淀目标：飞书工作日记';
      const text=title.nextElementSibling;
      if(text)text.innerHTML=`${value.journalDocumentUrl?`<a href="${esc(value.journalDocumentUrl)}" target="_blank" rel="noreferrer">打开飞书每日工作日记</a>`:'尚未配置飞书日记'}${value.lastSyncAt?` · 最近同步 ${esc(new Date(value.lastSyncAt).toLocaleString('zh-CN'))}`:''}`;
    }
  }
}

function enhanceTaskSourceCard(){
  const heading=[...document.querySelectorAll('.card-title')].find(node=>node.textContent.trim()==='全部待办');
  const card=heading?.closest('.card');
  if(!card||card.querySelector('.getnote-source-card'))return;
  const value=pipeline();
  const status=document.createElement('div');status.className='getnote-source-card';
  status.innerHTML=`<strong>${value.enabled?'得到大脑 CLI 单向来源':'得到大脑 CLI 尚未启用'}</strong><span>${value.enabled?`最近 ${Number(value.noteLimit||100)} 篇笔记 · 飞书日记 + ${value.calendarEnabled!==false?'本机 ICS 日历':'不生成日历'}`:'在设置中启用后，会议待办会按来源笔记和文本稳定去重。'}</span>`;
  const head=card.querySelector('.card-head');head?.insertAdjacentElement('afterend',status);
}

function enhance(){enhanceSettings();enhanceSyncButtons();enhanceInboxCopy();enhanceTaskSourceCard();}
function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;enhance();});}

async function saveIntegration(event,target){
  const settings=document.querySelector('#getnote-settings');
  if(!settings)return false;
  event.preventDefault();event.stopImmediatePropagation();
  if(getnoteBusy)return true;
  getnoteBusy=true;target.disabled=true;
  try{
    const workspaceRoot=document.querySelector('#workspace-root')?.value.trim();
    const noteLimit=Number(document.querySelector('#getnote-note-limit')?.value||100);
    if(!Number.isInteger(noteLimit)||noteLimit<20||noteLimit>500)throw new Error('最近笔记扫描数量必须是 20-500 的整数。');
    const patch={
      enabled:document.querySelector('#getnote-enabled')?.checked===true,
      noteLimit,
      journalDocumentUrl:document.querySelector('#getnote-journal-url')?.value.trim()||'',
      journalHeading:'每日工作日记',
      calendarEnabled:document.querySelector('#getnote-calendar-enabled')?.checked!==false,
      calendarName:document.querySelector('#getnote-calendar-name')?.value.trim()||'个人 AI 工作台'
    };
    if(patch.enabled&&!patch.journalDocumentUrl)throw new Error('启用同步时必须填写飞书每日工作日记 URL。');
    if(workspaceRoot)await json('/api/config',{method:'PATCH',body:JSON.stringify({workspaceRoot})});
    await rpc('external_task_integration_update',patch,true);
    receipt('集成设置已保存',`固定使用 getnote CLI；每次扫描最近 ${noteLimit} 篇笔记。飞书不再作为个人收件箱来源。`);
    setTimeout(()=>location.reload(),500);
  }catch(error){receipt('设置保存失败',error.message,true);target.disabled=false;getnoteBusy=false;}
  return true;
}

async function syncTasks(event,target){
  const value=pipeline();
  if(!value.enabled)return false;
  event.preventDefault();event.stopImmediatePropagation();
  if(getnoteBusy)return true;
  getnoteBusy=true;target.disabled=true;target.textContent='同步中…';
  try{
    const result=await rpc('external_tasks_sync',{},true);
    receipt('得到大脑待办已同步',`扫描 ${result.noteCount||0} 篇笔记，解析 ${result.todoCount||0} 条；当前未完成 ${result.activeCount||0} 项，新增 ${result.changes?.created||0}，更新 ${result.changes?.updated||0}，完成 ${result.changes?.completed||0}。${result.calendar?.enabled?` 本机日历：${result.calendar.path}`:''}`);
    setTimeout(()=>location.reload(),900);
  }catch(error){receipt('得到大脑待办同步失败',error.message,true);target.disabled=false;target.textContent='同步得到大脑待办';getnoteBusy=false;}
  return true;
}

async function publishSummary(event,target){
  event.preventDefault();event.stopImmediatePropagation();
  if(getnoteBusy)return;
  const value=pipeline();
  if(!value.enabled){receipt('尚未配置得到大脑待办来源','请先在设置中绑定得到大脑 CLI 与飞书每日工作日记。',true);return;}
  getnoteBusy=true;target.disabled=true;target.textContent='沉淀中…';
  try{
    const result=await rpc('daily_summary_publish',{},true);
    receipt('今日总结已沉淀',`${result.date} · 飞书记录已写入并读回确认${result.replayed?'（幂等重放）':''}。`);
    setTimeout(()=>location.reload(),800);
  }catch(error){receipt('今日总结沉淀失败',error.message,true);target.disabled=false;target.textContent='沉淀今日总结';getnoteBusy=false;}
}

document.addEventListener('click',event=>{
  const target=event.target.closest?.('[data-action="save-settings"]');
  if(target&&document.querySelector('#getnote-settings')){saveIntegration(event,target);return;}
  const sync=event.target.closest?.('[data-action="sync-feishu"]');
  if(sync&&pipeline().enabled){syncTasks(event,sync);return;}
  const summary=event.target.closest?.('[data-getnote-action="publish-summary"]');
  if(summary){publishSummary(event,summary);}
},true);

new MutationObserver(schedule).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
refreshState();
schedule();
