let selectedInboxId=null;
let scheduled=false;
let mainObserver=null;

function itemId(node){
  if(node?.dataset?.v3Id)return node.dataset.v3Id;
  const commandHost=node?.querySelector?.('[id^="cmd-"]');
  if(commandHost?.id)return commandHost.id.slice(4);
  return node?.querySelector?.('[data-id]')?.dataset?.id||null;
}
function setText(node,value){if(node&&node.textContent!==value)node.textContent=value;}
function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;renderWorkSurface();});}

function polishDashboard(){
  const dashboard=document.querySelector('#v3-dashboard');if(!dashboard)return;
  const queue=dashboard.querySelector(':scope > .v3-card');
  setText(queue?.querySelector('.v3-card-head h2'),'待处理工作流');
  setText(queue?.querySelector('.v3-card-head p'),'飞书明确待办 → AI 给处理建议 → 你确认 → Todo；普通日记不进入待办同步。');
  const labels=dashboard.querySelectorAll('.v3-hero .v3-metric span');
  ['今天要做','飞书待办','AI 建议中','需要留意'].forEach((label,index)=>setText(labels[index],label));
  const source=dashboard.querySelector('.v3-source');
  const sourcePill=source?.querySelector('.pill.blue');
  if(sourcePill)setText(sourcePill,'飞书待办来源');
  const unbound=source?.querySelector('.pill.amber');
  if(unbound&&/飞书未绑定/.test(unbound.textContent||'')){
    const spans=[...source.querySelectorAll(':scope > span')];
    const description=spans.find(span=>span!==unbound);
    setText(description,'绑定飞书云文档后，待办同步只读取原生未完成待办/复选框和明确收件箱里的 [INBOX] 待办；普通日记正文不会进入。');
  }
}

function focusInfo(item){
  return{
    id:itemId(item),
    text:item.querySelector('.v3-item-text')?.textContent?.trim()||'当前待办',
    label:item.querySelector('.v3-ai-label')?.textContent?.trim()||'等待 AI 建议',
    reason:item.querySelector('.v3-ai-reason')?.textContent?.trim()||'选中后可在这里查看这条明确待办的处理建议。',
    command:item.querySelector('.v3-ai-command')?.textContent?.trim()||'',
    canConfirm:Boolean(item.querySelector('[data-v3-action="confirm-plan"]')),
    canClarify:Boolean(item.querySelector('[data-action="open-command"]')),
    canAnalyze:Boolean(item.querySelector('[data-v3-action="analyze"]'))
  };
}
function focusPanelHtml(info){
  if(!info)return `<div class="v3-focus-eyebrow">当前事项助手</div><div class="v3-focus-empty">从中间“待处理工作流”选一条飞书待办。这里只处理已经明确是待办的内容，不会从普通日记里提取任务。</div>`;
  return `<div class="v3-focus-eyebrow">当前事项助手</div><div class="v3-focus-title"></div><div class="v3-focus-status"><span class="pill blue"></span></div><div class="v3-focus-reason"></div>${info.command?'<div class="v3-focus-command"></div>':''}<div class="v3-focus-actions">${info.canConfirm?'<button class="btn small primary" data-focus-forward="confirm">确认并处理</button>':''}${info.canClarify?'<button class="btn small" data-focus-forward="clarify">补充信息</button>':''}${info.canAnalyze?'<button class="btn small" data-focus-forward="analyze">重新分析</button>':''}</div>`;
}
function renderFocusPanel(){
  const panel=document.querySelector('.ai-panel');if(!panel)return;
  const items=[...document.querySelectorAll('.v3-inbox-item')];
  if(selectedInboxId&&!items.some(item=>itemId(item)===selectedInboxId))selectedInboxId=null;
  if(!selectedInboxId&&items.length)selectedInboxId=itemId(items[0]);
  for(const item of items)item.classList.toggle('v3-selected',itemId(item)===selectedInboxId);
  const selected=items.find(item=>itemId(item)===selectedInboxId)||null;
  const info=selected?focusInfo(selected):null;
  let host=panel.querySelector('#v3-focus-assistant');
  if(!host){host=document.createElement('section');host.id='v3-focus-assistant';const anchor=panel.querySelector('.ai-context');if(anchor)anchor.insertAdjacentElement('afterend',host);else panel.prepend(host);}
  host.innerHTML=focusPanelHtml(info);
  if(info){
    setText(host.querySelector('.v3-focus-title'),info.text);
    setText(host.querySelector('.v3-focus-status .pill'),info.label);
    setText(host.querySelector('.v3-focus-reason'),info.reason);
    setText(host.querySelector('.v3-focus-command'),info.command);
  }
  panel.classList.toggle('v3-has-focus',Boolean(info));
  const title=panel.querySelector('.ai-title'),subtitle=panel.querySelector('.ai-subtitle');
  if(info){setText(title,'当前事项助手');setText(subtitle,'只围绕选中的明确待办补充信息或确认处理');}
}
function attachMainObserver(){
  const main=document.querySelector('.main');
  if(!main||main===mainObserver?._target)return;
  mainObserver?.disconnect();
  mainObserver=new MutationObserver(schedule);mainObserver._target=main;
  mainObserver.observe(main,{childList:true,subtree:true});
}
function renderWorkSurface(){polishDashboard();renderFocusPanel();attachMainObserver();}

document.addEventListener('click',event=>{
  const forward=event.target.closest?.('[data-focus-forward]');
  if(forward){
    event.preventDefault();event.stopPropagation();
    const item=[...document.querySelectorAll('.v3-inbox-item')].find(node=>itemId(node)===selectedInboxId);if(!item)return;
    const selector={confirm:'[data-v3-action="confirm-plan"]',clarify:'[data-action="open-command"]',analyze:'[data-v3-action="analyze"]'}[forward.dataset.focusForward];
    item.querySelector(selector)?.click();return;
  }
  const item=event.target.closest?.('.v3-inbox-item');
  if(item){selectedInboxId=itemId(item);schedule();}
},true);

const app=document.querySelector('#app');
if(app)new MutationObserver(()=>{attachMainObserver();schedule();}).observe(app,{childList:true});
window.addEventListener('hashchange',schedule);
requestAnimationFrame(()=>{attachMainObserver();renderWorkSurface();});
