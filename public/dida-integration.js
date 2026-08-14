const PIPELINE_KEY='externalTaskPipeline';
let didaState=null;
let didaBusy=false;
let scheduled=false;

function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function pipeline(){return didaState?.config?.settings?.[PIPELINE_KEY]||{enabled:false,cliFlavor:'ticktick',journalDocumentUrl:'',journalHeading:'每日工作日记',calendarEnabled:true,calendarName:'个人 AI 工作台'};}
function regionLabel(value){return value==='dida365'?'国内版（dida365.com）':'国际版（ticktick.com）';}

async function json(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||data.question||`请求失败 ${response.status}`);
  return data;
}

async function rpc(name,args={},confirmed=true){
  const data=await json('/api/mcp',{
    method:'POST',
    body:JSON.stringify({jsonrpc:'2.0',id:`dida-${Date.now()}`,method:'tools/call',params:{name,arguments:args,confirmed}})
  });
  if(data.error)throw new Error(data.error.message||'MCP 工具执行失败');
  return data.result?.structuredContent?.result??data.result;
}

async function refreshState(){
  try{didaState=await json('/api/state');schedule();}catch{}
}

function receipt(title,detail='',error=false){
  const main=document.querySelector('.main');
  if(!main)return;
  main.querySelector('.dida-integration-receipt')?.remove();
  const section=document.createElement('section');
  section.className=`dida-integration-receipt${error?' error':''}`;
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
  return `<section class="dida-settings" id="dida-settings">
    <div class="section-title">外部待办来源与沉淀</div>
    <label class="dida-check"><input id="dida-enabled" type="checkbox" ${enabled?'checked':''}> 启用滴答 CLI 单向同步</label>
    <div class="dida-settings-grid">
      <label><span>滴答账户区域</span><select id="dida-cli-flavor"><option value="ticktick" ${value.cliFlavor==='ticktick'?'selected':''}>国际版（ticktick.com）</option><option value="dida365" ${value.cliFlavor==='dida365'?'selected':''}>国内版（dida365.com）</option></select></label>
      <label><span>本机日历名称</span><input id="dida-calendar-name" value="${esc(value.calendarName||'个人 AI 工作台')}"></label>
    </div>
    <label><span>飞书每日工作日记 URL</span><input id="dida-journal-url" type="url" placeholder="https://你的租户.feishu.cn/wiki/..." value="${esc(value.journalDocumentUrl||'')}"></label>
    <label class="dida-check"><input id="dida-calendar-enabled" type="checkbox" ${value.calendarEnabled!==false?'checked':''}> 同步生成本机 ICS 日历</label>
    <p>程序始终执行固定的 <code>ticktick</code> CLI，并按账户区域设置 <code>TICKTICK_HOST</code>。任务事实只从 CLI 读取；飞书只保存待办快照和每日总结；日历只镜像源任务已有的日期与时间，不由 AI 排期。</p>
    ${value.lastSyncAt?`<div class="dida-status"><strong>最近同步</strong><span>${esc(new Date(value.lastSyncAt).toLocaleString('zh-CN'))} · ${value.lastSyncStatus==='ok'?'成功':'失败'} · ${esc(regionLabel(value.cliFlavor))}${value.lastSyncError?` · ${esc(value.lastSyncError)}`:''}</span>${value.lastCalendarPath?`<code>${esc(value.lastCalendarPath)}</code>`:''}</div>`:''}
  </section>`;
}

function enhanceSettings(){
  const legacyInput=document.querySelector('#feishu-journal-url');
  const modal=legacyInput?.closest('.modal');
  if(!modal)return;
  let settings=modal.querySelector('#dida-settings');
  if(!settings){
    const label=legacyInput.previousElementSibling;
    label?.setAttribute('hidden','');
    legacyInput.setAttribute('hidden','');
    const legacyHelp=legacyInput.nextElementSibling;
    if(legacyHelp?.tagName==='P')legacyHelp.setAttribute('hidden','');
    const holder=document.createElement('div');
    holder.innerHTML=integrationSettingsHtml(pipeline());
    legacyInput.insertAdjacentElement('beforebegin',holder.firstElementChild);
    const intro=modal.querySelector('h3 + p');
    if(intro)intro.textContent='本地项目文件夹保存工作产物；滴答 CLI 提供待办事实；飞书云文档保存工作日记；本机 ICS 文件提供日历镜像。';
  }
}

function enhanceSyncButtons(){
  const value=pipeline();
  for(const button of document.querySelectorAll('[data-action="sync-feishu"]')){
    button.textContent=value.enabled?'同步滴答待办':'配置滴答待办';
    button.title=value.enabled?'从 ticktick CLI 读取，写入飞书日记并更新本机日历':'先配置滴答账户区域、飞书日记与本机日历';
  }
  const actions=document.querySelector('.topbar .actions');
  if(actions&&!actions.querySelector('[data-dida-action="publish-summary"]')){
    const button=document.createElement('button');
    button.type='button';button.className='btn desktop-only';button.dataset.didaAction='publish-summary';button.textContent='沉淀今日总结';
    actions.prepend(button);
  }
}

