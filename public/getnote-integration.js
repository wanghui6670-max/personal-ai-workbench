const PIPELINE_KEY='externalTaskPipeline';
const DEFAULT_PIPELINE=Object.freeze({enabled:false,provider:'getnote_cli',noteLimit:100,timeZone:'Asia/Shanghai',journalDocumentUrl:'',journalHeading:'每日工作日记',calendarEnabled:true,calendarName:'个人 AI 工作台'});
let getnoteState=null;
let getnoteBusy=false;
let scheduled=false;

function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[char]));}
function pipeline(){
  const raw=getnoteState?.config?.settings?.[PIPELINE_KEY]||{};
  const mistaken=raw?.provider==='dida_cli'||Object.hasOwn(raw,'cliFlavor');
  if(mistaken){
    return{
      ...DEFAULT_PIPELINE,...raw,
      enabled:false,provider:'getnote_cli',
      noteLimit:Number.isInteger(Number(raw.noteLimit))?Number(raw.noteLimit):100,
      lastSyncStatus:'needs_reconfiguration',
      lastSyncError:'此前配置误用了滴答清单。请重新确认得到大脑 CLI、飞书工作日记和本机日历设置。'
    };
  }
  return{...DEFAULT_PIPELINE,...raw,provider:'getnote_cli'};
}

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
async function refreshState(){try{getnoteState=await json('/api/state');schedule();}catch{}}

function receipt(title,detail='',error=false){
  const main=document.querySelector('.main');if(!main)return;
  main.querySelector('.getnote-integration-receipt')?.remove();
  const section=document.createElement('section');section.className=`getnote-integration-receipt${error?' error':''}`;
  const text=document.createElement('div');const strong=document.createElement('strong');strong.textContent=title;text.append(strong);
  if(detail){const span=document.createElement('span');span.textContent=detail;text.append(span);}
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.addEventListener('click',()=>section.remove());
  section.append(text,close);const capture=main.querySelector('.capture');if(capture)capture.insertAdjacentElement('afterend',section);else main.prepend(section);
}
function statusLabel(value){
  if(value.lastSyncStatus==='ok')return'成功';
  if(value.lastSyncStatus==='ok_with_sink_errors')return'核心成功，派生输出异常';
  if(value.lastSyncStatus==='needs_reconfiguration')return'需要重新配置';
  return'失败';
}
function sinkLabel(name,status,error){
  if(status==='ok')return`${name}：成功`;
  if(status==='error')return`${name}：失败${error?`（${error}）`:''}`;
  if(status==='disabled')return`${name}：关闭`;
  if(status==='not_configured')return`${name}：未配置`;
  return`${name}：未同步`;
}

function integrationSettingsHtml(value){
  const enabled=value.enabled===true;
  const noteLimit=Number.isInteger(Number(value.noteLimit))?Number(value.noteLimit):100;
  const showStatus=Boolean(value.lastSyncAt)||value.lastSyncStatus==='needs_reconfiguration';
  const statusTime=value.lastSyncAt?new Date(value.lastSyncAt).toLocaleString('zh-CN'):'尚未完成正确来源同步';
  const sinkStatus=[sinkLabel('飞书',value.lastJournalStatus,value.lastJournalError),sinkLabel('ICS',value.lastCalendarStatus,value.lastCalendarError)].join(' · ');
  return `<section class="getnote-settings" id="getnote-settings">
    <div class="section-title">得到大脑待办来源与沉淀</div>
    <label class="getnote-check"><input id="getnote-enabled" type="checkbox" ${enabled?'checked':''}> 启用得到大脑单向同步</label>
    <div class="getnote-settings-grid">
      <label><span>每次扫描最近笔记数</span><input id="getnote-note-limit" type="number" min="20" max="500" step="20" value="${noteLimit}"></label>
      <label><span>任务时区</span><input id="getnote-time-zone" value="${esc(value.timeZone||'Asia/Shanghai')}" placeholder="Asia/Shanghai"></label>
      <label><span>ICS 日历名称</span><input id="getnote-calendar-name" value="${esc(value.calendarName||'个人 AI 工作台')}"></label>
    </div>
    <label><span>飞书每日工作日记 URL（可选）</span><input id="getnote-journal-url" type="url" placeholder="https://你的租户.feishu.cn/wiki/..." value="${esc(value.journalDocumentUrl||'')}"></label>
    <label class="getnote-check"><input id="getnote-calendar-enabled" type="checkbox" ${value.calendarEnabled!==false?'checked':''}> 同步生成 ICS 日历</label>
    <p>核心同步只读取得到大脑明确的 <code>meeting_todos</code>：先扫描最近笔记，并继续追踪工作台里仍未完成事项对应的旧笔记。Workbench 状态先原子提交；飞书日记和 ICS 都是可失败重试的派生输出。不会从正文自行发明任务，也不会自动加入 Today 或替你排优先级。</p>
    ${showStatus?`<div class="getnote-status"><strong>来源状态</strong><span>${esc(statusTime)} · ${esc(statusLabel(value))} · 最近 ${Number(value.lastRecentNoteCount||value.lastSourceNoteCount||0)} 篇 + 旧未完成 ${Number(value.lastTrackedNoteCount||0)} 篇 · 解析 ${Number(value.lastParsedTodoCount||0)} 条待办 · ${esc(sinkStatus)}${value.lastSyncError?` · ${esc(value.lastSyncError)}`:''}</span>${value.lastCalendarPath?`<code>${esc(value.lastCalendarPath)}</code>`:''}</div>`:''}
  </section>`;
}

