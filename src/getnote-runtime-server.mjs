import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLocalGetnoteReader,GetnoteRuntimeError,normalizeGetnoteNoteId} from './getnote-runtime.mjs';
import {loadWorkbenchEnv} from './env.mjs';

const __filename=fileURLToPath(import.meta.url);
const APP_ROOT=path.dirname(path.dirname(__filename));
const DEFAULT_PORT=4310;

function clean(value){return typeof value==='string'?value.trim():'';}
function validToken(value){const token=clean(value);return token.length>=32&&!/[\r\n]/.test(token)?token:null;}
function isLoopback(host){
  const value=String(host||'').toLowerCase().replace(/^\[|\]$/g,'');
  if(value==='localhost'||value==='::1')return true;
  return net.isIP(value)===4&&value.startsWith('127.');
}
function portValue(value){
  const raw=String(value??DEFAULT_PORT).trim();
  const port=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isInteger(port)||port<1||port>65535)throw new Error('GETNOTE_RUNTIME_PORT 必须是 1-65535 的整数。');
  return port;
}
function secureEqual(a,b){
  const left=Buffer.from(String(a??''));
  const right=Buffer.from(String(b??''));
  return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);
}
function bearer(req){
  const value=String(req.headers.authorization||'');
  const match=value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]||'';
}
function sendJson(res,status,payload,extra={}){
  const body=JSON.stringify(payload);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(body),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    ...extra
  });
  res.end(body);
}
function runtimeFailure(res,error){
  const status=Number.isInteger(error?.statusCode)&&error.statusCode>=400&&error.statusCode<=599?error.statusCode:502;
  return sendJson(res,status,{error:error?.message||'GetNote runtime failed',code:error?.code||'GETNOTE_RUNTIME_UNAVAILABLE'});
}

export function createGetnoteRuntimeServer({reader=createLocalGetnoteReader(),serviceToken}={}){
  const token=validToken(serviceToken);
  if(!token)throw new Error('GETNOTE_RUNTIME_SERVICE_TOKEN 至少需要 32 个字符，sidecar 不允许匿名读取。');
  if(!reader||typeof reader.listNotes!=='function'||typeof reader.fetchTodos!=='function'||typeof reader.fetchNote!=='function')throw new TypeError('GetNote sidecar reader 合同无效。');
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
      if(url.pathname==='/health'){
        if(req.method!=='GET')return sendJson(res,405,{error:'Method not allowed'},{Allow:'GET'});
        return sendJson(res,200,{ok:true,service:'getnote-runtime',readOnly:true});
      }
      if(!secureEqual(bearer(req),token))return sendJson(res,401,{error:'Unauthorized',code:'GETNOTE_RUNTIME_AUTH_FAILED'});
      if(req.method!=='GET')return sendJson(res,405,{error:'Method not allowed'},{Allow:'GET'});

      if(url.pathname==='/v1/notes'){
        const limit=Number(url.searchParams.get('limit')||20);
        if(!Number.isInteger(limit)||limit<1||limit>500)return sendJson(res,400,{error:'limit must be 1-500',code:'GETNOTE_RUNTIME_INVALID'});
        const cursor=url.searchParams.get('cursor');
        if(cursor&&(cursor.length>512||/[\r\n\0]/.test(cursor)))return sendJson(res,400,{error:'invalid cursor',code:'GETNOTE_RUNTIME_INVALID'});
        return sendJson(res,200,await reader.listNotes({limit,cursor:cursor||null}));
      }

      const todosMatch=url.pathname.match(/^\/v1\/notes\/([^/]+)\/todos$/);
      if(todosMatch){
        const noteId=normalizeGetnoteNoteId(decodeURIComponent(todosMatch[1]));
        return sendJson(res,200,await reader.fetchTodos(noteId));
      }
      const noteMatch=url.pathname.match(/^\/v1\/notes\/([^/]+)$/);
      if(noteMatch){
        const noteId=normalizeGetnoteNoteId(decodeURIComponent(noteMatch[1]));
        return sendJson(res,200,await reader.fetchNote(noteId));
      }
      return sendJson(res,404,{error:'Not found',code:'GETNOTE_RUNTIME_NOT_FOUND'});
    }catch(error){return runtimeFailure(res,error);}
  });
}

export async function startGetnoteRuntimeServer({env=process.env,reader}={}){
  await loadWorkbenchEnv({root:APP_ROOT,env});
  const host=clean(env.GETNOTE_RUNTIME_HOST)||'127.0.0.1';
  const port=portValue(env.GETNOTE_RUNTIME_PORT);
  const token=validToken(env.GETNOTE_RUNTIME_SERVICE_TOKEN);
  if(!token)throw new Error('GETNOTE_RUNTIME_SERVICE_TOKEN 至少需要 32 个字符。');
  if(!isLoopback(host)&&clean(env.GETNOTE_RUNTIME_ALLOW_PRIVATE_BIND)!=='1')throw new Error('GetNote runtime 默认只允许 loopback；私网绑定必须显式设置 GETNOTE_RUNTIME_ALLOW_PRIVATE_BIND=1。');
  const server=createGetnoteRuntimeServer({reader:reader||createLocalGetnoteReader({processEnv:env}),serviceToken:token});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return{server,host,port};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===__filename;
if(isMain){
  startGetnoteRuntimeServer().then(({host,port})=>{
    console.log(`GetNote read-only runtime listening on http://${host}:${port}`);
  }).catch(error=>{
    console.error(error.message||error);
    process.exit(1);
  });
}