function enhanceInboxCopy(){
  const value=pipeline();
  for(const element of document.querySelectorAll('.card-desc')){
    if(element.textContent.includes('飞书云文档是来源'))element.textContent='滴答清单 CLI 是待办来源；飞书云文档只保存待办快照和每日总结。无截止日期的任务会进入这里等待你处理。';
  }
  for(const title of document.querySelectorAll('.alert .a-title')){
    if(title.textContent.includes('当前还没有配置飞书日记来源')){
      title.textContent=value.enabled?'滴答 CLI 待办来源已启用':'尚未配置滴答 CLI 待办来源';
      const text=title.nextElementSibling;
      if(text)text.textContent=value.enabled?`点击顶部“同步滴答待办”开始单向读取 · ${regionLabel(value.cliFlavor)}`:'打开设置，配置滴答账户区域、飞书每日工作日记和本机日历。';
    }else if(title.textContent.startsWith('数据来源：飞书云文档')){
      title.textContent='待办来源：滴答清单 CLI；沉淀目标：飞书工作日记';
      const text=title.nextElementSibling;
      if(text)text.innerHTML=`${value.journalDocumentUrl?`<a href="${esc(value.journalDocumentUrl)}" target="_blank" rel="noreferrer">打开飞书每日工作日记</a>`:'尚未配置飞书日记'}${value.lastSyncAt?` · 最近同步 ${esc(new Date(value.lastSyncAt).toLocaleString('zh-CN'))}`:''}`;
    }
  }
}

function enhanceTaskSourceCard(){
  const heading=[...document.querySelectorAll('.card-title')].find(node=>node.textContent.trim()==='全部待办');
  const card=heading?.closest('.card');
  if(!card||card.querySelector('.dida-source-card'))return;
  const value=pipeline();
  const status=document.createElement('div');status.className='dida-source-card';
  status.innerHTML=`<strong>${value.enabled?'滴答 CLI 单向来源':'滴答 CLI 尚未启用'}</strong><span>${value.enabled?`${esc(regionLabel(value.cliFlavor))} · 飞书日记 + ${value.calendarEnabled!==false?'本机 ICS 日历':'不生成日历'}`:'在设置中启用后，正式待办将按外部任务 ID 去重。'}</span>`;
  const head=card.querySelector('.card-head');head?.insertAdjacentElement('afterend',status);
}

function enhance(){enhanceSettings();enhanceSyncButtons();enhanceInboxCopy();enhanceTaskSourceCard();}
function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;enhance();});}

async function saveIntegration(event,target){
  const settings=document.querySelector('#dida-settings');
  if(!settings)return false;
  event.preventDefault();event.stopImmediatePropagation();
  if(didaBusy)return true;
  didaBusy=true;target.disabled=true;
  try{
    const workspaceRoot=document.querySelector('#workspace-root')?.value.trim();
    const patch={
      enabled:document.querySelector('#dida-enabled')?.checked===true,
      cliFlavor:document.querySelector('#dida-cli-flavor')?.value||'ticktick',
      journalDocumentUrl:document.querySelector('#dida-journal-url')?.value.trim()||'',
      journalHeading:'每日工作日记',
      calendarEnabled:document.querySelector('#dida-calendar-enabled')?.checked!==false,
      calendarName:document.querySelector('#dida-calendar-name')?.value.trim()||'个人 AI 工作台'
    };
    if(patch.enabled&&!patch.journalDocumentUrl)throw new Error('启用同步时必须填写飞书每日工作日记 URL。');
    if(workspaceRoot)await json('/api/config',{method:'PATCH',body:JSON.stringify({workspaceRoot})});
    await rpc('external_task_integration_update',patch,true);
    receipt('集成设置已保存',`固定使用 ticktick CLI · ${regionLabel(patch.cliFlavor)}。飞书不再作为收件箱来源。`);
    setTimeout(()=>location.reload(),500);
  }catch(error){receipt('设置保存失败',error.message,true);target.disabled=false;didaBusy=false;}
  return true;
}

async function syncTasks(event,target){
  const value=pipeline();
  if(!value.enabled)return false;
  event.preventDefault();event.stopImmediatePropagation();
  if(didaBusy)return true;
  didaBusy=true;target.disabled=true;target.textContent='同步中…';
  try{
    const result=await rpc('external_tasks_sync',{},true);
    receipt('滴答待办已同步',`当前 ${result.activeCount||0} 项；新增 ${result.changes?.created||0}，更新 ${result.changes?.updated||0}，完成 ${result.changes?.completed||0}。${result.calendar?.enabled?` 本机日历：${result.calendar.path}`:''}`);
    setTimeout(()=>location.reload(),900);
  }catch(error){receipt('滴答待办同步失败',error.message,true);target.disabled=false;target.textContent='同步滴答待办';didaBusy=false;}
  return true;
}

async function publishSummary(event,target){
  event.preventDefault();event.stopImmediatePropagation();
  if(didaBusy)return;
  const value=pipeline();
  if(!value.enabled){receipt('尚未配置滴答待办来源','请先在设置中绑定滴答 CLI 与飞书每日工作日记。',true);return;}
  didaBusy=true;target.disabled=true;target.textContent='沉淀中…';
  try{
    const result=await rpc('daily_summary_publish',{},true);
    receipt('今日总结已沉淀',`${result.date} · 飞书记录已写入并读回确认${result.replayed?'（幂等重放）':''}。`);
    setTimeout(()=>location.reload(),800);
  }catch(error){receipt('今日总结沉淀失败',error.message,true);target.disabled=false;target.textContent='沉淀今日总结';didaBusy=false;}
}

document.addEventListener('click',event=>{
  const target=event.target.closest?.('[data-action="save-settings"]');
  if(target&&document.querySelector('#dida-settings')){saveIntegration(event,target);return;}
  const sync=event.target.closest?.('[data-action="sync-feishu"]');
  if(sync&&pipeline().enabled){syncTasks(event,sync);return;}
  const summary=event.target.closest?.('[data-dida-action="publish-summary"]');
  if(summary){publishSummary(event,summary);}
},true);

new MutationObserver(schedule).observe(document.querySelector('#app')||document.body,{childList:true,subtree:true});
refreshState();
schedule();