function enhanceSettings(){
  const legacyInput=document.querySelector('#feishu-journal-url');const modal=legacyInput?.closest('.modal');if(!modal)return;
  const existing=modal.querySelector('#getnote-settings');if(existing)return;
  const label=legacyInput.previousElementSibling;label?.setAttribute('hidden','');legacyInput.setAttribute('hidden','');
  const legacyHelp=legacyInput.nextElementSibling;if(legacyHelp?.tagName==='P')legacyHelp.setAttribute('hidden','');
  const holder=document.createElement('div');holder.innerHTML=integrationSettingsHtml(pipeline());legacyInput.insertAdjacentElement('beforebegin',holder.firstElementChild);
  const intro=modal.querySelector('h3 + p');if(intro)intro.textContent='得到大脑提供明确会议待办；Workbench 是个人任务状态真源；飞书工作日记和 ICS 是可选派生沉淀。';
}
function enhanceSyncButtons(){
  const value=pipeline();const label=value.enabled?'同步得到大脑待办':'配置得到大脑';
  const title=value.enabled?'从得到大脑读取明确 meeting_todos，先提交 Workbench，再尝试飞书与 ICS 派生输出':'先配置得到大脑待办来源';
  for(const button of document.querySelectorAll('[data-action="sync-feishu"]')){if(button.textContent!==label)button.textContent=label;if(button.title!==title)button.title=title;}
}
function enhanceInboxCopy(){
  const value=pipeline();
  for(const element of document.querySelectorAll('.card-desc')){
    if(element.textContent.includes('飞书云文档是来源')||element.textContent.includes('滴答清单 CLI 是待办来源')){
      element.textContent='得到大脑的明确会议待办是外部来源；Workbench 保存你的任务状态。没有明确日期的事项进入这里等待你处理。';
    }
  }
  for(const title of document.querySelectorAll('.alert .a-title')){
    if(title.textContent.includes('当前还没有配置飞书日记来源')||title.textContent.includes('滴答 CLI')){
      title.textContent=value.enabled?'得到大脑待办来源已启用':'尚未配置得到大脑待办来源';
      const text=title.nextElementSibling;if(text)text.textContent=value.enabled?'到“全部待办”页点击“同步得到大脑待办”开始读取':'打开设置启用得到大脑同步；飞书日记可以稍后再配。';
    }else if(title.textContent.startsWith('数据来源：飞书云文档')||title.textContent.includes('滴答清单 CLI')){
      title.textContent='待办来源：得到大脑；任务真源：Workbench';
      const text=title.nextElementSibling;
      if(text)text.innerHTML=`${value.journalDocumentUrl?`<a href="${esc(value.journalDocumentUrl)}" target="_blank" rel="noreferrer">打开飞书每日工作日记</a>`:'飞书日记未配置（不影响核心同步）'}${value.lastSyncAt?` · 最近同步 ${esc(new Date(value.lastSyncAt).toLocaleString('zh-CN'))}`:''}`;
    }
  }
}
function enhanceTaskSourceCard(){
  const heading=[...document.querySelectorAll('.card-title')].find(node=>node.textContent.trim()==='全部待办');const card=heading?.closest('.card');
  if(!card||card.querySelector('.getnote-source-card'))return;
  const value=pipeline();const status=document.createElement('div');status.className='getnote-source-card';
  const title=value.lastSyncStatus==='needs_reconfiguration'?'得到大脑需要重新配置':value.enabled?'得到大脑单向来源':'得到大脑尚未启用';
  const detail=value.lastSyncStatus==='needs_reconfiguration'
    ?'检测到旧错误来源配置；保存新的得到大脑设置后才可同步。'
    :value.enabled?`最近 ${Number(value.noteLimit||100)} 篇 + 未完成旧笔记追踪 · Workbench 先提交 · 飞书 ${value.journalDocumentUrl?'已配置':'可选'} · ${value.calendarEnabled!==false?'ICS 已启用':'ICS 已关闭'}`:'在设置中启用后，明确会议待办会按稳定来源身份对账。';
  status.innerHTML=`<strong>${title}</strong><span>${detail}</span>`;const head=card.querySelector('.card-head');head?.insertAdjacentElement('afterend',status);
}
function enhance(){enhanceSettings();enhanceSyncButtons();enhanceInboxCopy();enhanceTaskSourceCard();}
function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;enhance();});}

