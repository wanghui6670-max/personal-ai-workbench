/* harness-nav-session.js — 共享状态、会话 CRUD、网络工具
 * 从 harness-navigator.js 拆分而来
 */
import {compact} from './harness-nav-markdown.js';

export const nativeFetch=window.fetch.bind(window);

export const navigatorState={
  status:null,statusLoading:false,busy:false,abortController:null,
  error:'',sessionId:null,messages:[],trajectory:[],thinkBlocks:[],skillCalls:[],
  metrics:null,activeTab:'chat',
  sessions:[],currentSessionId:null,
  recording:false,speechRecognition:null,
  crewAgents:[],crewAgentsLoaded:false,crewAgentsLoading:false
};

export const DEFAULT_PANEL_WIDTH=500;

export const mentionState={open:false,query:'',selectedIndex:0,filtered:[],startPos:0,popupEl:null};
export let scheduled=false;
export let lastMountedHtml='';
export function setScheduled(v){scheduled=v;}
export function setLastMountedHtml(v){lastMountedHtml=v;}

/* ─── 路由与网络 ─── */
export function currentRoute(){const raw=(location.hash||'#today').slice(1);const [view,encodedId]=raw.split('/');let id=null;try{id=encodedId?decodeURIComponent(encodedId):null;}catch{}return{view:view||'today',id};}
export async function jsonRequest(url,options={},signal){const response=await nativeFetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})},signal:signal});const payload=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(payload.error||`请求失败 ${response.status}`);error.code=payload.code;throw error;}return payload;}

/* ─── 会话管理（内存模式，不做客户端持久化） ─── */
export function loadSessions(){
  return [];
}
export function saveSessions(){
  /* no-op: 会话状态仅保存在模块内存中，不写入客户端存储 */
}
export function createSession(title){
  const now=Date.now();
  const sid=`s_${now.toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const session={id:sid,title:title||'新对话',createdAt:now,messages:[]};
  navigatorState.sessions.push(session);
  navigatorState.currentSessionId=sid;
  navigatorState.sessionId=null;
  navigatorState.messages=[];
  navigatorState.trajectory=[];
  navigatorState.thinkBlocks=[];
  navigatorState.metrics=null;
  saveSessions();
  return session;
}
export function switchSession(sid){
  const session=navigatorState.sessions.find(s=>s.id===sid);
  if(!session)return;
  navigatorState.currentSessionId=sid;
  navigatorState.messages=session.messages||[];
  navigatorState.trajectory=[];
  navigatorState.thinkBlocks=[];
  navigatorState.metrics=null;
  navigatorState.sessionId=null;
  scheduleMount();
}
export function deleteSession(sid){
  navigatorState.sessions=navigatorState.sessions.filter(s=>s.id!==sid);
  if(navigatorState.currentSessionId===sid){
    navigatorState.currentSessionId=null;
    navigatorState.messages=[];
    navigatorState.trajectory=[];
    navigatorState.thinkBlocks=[];
    navigatorState.metrics=null;
    navigatorState.sessionId=null;
  }
  saveSessions();
  scheduleMount();
}
export function updateCurrentSession(){
  if(!navigatorState.currentSessionId)return;
  const session=navigatorState.sessions.find(s=>s.id===navigatorState.currentSessionId);
  if(!session)return;
  session.messages=navigatorState.messages.slice();
  if(session.title==='新对话'&&navigatorState.messages.length){
    const firstUser=navigatorState.messages.find(m=>m.role==='user');
    if(firstUser)session.title=compact(firstUser.text,28);
  }
  saveSessions();
}
export function branchSession(fromIdx){
  const now=Date.now();
  const sid=`s_${now.toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const branchMessages=navigatorState.messages.slice(0,fromIdx+1).map(m=>({...m}));
  const session={id:sid,title:'分支对话',createdAt:now,messages:branchMessages};
  navigatorState.sessions.push(session);
  navigatorState.currentSessionId=sid;
  navigatorState.messages=branchMessages;
  navigatorState.trajectory=[];
  navigatorState.thinkBlocks=[];
  navigatorState.metrics=null;
  navigatorState.sessionId=null;
  saveSessions();
  scheduleMount();
}

/* scheduleMount is defined in harness-nav-ui.js and will be hoisted via ES Module
 * function declaration ordering. This is a forward reference that works because
 * all module-level function declarations are initialized before any code runs.
 */
export let scheduleMount=()=>{};
export function setScheduleMount(fn){scheduleMount=fn;}
