import crypto from 'node:crypto';
import { timingSafeEqualText } from './utils.mjs';

const COOKIE='workbench_session';
const MAX_AGE=60*60*24*30;
const LOGIN_LIMITER_DEFAULTS={
  freeFailures:4,
  baseDelayMs:1000,
  maxDelayMs:60_000,
  staleAfterMs:15*60_000,
  maxEntries:5000
};

export function createLoginAttemptLimiter(options={}){
  const settings={...LOGIN_LIMITER_DEFAULTS,...options};
  const now=typeof settings.now==='function'?settings.now:Date.now;
  const attempts=new Map();

  function prune(at){
    for(const [key,entry] of attempts){
      if(at-entry.lastSeen>=settings.staleAfterMs)attempts.delete(key);
    }
    while(attempts.size>=settings.maxEntries){
      const oldest=attempts.keys().next().value;
      if(oldest===undefined)break;
      attempts.delete(oldest);
    }
  }
  function check(key){
    const entry=attempts.get(String(key));
    const at=now();
    if(!entry)return{allowed:true,retryAfterMs:0};
    if(at-entry.lastSeen>=settings.staleAfterMs){attempts.delete(String(key));return{allowed:true,retryAfterMs:0};}
    const retryAfterMs=Math.max(0,entry.blockedUntil-at);
    return{allowed:retryAfterMs===0,retryAfterMs};
  }
  function recordFailure(key){
    const id=String(key);const at=now();prune(at);
    const previous=attempts.get(id);const failures=(previous?.failures||0)+1;
    const exponent=Math.max(0,failures-settings.freeFailures-1);
    const delay=failures>settings.freeFailures?Math.min(settings.maxDelayMs,settings.baseDelayMs*(2**exponent)):0;
    attempts.delete(id);
    attempts.set(id,{failures,blockedUntil:at+delay,lastSeen:at});
    return{allowed:delay===0,retryAfterMs:delay};
  }
  function recordSuccess(key){attempts.delete(String(key));}
  return{check,recordFailure,recordSuccess};
}

export const loginAttemptLimiter=createLoginAttemptLimiter();

function secret(){ return process.env.SESSION_SECRET || 'local-dev-session-secret-change-me'; }
function sign(payload){ return crypto.createHmac('sha256',secret()).update(payload).digest('base64url'); }
function token(){ const payload=`ok.${Date.now()}`; return `${payload}.${sign(payload)}`; }
function verify(value){
  if(!value) return false;
  const idx=value.lastIndexOf('.'); if(idx<1)return false;
  const payload=value.slice(0,idx), sig=value.slice(idx+1);
  if(!timingSafeEqualText(sig,sign(payload)))return false;
  const ts=Number(payload.split('.').pop());
  return Number.isFinite(ts) && Date.now()-ts < MAX_AGE*1000;
}
function cookies(req){
  return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[x.slice(0,i),decodeURIComponent(x.slice(i+1))];}));
}
export function authEnabled(){ return !!process.env.WORKBENCH_PASSWORD; }
export function isAuthenticated(req){ return !authEnabled() || verify(cookies(req)[COOKIE]); }
export function login(password){
  if(!authEnabled()) return {ok:true,cookie:null};
  if(!timingSafeEqualText(password,process.env.WORKBENCH_PASSWORD)) return {ok:false};
  return {ok:true,cookie:`${COOKIE}=${encodeURIComponent(token())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${process.env.COOKIE_SECURE==='1'?'; Secure':''}`};
}
export function logoutCookie(){ return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; }
export function captureAuthorized(req){
  const expected=process.env.CAPTURE_TOKEN;
  if(authEnabled()&&isAuthenticated(req))return true;
  if(!expected)return false;
  const auth=String(req.headers.authorization||'');
  const supplied=auth.startsWith('Bearer ')?auth.slice(7):'';
  return timingSafeEqualText(supplied,expected);
}