async function saveIntegration(event,target){
  const settings=document.querySelector('#getnote-settings');if(!settings)return false;
  event.preventDefault();event.stopImmediatePropagation();if(getnoteBusy)return true;
  getnoteBusy=true;target.disabled=true;
  try{
    const workspaceRoot=document.querySelector('#workspace-root')?.value.trim();
    const noteLimit=Number(document.querySelector('#getnote-note-limit')?.value||100);
    if(!Number.isInteger(noteLimit)||noteLimit<20||noteLimit>500)throw new Error('最近笔记扫描数量必须是 20-500 的整数。');
    const timeZone=document.querySelector('#getnote-time-zone')?.value.trim()||'Asia/Shanghai';
    const patch={
      enabled:document.querySelector('#getnote-enabled')?.checked===true,
      noteLimit,timeZone,
      journalDocumentUrl:document.querySelector('#getnote-journal-url')?.value.trim()||'',
      journalHeading:'每日工作日记',
      calendarEnabled:document.querySelector('#getnote-calendar-enabled')?.checked!==false,
      calendarName:document.querySelector('#getnote-calendar-name')?.value.trim()||'个人 AI 工作台'
    };
    if(workspaceRoot)await json('/api/config',{method:'PATCH',body:JSON.stringify({workspaceRoot})});
    await rpc('external_task_integration_update',patch,true);
    receipt('集成设置已保存',`最近 ${noteLimit} 篇 + 未完成旧笔记追踪；时区 ${timeZone}。飞书为可选沉淀，不再阻塞核心任务同步。`);
    setTimeout(()=>location.reload(),500);
  }catch(error){receipt('设置保存失败',error.message,true);target.disabled=false;getnoteBusy=false;}
  return true;
}
function resultSinkText(result){
  const parts=[];
  if(result.journal?.status==='ok')parts.push('飞书已沉淀');
  else if(result.journal?.status==='error')parts.push(`飞书失败：${result.journal.error}`);
  else parts.push('飞书未配置');
  if(result.calendar?.status==='ok')parts.push(`ICS 已更新：${result.calendar.path}`);
  else if(result.calendar?.status==='error')parts.push(`ICS 失败：${result.calendar.error}`);
  else if(result.calendar?.status==='disabled')parts.push('ICS 已关闭');
  if(result.metadata?.status==='error')parts.push(`状态元数据失败：${result.metadata.error||'配置状态未更新'}`);
  return parts.join('；');
}
async function syncTasks(event,target){
  const value=pipeline();if(!value.enabled)return false;
  event.preventDefault();event.stopImmediatePropagation();if(getnoteBusy)return true;
  getnoteBusy=true;target.disabled=true;target.textContent='同步中…';
  try{
    const result=await rpc('external_tasks_sync',{},true);
    const metadataError=result.metadata?.status==='error';
    const detail=`最近 ${result.recentNoteCount||0} 篇 + 旧未完成 ${result.trackedNoteCount||0} 篇，解析 ${result.todoCount||0} 条；新增 ${result.changes?.created||0}，更新 ${result.changes?.updated||0}，完成 ${result.changes?.completed||0}，Today 保留 ${result.changes?.todayPreserved||0}。${resultSinkText(result)}`;
    receipt(metadataError?'核心已提交，状态元数据异常':'得到大脑核心同步已提交',detail,metadataError);
    setTimeout(()=>location.reload(),metadataError?5000:900);
  }catch(error){receipt('得到大脑待办核心同步失败',error.message,true);target.disabled=false;target.textContent='同步得到大脑待办';getnoteBusy=false;}
  return true;
}
async function publishSummary(event,target){
  event.preventDefault();event.stopImmediatePropagation();if(getnoteBusy)return;
  const value=pipeline();
  if(!value.enabled){receipt('尚未配置得到大脑待办来源','请先在设置中启用得到大脑同步。',true);return;}
  if(!value.journalDocumentUrl){receipt('尚未配置飞书工作日记','任务同步不受影响；要发布每日总结，需要先在设置中填写飞书每日工作日记 URL。',true);return;}
  getnoteBusy=true;target.disabled=true;target.textContent='沉淀中…';
  try{
    const result=await rpc('daily_summary_publish',{},true);
    receipt('今日总结已沉淀',`${result.date} · 飞书记录已写入并读回确认${result.replayed?'（幂等重放）':''}。`);setTimeout(()=>location.reload(),800);
  }catch(error){receipt('今日总结沉淀失败',error.message,true);target.disabled=false;target.textContent='沉淀今日总结';getnoteBusy=false;}
}

document.addEventListener('click',event=>{
  const target=event.target.closest?.('[data-action="save-settings"]');if(target&&document.querySelector('#getnote-settings')){saveIntegration(event,target);return;}
  const sync=event.target.closest?.('[data-action="sync-feishu"]');if(sync&&pipeline().enabled){syncTasks(event,sync);return;}
  const summary=event.target.closest?.('[data-getnote-action="publish-summary"]');if(summary){publishSummary(event,summary);}
},true);

new MutationObserver(schedule).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
refreshState();schedule();