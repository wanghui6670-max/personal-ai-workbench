import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const WORKBENCH_ENV_KEYS=Object.freeze([
  'PORT','HOST','DATA_DIR','WORKSPACE_ROOT',
  'WORKBENCH_PASSWORD','SESSION_SECRET','COOKIE_SECURE','CAPTURE_TOKEN',
  'OPENAI_API_KEY','OPENAI_MODEL','OPENAI_SEND_FILE_CONTENT',
  'AI_PROVIDER_PROFILE','AI_PROVIDER','AI_PROVIDER_ENABLED','AI_PROVIDER_BASE_URL',
  'AI_PROVIDER_ALLOWED_ORIGINS','AI_PROVIDER_NETWORK_ZONE','AI_PROVIDER_MODEL',
  'AI_PROVIDER_API_KEY','AI_PROVIDER_GROK_MODEL','AI_PROVIDER_GROK_API_KEY',
  'AI_PROVIDER_ACTIVE_MODEL','AI_PROVIDER_ALLOW_ANONYMOUS','AI_PROVIDER_WORKFLOWS',
  'AI_PROVIDER_REASONING_MODE','AI_PROVIDER_ALLOW_REASONING_DOWNGRADE',
  'AI_PROVIDER_STRUCTURED_OUTPUT_MODE','AI_PROVIDER_ALLOW_SCHEMA_DOWNGRADE',
  'AI_PROVIDER_NO_STORE_MODE','AI_PROVIDER_ALLOW_NO_STORE_DOWNGRADE',
  'AI_PROVIDER_CHAT_TOKEN_FIELD','AI_PROVIDER_TIMEOUT_MS','AI_PROVIDER_MAX_RESPONSE_BYTES',
  'AI_SEND_FILE_CONTENT','TRUSTED_ORIGINS','ALLOW_INSECURE_PUBLIC',
  'WORKBENCH_RATE_LIMIT_WINDOW_MS','WORKBENCH_RATE_LIMIT_MAX_CLIENTS',
  'WORKBENCH_CAPTURE_RATE_LIMIT','WORKBENCH_SYNC_RATE_LIMIT',
  'WORKBENCH_MORNING_RATE_LIMIT','WORKBENCH_HARNESS_RATE_LIMIT','WORKBENCH_JOYCREW_RATE_LIMIT',
  'FEISHU_CLI_PATH','WORKBENCH_SCAN_MAX_FILES','WORKBENCH_SCAN_MAX_DIRECTORIES',
  'WORKBENCH_SCAN_MAX_DEPTH','WORKBENCH_SCAN_MAX_DURATION_MS',
  'HARNESS_ENABLED','HARNESS_PROVIDER_MODEL','HARNESS_PROVIDER_API_KEY','HARNESS_PROVIDER_API',
  'HARNESS_PROVIDER_BASE_URL','HARNESS_PROVIDER_NETWORK_ZONE','HARNESS_PROVIDER_CONTEXT_WINDOW',
  'HARNESS_PROVIDER_MAX_TOKENS','HARNESS_REQUEST_TIMEOUT_MS',
  'JOYCREW_ENABLED','JOYCREW_BASE_URL','JOYCREW_NETWORK_ZONE','JOYCREW_AUTH_MODE',
  'JOYCREW_TRUSTED_PROXY_TOKEN','JOYCREW_SESSION_TOKEN','JOYCREW_USER_ID',
  'JOYCREW_WORKSPACE_ID','JOYCREW_ROLE','JOYCREW_TIMEOUT_MS','JOYCREW_MAX_RESPONSE_BYTES'
]);

const ALLOWED_KEYS=new Set(WORKBENCH_ENV_KEYS);

function decodeDoubleQuoted(value){
  let decoded='';
  for(let index=0;index<value.length;index++){
    const char=value[index];
    if(char!=='\\'||index===value.length-1){decoded+=char;continue;}
    const next=value[++index];
    if(next==='n')decoded+='\n';
    else if(next==='r')decoded+='\r';
    else if(next==='t')decoded+='\t';
    else if(next==='"')decoded+='"';
    else if(next==='\\')decoded+='\\';
    else decoded+=`\\${next}`;
  }
  return decoded;
}

function quotedValue(raw,quote){
  let escaped=false;
  for(let index=1;index<raw.length;index++){
    const char=raw[index];
    if(quote==='"'&&char==='\\'&&!escaped){escaped=true;continue;}
    if(char===quote&&!escaped){
      const remainder=raw.slice(index+1).trim();
      if(remainder&&remainder[0]!=='#')return null;
      const value=raw.slice(1,index);
      return quote==='"'?decodeDoubleQuoted(value):value;
    }
    escaped=false;
  }
  return null;
}

function parseValue(raw){
  const trimmed=raw.trim();
  if(!trimmed)return '';
  if(trimmed[0]==='"'||trimmed[0]==="'")return quotedValue(trimmed,trimmed[0]);
  const comment=trimmed.indexOf('#');
  return (comment===-1?trimmed:trimmed.slice(0,comment)).trim();
}

function unsafeValue(value){
  return value.includes('$(')||value.includes('`')||value.includes('\0');
}

export function parseWorkbenchEnv(source){
  const values={};
  const ignored=[];
  const lines=String(source??'').replace(/^\uFEFF/,'').split(/\r?\n/);
  for(let index=0;index<lines.length;index++){
    const line=lines[index].trim();
    if(!line||line.startsWith('#'))continue;
    const match=line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]*)$/);
    if(!match){ignored.push({line:index+1,key:null,reason:'invalid'});continue;}
    const [,key,rawValue]=match;
    if(!ALLOWED_KEYS.has(key)){ignored.push({line:index+1,key,reason:'undeclared'});continue;}
    const value=parseValue(rawValue);
    if(value===null){ignored.push({line:index+1,key,reason:'invalid'});continue;}
    if(unsafeValue(value)){ignored.push({line:index+1,key,reason:'unsafe'});continue;}
    values[key]=value;
  }
  return {values,ignored};
}

export async function loadWorkbenchEnv({root=DEFAULT_ROOT,env=process.env}={}){
  const file=path.join(root,'.env');
  let source;
  try{source=await fsp.readFile(file,'utf8');}
  catch(error){
    if(error?.code==='ENOENT')return{file,found:false,loaded:[],ignored:[]};
    throw error;
  }
  const parsed=parseWorkbenchEnv(source);
  const loaded=[];
  for(const [key,value] of Object.entries(parsed.values)){
    if(Object.hasOwn(env,key))continue;
    env[key]=value;
    loaded.push(key);
  }
  return{file,found:true,loaded,ignored:parsed.ignored};
}
