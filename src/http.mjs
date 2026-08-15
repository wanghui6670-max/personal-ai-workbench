import fsp from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const MUTATING_METHODS=new Set(['POST','PATCH','DELETE']);

function normalizeHostname(value){
  return String(value||'').trim().toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
}
function isLoopbackHostname(value){
  const hostname=normalizeHostname(value);
  return hostname==='localhost'||hostname==='::1'||(isIP(hostname)===4&&hostname.startsWith('127.'))||(isIP(hostname)===6&&hostname.startsWith('::ffff:127.'));
}
function parseHostHeader(value){
  const raw=String(value||'').trim();
  if(!raw||raw.length>255||/[\s/\\\0,@?#]/.test(raw))return null;
  let hostname='';let explicitPort='';
  if(raw.startsWith('[')){
    const match=raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if(!match||isIP(match[1])!==6)return null;
    hostname=normalizeHostname(match[1]);explicitPort=match[2]||'';
  }else{
    const match=raw.match(/^([^:]+?)(?::(\d+))?$/);
    if(!match)return null;
    hostname=normalizeHostname(match[1]);explicitPort=match[2]||'';
    if(!hostname||(/^[\d.]+$/.test(hostname)&&isIP(hostname)!==4))return null;
  }
  if(explicitPort&&(Number(explicitPort)<1||Number(explicitPort)>65535))return null;
  return{hostname,port:explicitPort?String(Number(explicitPort)):''};
}
function parseOrigin(value){
  const raw=String(value||'').trim();
  if(!raw||raw.includes(',')||raw==='null')return null;
  try{
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
    return{origin:url.origin,protocol:url.protocol,hostname:normalizeHostname(url.hostname),port:url.port};
  }catch{return null;}
}
function effectivePort(protocol,port){return port||({ 'http:':'80','https:':'443' }[protocol]||'');}

export function parseTrustedOrigins(value=''){
  const origins=[];
  for(const entry of String(value||'').split(',').map(x=>x.trim()).filter(Boolean)){
    const parsed=parseOrigin(entry);
    if(!parsed)throw new Error(`拒绝启动：TRUSTED_ORIGINS 包含无效 origin：${entry}`);
    if(!origins.some(x=>x.origin===parsed.origin))origins.push(parsed);
  }
  return origins;
}

export function createRequestGuard({bindHost,port,trustedOrigins=''}){
  const boundHostname=normalizeHostname(bindHost);const boundPort=String(port);
  const trusted=parseTrustedOrigins(trustedOrigins);const trustedOriginSet=new Set(trusted.map(x=>x.origin));
  function allowedHost(value){
    const parsed=parseHostHeader(value);if(!parsed)return false;
    if((isLoopbackHostname(parsed.hostname)||parsed.hostname===boundHostname)&&effectivePort('http:',parsed.port)===boundPort)return true;
    return trusted.some(origin=>origin.hostname===parsed.hostname&&effectivePort(origin.protocol,origin.port)===effectivePort(origin.protocol,parsed.port));
  }
  function allowedOrigin(value){
    const parsed=parseOrigin(value);if(!parsed)return false;
    if(trustedOriginSet.has(parsed.origin))return true;
    return parsed.protocol==='http:'&&(isLoopbackHostname(parsed.hostname)||parsed.hostname===boundHostname)&&effectivePort(parsed.protocol,parsed.port)===boundPort;
  }
  return function guardRequest(req){
    if(!allowedHost(req.headers.host))return{status:421,error:'请求 Host 不受信任'};
    if(req.headers.origin&&!allowedOrigin(req.headers.origin))return{status:403,error:'请求 Origin 不受信任'};
    if(MUTATING_METHODS.has(String(req.method||'').toUpperCase())){
      const contentType=String(req.headers['content-type']||'').split(';',1)[0].trim().toLowerCase();
      if(contentType!=='application/json')return{status:415,error:'状态变更请求必须使用 Content-Type: application/json'};
    }
    return null;
  };
}

export function sendJson(res,status,data,extra={}){
  const body=JSON.stringify(data,null,2);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store',...extra});res.end(body);
}
export function sendText(res,status,body,type='text/plain; charset=utf-8',extra={}){
  res.writeHead(status,{'Content-Type':type,'Content-Length':Buffer.byteLength(body),...extra});res.end(body);
}
export async function readJsonBody(req,maxBytes=1024*1024){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('请求内容过大'),{statusCode:413});chunks.push(chunk);}
  if(!chunks.length)return{};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('JSON 格式错误'),{statusCode:400});}
}
export function mime(file){const ext=path.extname(file).toLowerCase();return({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json'}[ext]||'application/octet-stream');}
export async function serveStatic(publicDir,pathname,res){
  let rel=pathname==='/'?'index.html':pathname.replace(/^\//,'');
  let file=path.resolve(publicDir,rel);const root=path.resolve(publicDir);
  if(file!==root&&!file.startsWith(root+path.sep))return false;
  try{const st=await fsp.stat(file);if(st.isDirectory())file=path.join(file,'index.html');const buf=await fsp.readFile(file);res.writeHead(200,{'Content-Type':mime(file),'Cache-Control':file.endsWith('.html')?'no-cache':'public, max-age=3600','X-Content-Type-Options':'nosniff'});res.end(buf);return true;}catch{return false;}
}
export function securityHeaders({allowFrame=false,frameSrc=''}={}){
  const frameAncestors=allowFrame?"'self'":"'none'";
  return{
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'${frameSrc?` ${frameSrc}`:''}; frame-ancestors ${frameAncestors}; base-uri 'self'; form-action 'self'`,
    'X-Frame-Options':allowFrame?'SAMEORIGIN':'DENY',
    'Vary':'Origin'
  };
}