/* harness-nav-input.js — @提及、语音输入、模型切换
 * 从 harness-navigator.js 拆分而来
 */
import {navigatorState,mentionState,jsonRequest,scheduleMount} from './harness-nav-session.js';
import {escapeHtml,compact} from './harness-nav-markdown.js';

/* ─── AI 员工列表 ─── */
export async function loadCrewAgents(){
  if(navigatorState.crewAgentsLoaded||navigatorState.crewAgentsLoading)return;
  navigatorState.crewAgentsLoading=true;
  try{
    const payload=await jsonRequest('/api/crew');
    navigatorState.crewAgents=Array.isArray(payload.agents)?payload.agents:[];
    navigatorState.crewAgentsLoaded=true;
  }catch{
    navigatorState.crewAgents=[];navigatorState.crewAgentsLoaded=true;
  }finally{
    navigatorState.crewAgentsLoading=false;
  }
}

/* ─── @ AI 员工提及 ─── */
export function detectMention(textarea){
  const text=textarea.value;const pos=textarea.selectionStart;
  const before=text.slice(0,pos);
  const match=before.match(/(?:^|\s)@([^\s@\n]*)$/);
  if(!match)return false;
  mentionState.startPos=match.index+(match[0][0]==='@'?0:1);
  mentionState.query=match[1];
  return true;
}
export function openMention(textarea){
  mentionState.open=true;
  if(!navigatorState.crewAgentsLoaded&&!navigatorState.crewAgentsLoading){
    void loadCrewAgents().then(()=>{if(mentionState.open){updateMentionFilter();renderMentionPopup(textarea);}});
  }
  updateMentionFilter();renderMentionPopup(textarea);
}
export function updateMentionFilter(){
  const q=mentionState.query.toLowerCase();
  mentionState.filtered=q?navigatorState.crewAgents.filter(a=>{
    const title=(a.title||a.name||'').toLowerCase();
    const dept=(a.dept||'').toLowerCase();
    return title.includes(q)||dept.includes(q);
  }):navigatorState.crewAgents.slice();
  mentionState.selectedIndex=0;
}
export function closeMention(){
  mentionState.open=false;mentionState.query='';mentionState.filtered=[];mentionState.selectedIndex=0;
  if(mentionState.popupEl){mentionState.popupEl.remove();mentionState.popupEl=null;}
}
export function renderMentionPopup(textarea){
  if(!mentionState.open)return;
  let popup=mentionState.popupEl;
  if(!popup){popup=document.createElement('div');popup.className='harness-mention-popup';popup.setAttribute('role','listbox');document.body.appendChild(popup);mentionState.popupEl=popup;}
  if(!navigatorState.crewAgentsLoaded){
    popup.innerHTML='<div class="harness-mention-hint">正在加载 AI 员工列表…</div>';
  }else if(!navigatorState.crewAgents.length){
    popup.innerHTML='<div class="harness-mention-hint">没有可用的 AI 员工</div>';
  }else if(!mentionState.filtered.length){
    popup.innerHTML='<div class="harness-mention-hint">没有匹配的 AI 员工</div>';
  }else{
    popup.innerHTML=mentionState.filtered.slice(0,8).map((a,i)=>{
      const title=escapeHtml(a.title||a.name||a.id||'');
      const dept=a.dept?escapeHtml(a.dept):'';
      const desc=a.description?escapeHtml(compact(a.description,60)):'';
      return `<div class="harness-mention-item${i===mentionState.selectedIndex?' selected':''}" data-mention-idx="${i}" role="option"><span class="mention-title">${title}</span>${dept?`<span class="mention-dept">${dept}</span>`:''}${desc?`<span class="mention-desc">${desc}</span>`:''}</div>`;
    }).join('');
  }
  positionMentionPopup(textarea);
}
export function positionMentionPopup(textarea){
  const popup=mentionState.popupEl;if(!popup)return;
  const rect=textarea.getBoundingClientRect();
  const popupHeight=popup.offsetHeight||200;
  const spaceAbove=rect.top;const spaceBelow=window.innerHeight-rect.bottom;
  if(spaceAbove>popupHeight+8&&spaceAbove>=spaceBelow){popup.style.top=`${rect.top-popupHeight-4}px`;}
  else{popup.style.top=`${rect.bottom+4}px`;}
  popup.style.left=`${rect.left}px`;
  popup.style.width=`${Math.min(rect.width,320)}px`;
}
export function selectMention(textarea){
  const agent=mentionState.filtered[mentionState.selectedIndex];if(!agent)return;
  const title=agent.title||agent.name||agent.id||'';
  const insertText=`@${title} `;
  const before=textarea.value.slice(0,mentionState.startPos);
  const after=textarea.value.slice(textarea.selectionStart);
  textarea.value=before+insertText+after;
  const newCursor=before.length+insertText.length;
  textarea.setSelectionRange(newCursor,newCursor);
  textarea.style.height='auto';textarea.style.height=`${Math.min(textarea.scrollHeight,180)}px`;
  closeMention();textarea.focus();
}
export function navigateMention(direction){
  const len=mentionState.filtered.length;if(!len)return;
  mentionState.selectedIndex=(mentionState.selectedIndex+direction+len)%len;
  const popup=mentionState.popupEl;
  if(popup)popup.querySelectorAll('.harness-mention-item').forEach((el,i)=>el.classList.toggle('selected',i===mentionState.selectedIndex));
}

/* ─── 语音输入 ─── */
export function toggleVoiceInput(){
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
export function stopVoiceInput(){
  if(navigatorState.speechRecognition){try{navigatorState.speechRecognition.stop();}catch(e){}}
  navigatorState.recording=false;navigatorState.speechRecognition=null;scheduleMount();
}

/* ─── 切换模型 ─── */
export async function switchModel(model){
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
