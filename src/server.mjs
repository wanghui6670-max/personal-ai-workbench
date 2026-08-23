import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.mjs';
import { createDatabase } from './db.mjs';
import { createStoreAdapter, LEGACY_USER_ID } from './store-adapter.mjs';
import { authEnabled,isAuthenticated,login,logoutCookie,captureAuthorized,loginAttemptLimiter,getSessionUser,isMultiUserMode } from './auth.mjs';
import { createUserManager } from './user-manager.mjs';
import { aiEnabled,aiRuntimeConfig } from './ai.mjs';
import { sendJson,readJsonBody,serveStatic,securityHeaders,createRequestGuard,parseTrustedOrigins } from './http.mjs';
import { ensureBusinessDirs, resolveWorkspace, projectPath, readGitAuthority, sanitizeGitRemote } from './projects.mjs';
import { deriveState,createProject,assignProjectBusiness,syncProject,syncAllProjects,syncFeishuInbox,addInbox,processInbox,morningChat,setToday,updateTodo,updateProject,updateWorkbenchConfig,createBusiness,renameBusiness,deleteBusiness } from './domain.mjs';
import { autoRouteInbox } from './inbox-domain.mjs';
import { analyzeFeishuDocument as aiAnalyzeFeishuDocument, routeInboxItems as aiRouteInboxItems, aiEnabled as aiProviderEnabled } from './ai.mjs';
import { captureInbox } from './capture-domain.mjs';
import { FeishuSourceError } from './feishu.mjs';
import { nowIso,newId } from './utils.mjs';
import { addActivity } from './store.mjs';
import { createEndpointRateLimiter,endpointRateLimitConfig,requestClientKey } from './rate-limit.mjs';
import { loadWorkbenchEnv } from './env.mjs';
import { inspectReadiness } from './health.mjs';
import { requestSchemas,validateRequestBody } from './request-validation.mjs';
import { createWorkbenchRegistry, jsonRpcResult, jsonRpcError } from './mcp/registry.mjs';
import { createHarnessNavigator, resolveHarnessWebUrl } from './harness-navigator.mjs';
import { createHarnessHttp } from './harness-http.mjs';
import { harnessBridgeBaseUrl } from './harness-auth.mjs';
import { HARNESS_NAVIGATOR_TOOL_ALLOWLIST } from './harness-policy.mjs';
import { createCapabilityRegistry, createLegacyMcpProvider, createToolBroker, createExecutionStore, createExecutionService, createHarnessPolicy, createSessionStore, createSessionManager, createDshRuntimeAdapter, createContextAwareDriver, createHarnessRunScope, createSqliteSessionStore, createSqliteExecutionStore } from './harness-core/index.mjs';
import { createJoycrewClient, JoycrewClientError } from './joycrew-client.mjs';
import { createJoycrewActionBroker } from './joycrew-actions.mjs';
import { createCrewCatalog } from './crew-catalog.mjs';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from './product.mjs';

const __filename=fileURLToPath(import.meta.url);const SRC_DIR=path.dirname(__filename);const APP_ROOT=path.dirname(SRC_DIR);const PUBLIC_DIR=path.join(APP_ROOT,'public');
await loadWorkbenchEnv({root:APP_ROOT});
const DATA_DIR=process.env.DATA_DIR?path.resolve(process.env.DATA_DIR):path.join(APP_ROOT,'data');

function refuseStartup(message){console.error(message);process.exit(1);}
function normalizeHost(value){
  let host=String(value||'').trim();
  if(host.startsWith('[')&&host.endsWith(']'))host=host.slice(1,-1);
  if(!host||host.length>255||/[\s/\\\0]/.test(host))refuseStartup('拒绝启动：HOST 格式无效。');
  if((host.includes(':')&&isIP(host)!==6)||(/^[\d.]+$/.test(host)&&isIP(host)!==4))refuseStartup('拒绝启动：HOST 格式无效。');
  return host;
}
function isLoopbackHost(value){
  const host=String(value).toLowerCase().replace(/^\[|\]$/g,'');
  return host==='localhost'||host==='::1'||(isIP(host)===4&&host.startsWith('127.'))||(isIP(host)===6&&host.startsWith('::ffff:127.'));
}
function normalizePort(value){
  const raw=String(value).trim();const port=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isInteger(port)||port<1||port>65535)refuseStartup('拒绝启动：PORT 必须是 1 到 65535 之间的整数。');
  return port;
}
async function configuredPortBeforeEnsure(){
  if(process.env.PORT!==undefined)return process.env.PORT;
  try{
    const raw=JSON.parse(await fsp.readFile(path.join(DATA_DIR,'config.json'),'utf8'));
    return raw?.port??4173;
  }catch(error){
    if(error?.code==='ENOENT')return 4173;
    refuseStartup('拒绝启动：无法在安全预检中读取 data/config.json。');
  }
}

const host=normalizeHost(process.env.HOST??'127.0.0.1');
const port=normalizePort(await configuredPortBeforeEnsure());
const publicBind=!isLoopbackHost(host);
const configuredTrustedOrigins=process.env.TRUSTED_ORIGINS||'';
let trustedOrigins;
try{trustedOrigins=parseTrustedOrigins(configuredTrustedOrigins);}
catch(error){refuseStartup(error.message);}
const publicExposure=publicBind||trustedOrigins.some(origin=>!isLoopbackHost(origin.hostname));
if(publicExposure&&!authEnabled()&&process.env.ALLOW_INSECURE_PUBLIC!=='1'){
  refuseStartup('拒绝启动：当前绑定到公开接口但未启用认证。请设置 WORKBENCH_PASSWORD 或配置多用户认证。');
}
const configuredSessionSecret=String(process.env.SESSION_SECRET||'');
if(authEnabled()&&(configuredSessionSecret.trim().length<24||configuredSessionSecret==='local-dev-session-secret-change-me')){
  refuseStartup('拒绝启动：启用认证时 SESSION_SECRET 至少需要 24 个字符，且不能使用本地默认值。');
}
let guardRequest;
try{guardRequest=createRequestGuard({bindHost:host,port,trustedOrigins:configuredTrustedOrigins});}
catch(error){refuseStartup(error.message);}

// ========== Store 初始化 ==========
const jsonStore=new JsonStore(DATA_DIR);await jsonStore.ensure();
let storeAdapter;
if(isMultiUserMode()){
  const db=createDatabase(DATA_DIR);
  storeAdapter=createStoreAdapter({db,dataDir:DATA_DIR,jsonStore});
  // 初始化首个管理员（如果数据库中无用户）
  const userManager=createUserManager(storeAdapter);
  const initialAdminUsername=process.env.WORKBENCH_ADMIN_USERNAME||'admin';
  const initialAdminPassword=process.env.WORKBENCH_ADMIN_PASSWORD;
  if(initialAdminPassword){
    const admin=userManager.ensureInitialAdmin({username:initialAdminUsername,password:initialAdminPassword,displayName:'管理员'});
    if(admin)console.log(`[multi-user] 已创建初始管理员：${admin.username}`);
  }else if(userManager.store.countUsers()===0){
    console.warn('[multi-user] 数据库中无用户且未设置 WORKBENCH_ADMIN_PASSWORD，请在环境变量中设置后重启以创建首个管理员。');
  }
}else{
  storeAdapter=createStoreAdapter({db:null,dataDir:DATA_DIR,jsonStore});
}
// 全局默认 store（用于不区分用户的全局操作，如 health check）
const globalStore=storeAdapter.scope(LEGACY_USER_ID);

const initialConfig=await globalStore.readConfig();await ensureBusinessDirs(APP_ROOT,initialConfig);
const crewCatalog=createCrewCatalog({appRoot:APP_ROOT,homeDir:process.env.HOME});
const joycrewClient=createJoycrewClient({env:process.env});
const joycrewActions=createJoycrewActionBroker({client:joycrewClient});
// MCP registry 传入 adapter（它的 context() 在运行时会用 store.readState() 不传 userId，
// 但在多用户模式下 handler 会传 scopedStore 覆盖）
const mcpRegistry=createWorkbenchRegistry({appRoot:APP_ROOT,store:globalStore,joycrewClient,joycrewActions});
const harnessNavigator=createHarnessNavigator({appRoot:APP_ROOT,bridgeUrl:harnessBridgeBaseUrl(host,port),env:process.env});
const capabilityRegistry=createCapabilityRegistry();
capabilityRegistry.registerProvider(createLegacyMcpProvider({
  id:'legacy-mcp',
  mcpRegistry,
  capabilities:[{id:'harness.navigator',toolNames:[...HARNESS_NAVIGATOR_TOOL_ALLOWLIST]}]
}));
const executionStore=createExecutionStore({file:path.join(DATA_DIR,'harness/executions.json')});
await executionStore.load();
const execution=createExecutionService({store:executionStore});
const toolBroker=createToolBroker({registry:capabilityRegistry,policy:createHarnessPolicy(),execution});
const sessionStore=createSessionStore({file:path.join(DATA_DIR,'harness/sessions.json')});
await sessionStore.load();
const sessionManager=createSessionManager({
  store:sessionStore,
  projectLookup:async projectId=>{
    const state=await globalStore.readState();
    const project=(state.projects||[]).find(item=>item.id===projectId);
    return project?{...project,git:sanitizeGitRemote(project.git)}:null;
  },
  execution,
  authorities:{
    async readGit(project){
      const config=await globalStore.readConfig();
      const dir=project?projectPath(APP_ROOT,config,project):null;
      if(!dir)return {head:null,remote:sanitizeGitRemote(project?.git),dirty:false};
      const live=await readGitAuthority(dir);
      return {head:live.head,remote:live.remote||sanitizeGitRemote(project.git),dirty:!!live.dirty};
    },
    async readFeishu(project){return {documentUrl:project.feishu||''};}
  }
});
const runtime=createDshRuntimeAdapter({navigator:harnessNavigator});
const harnessRunScope=createHarnessRunScope();
const driver=createContextAwareDriver({sessionManager,runtime,runScope:harnessRunScope});

// ========== Per-user Harness 上下文缓存 ==========
// 在多用户模式下，为每个用户创建独立的 session/execution 上下文（基于 SQLite）。
// 共享的 harnessNavigator 和 harnessRunScope 保证同一时刻只有一个 navigator 任务执行。
const harnessUserContexts=new Map();
function resolveUserHarnessContext(userId){
  if(!isMultiUserMode()||!userId||userId===LEGACY_USER_ID)return null;
  let ctx=harnessUserContexts.get(userId);
  if(ctx)return ctx;
  const sqliteStore=storeAdapter.raw;
  const userSessionStore=createSqliteSessionStore({sqliteStore,userId});
  const userExecutionStore=createSqliteExecutionStore({sqliteStore,userId});
  const userExecution=createExecutionService({store:userExecutionStore});
  const userSessionManager=createSessionManager({
    store:userSessionStore,
    projectLookup:async projectId=>{
      const scoped=storeAdapter.scope(userId);
      const state=await scoped.readState();
      const project=(state.projects||[]).find(item=>item.id===projectId);
      return project?{...project,git:sanitizeGitRemote(project.git)}:null;
    },
    execution:userExecution,
    authorities:{
      async readGit(project){
        const scoped=storeAdapter.scope(userId);
        const config=await scoped.readConfig();
        const dir=project?projectPath(APP_ROOT,config,project):null;
        if(!dir)return {head:null,remote:sanitizeGitRemote(project?.git),dirty:false};
        const live=await readGitAuthority(dir);
        return {head:live.head,remote:live.remote||sanitizeGitRemote(project.git),dirty:!!live.dirty};
      },
      async readFeishu(project){return {documentUrl:project.feishu||''};}
    }
  });
  const userDriver=createContextAwareDriver({sessionManager:userSessionManager,runtime,runScope:harnessRunScope,userId});
  ctx={driver:userDriver,sessionManager:userSessionManager,execution:userExecution};
  harnessUserContexts.set(userId,ctx);
  return ctx;
}

const harnessHttp=createHarnessHttp({
  navigator:harnessNavigator,
  mcpRegistry,
  toolBroker,
  driver,
  sessionRefResolver:harnessRunScope.currentSessionRef,
  resolveUserDriver:resolveUserHarnessContext
});
const aiPlans=new Map();
const AI_PLAN_TTL_MS=10*60*1000;
function pruneAiPlans(){const cutoff=Date.now()-AI_PLAN_TTL_MS;for(const [id,plan] of aiPlans){if(plan.createdAt<cutoff)aiPlans.delete(id);}}
const rateLimitConfig=endpointRateLimitConfig();
const endpointLimiter=createEndpointRateLimiter(rateLimitConfig);

function withSecurity(res,pathname=''){
  const allowAnyFrame=pathname==='/preview.html';
  const raw=res.writeHead.bind(res);
  res.writeHead=(status,headers={})=>raw(status,{...securityHeaders({allowAnyFrame,frameSrc:harnessFrameSrc}),...headers});
  return res;
}
function notFound(res){return sendJson(res,404,{error:'Not found'});}
function unauthorized(res){return sendJson(res,401,{error:'未登录'});}
function forbidden(res){return sendJson(res,403,{error:'无权限'});}
function methodNotAllowed(res,allowed){return sendJson(res,405,{error:'Method not allowed'},{Allow:allowed});}
function rateLimited(req,res,scope){
  const result=endpointLimiter.consume(scope,requestClientKey(req));
  if(result.allowed)return false;
  sendJson(res,429,{error:'请求过于频繁，请稍后重试。'},{'Retry-After':String(Math.max(1,Math.ceil(result.retryAfterMs/1000)))});
  return true;
}

async function apiState(scopedStore){return deriveState(APP_ROOT,await scopedStore.readState(),await scopedStore.readConfig(),aiEnabled());}
async function requestBody(req,schema){return validateRequestBody(await readJsonBody(req),schema);}

const harnessWebUrl=process.env.HARNESS_ENABLED==='1'?resolveHarnessWebUrl(process.env):null;
const harnessFrameSrc=harnessWebUrl?new URL(harnessWebUrl).origin:'';

// ========== 用户管理 API ==========
function requireAdmin(req){
  const user=getSessionUser(req);
  if(!user||user.role!=='admin')return false;
  return true;
}

const server=http.createServer(async(req,rawRes)=>{
  let res=rawRes;
  try{
    const earlyUrl=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    const earlyPath=decodeURIComponent(earlyUrl.pathname);
    res=withSecurity(rawRes,earlyPath);
    const guardFailure=guardRequest(req);
    if(guardFailure)return sendJson(res,guardFailure.status,{error:guardFailure.error});
    const url=earlyUrl;const pathname=earlyPath;

    // ========== 公开端点（无需认证）==========
    if(pathname==='/api/health'&&req.method==='GET'){
      try{
        const {workspaceRoot}=await inspectReadiness({appRoot:APP_ROOT,store:globalStore});
        const enabled=aiEnabled();
        const privateHealthVisible=(!publicExposure&&!authEnabled())||(authEnabled()&&isAuthenticated(req));
        const joycrewStatus=joycrewClient.status();
        const health={ok:true,version:PRODUCT_VERSION,time:nowIso(),authEnabled:authEnabled(),multiUser:isMultiUserMode(),aiEnabled:enabled,aiConfig:enabled?aiRuntimeConfig():null,harnessNavigator:harnessNavigator.status(),joycrew:privateHealthVisible?joycrewStatus:{enabled:joycrewStatus.enabled,configured:joycrewStatus.configured}};
        if(privateHealthVisible)health.workspaceRoot=workspaceRoot;
        return sendJson(res,200,health);
      }catch{return sendJson(res,503,{ok:false,status:'not_ready'});}
    }
    if(pathname==='/api/auth/status'&&req.method==='GET'){
      const sessionUser=getSessionUser(req);
      return sendJson(res,200,{
        authEnabled:authEnabled(),
        multiUser:isMultiUserMode(),
        authenticated:isAuthenticated(req),
        user:sessionUser?{id:sessionUser.uid,name:sessionUser.name,role:sessionUser.role}:null
      });
    }
    if(pathname==='/api/auth/login'&&req.method==='POST'){
      let body;
      if(isMultiUserMode()){
        body=await readJsonBody(req);
        if(!body.username||!body.password)throw Object.assign(new Error('请输入用户名和密码。'),{statusCode:400});
      }else{
        body=await validateRequestBody(await readJsonBody(req),requestSchemas.login);
      }
      const clientKey=req.socket.remoteAddress||'unknown';
      const allowed=loginAttemptLimiter.check(clientKey);
      if(!allowed.allowed)return sendJson(res,429,{error:'登录尝试过于频繁，请稍后重试。'},{'Retry-After':String(Math.max(1,Math.ceil(allowed.retryAfterMs/1000)))});
      const result=await login({...body,store:storeAdapter});
      if(!result.ok){
        const failure=loginAttemptLimiter.recordFailure(clientKey);
        if(!failure.allowed)return sendJson(res,429,{error:'登录尝试过于频繁，请稍后重试。'},{'Retry-After':String(Math.max(1,Math.ceil(failure.retryAfterMs/1000)))});
        return sendJson(res,401,{error:isMultiUserMode()?'用户名或密码错误':'密码错误'});
      }
      loginAttemptLimiter.recordSuccess(clientKey);
      return sendJson(res,200,{ok:true,...(result.user?{user:result.user}:{})},result.cookie?{'Set-Cookie':result.cookie}:{});
    }
    if(pathname==='/api/auth/logout'&&req.method==='POST'){await readJsonBody(req).catch(()=>{});return sendJson(res,200,{ok:true},{'Set-Cookie':logoutCookie()});}

    // ========== 管理员：查看所有员工数据 ==========
    if(isMultiUserMode()&&pathname.startsWith('/api/admin/')){
      if(!isAuthenticated(req))return unauthorized(res);
      if(!requireAdmin(req))return forbidden(res);

      // GET /api/admin/all-state — 返回所有用户的数据概要
      if(pathname==='/api/admin/all-state'&&req.method==='GET'){
        const userManager=createUserManager(storeAdapter);
        const users=userManager.list();
        const allData=await Promise.all(users.map(async u=>{
          const userStore=storeAdapter.scope(u.id);
          const state=await userStore.readState();
          const config=await userStore.readConfig();
          const derived=deriveState(APP_ROOT,state,config,aiEnabled());
          return {
            userId:u.id,
            username:u.username,
            displayName:u.displayName,
            role:u.role,
            summary:{
              todos:derived.todos.length,
              inbox:derived.inbox.length,
              projects:derived.projects.length,
              todayTodos:(derived.todayTodos||[]).length,
              activities:(derived.activities||[]).length,
              confirmations:(derived.confirmations||[]).length,
              overdue:derived.stats?.overdue||0,
              businesses:(derived.businesses||[]).length
            },
            todos:derived.todos.map(t=>({id:t.id,title:t.title,dueDate:t.dueDate,done:t.done,project:t.project})),
            inbox:derived.inbox.map(i=>({id:i.id,text:i.text,source:i.source,createdAt:i.createdAt})),
            projects:derived.projects.map(p=>({id:p.id,name:p.name,status:p.status,progress:p.progress?.percent,endDate:p.endDate})),
            recentActivities:(derived.activities||[]).slice(0,20).map(a=>({at:a.at,type:a.type,text:a.text})),
            businesses:(derived.businesses||[]).map(b=>({id:b.id,name:b.name}))
          };
        }));
        return sendJson(res,200,{users:allData});
      }

      // GET /api/admin/users/:userId/state — 返回单个用户的完整数据
      const adminUserMatch=pathname.match(/^\/api\/admin\/users\/([^/]+)\/state$/);
      if(adminUserMatch&&req.method==='GET'){
        const targetUserId=adminUserMatch[1];
        const userManager=createUserManager(storeAdapter);
        const targetUser=userManager.get(targetUserId);
        if(!targetUser)return sendJson(res,404,{error:'用户不存在'});
        const userStore=storeAdapter.scope(targetUserId);
        const state=await userStore.readState();
        const config=await userStore.readConfig();
        const derived=deriveState(APP_ROOT,state,config,aiEnabled());
        return sendJson(res,200,{
          user:{id:targetUser.id,username:targetUser.username,displayName:targetUser.displayName,role:targetUser.role},
          state:derived
        });
      }

      return notFound(res);
    }

    // ========== 用户管理端点（需要管理员权限）==========
    if(isMultiUserMode()&&pathname.startsWith('/api/users')){
      if(!isAuthenticated(req))return unauthorized(res);
      if(!requireAdmin(req))return forbidden(res);

      if(pathname==='/api/users'&&req.method==='GET'){
        const userManager=createUserManager(storeAdapter);
        return sendJson(res,200,{users:userManager.list()});
      }
      if(pathname==='/api/users'&&req.method==='POST'){
        const body=await readJsonBody(req);
        const userManager=createUserManager(storeAdapter);
        try{
          const user=userManager.register(body);
          return sendJson(res,201,{user});
        }catch(error){
          const status=error.statusCode||400;
          return sendJson(res,status,{error:error.message});
        }
      }
      const userMatch=pathname.match(/^\/api\/users\/([^/]+)$/);
      if(userMatch){
        const userId=userMatch[1];
        const userManager=createUserManager(storeAdapter);
        if(req.method==='GET'){
          const user=userManager.get(userId);
          if(!user)return sendJson(res,404,{error:'用户不存在'});
          return sendJson(res,200,{user});
        }
        if(req.method==='PATCH'){
          const body=await readJsonBody(req);
          try{
            const user=userManager.update(userId,body);
            return sendJson(res,200,{user});
          }catch(error){
            const status=error.statusCode||400;
            return sendJson(res,status,{error:error.message});
          }
        }
        if(req.method==='DELETE'){
          try{
            const result=userManager.delete(userId);
            return sendJson(res,200,result);
          }catch(error){
            const status=error.statusCode||400;
            return sendJson(res,status,{error:error.message});
          }
        }
      }
      // 修改密码端点（当前用户自己改）
      const passwordMatch=pathname.match(/^\/api\/users\/([^/]+)\/password$/);
      if(passwordMatch&&req.method==='POST'){
        const userId=passwordMatch[1];
        const sessionUser=getSessionUser(req);
        // 用户只能改自己的密码，管理员可以改任何人的
        if(sessionUser.uid!==userId&&sessionUser.role!=='admin')return forbidden(res);
        const body=await readJsonBody(req);
        const userManager=createUserManager(storeAdapter);
        try{
          const result=userManager.changePassword(userId,body.oldPassword||'',body.newPassword||'');
          return sendJson(res,200,result);
        }catch(error){
          const status=error.statusCode||400;
          return sendJson(res,status,{error:error.message});
        }
      }
      return notFound(res);
    }

    if(pathname==='/api/capture'&&req.method==='POST'){
      if(!captureAuthorized(req))return unauthorized(res);
      const body=await requestBody(req,requestSchemas.capture);
      if(rateLimited(req,res,'capture'))return;
      const captured=await captureInbox({store:globalStore,captureId:body.captureId??null,text:body.text});
      return sendJson(res,captured.replayed?200:201,{captureId:captured.captureId,replayed:captured.replayed,processed:captured.processed,item:captured.item});
    }

    // Bridge 调用来自 DSH sidecar 进程，不携带用户 session；
    // 通过 harnessRunScope 获取当前正在执行的 userId，用对应 scopedStore 写入数据。
    const bridgeUserId=harnessRunScope.currentUserId();
    const bridgeStore=bridgeUserId&&storeAdapter?storeAdapter.scope(bridgeUserId):globalStore;
    if(await harnessHttp.handleBridge(req,res,pathname,bridgeStore))return;

    // ========== 认证检查 ==========
    if(pathname.startsWith('/api/')&&!isAuthenticated(req))return unauthorized(res);

    // 获取当前登录用户 + 创建 per-request scopedStore
    const sessionUser=getSessionUser(req);
    const currentUserId=sessionUser?sessionUser.uid:LEGACY_USER_ID;
    const scopedStore=storeAdapter.scope(currentUserId);

    if(await harnessHttp.handleUser(req,res,pathname,{rateLimit:()=>rateLimited(req,res,'navigator')},currentUserId,scopedStore))return;

    if(pathname==='/api/joycrew/status'){
      if(req.method!=='GET')return methodNotAllowed(res,'GET');
      if(rateLimited(req,res,'joycrew'))return;
      return sendJson(res,200,{joycrew:await joycrewClient.probe()});
    }
    if(pathname==='/api/joycrew/overview'){
      if(req.method!=='GET')return methodNotAllowed(res,'GET');
      if(rateLimited(req,res,'joycrew'))return;
      return sendJson(res,200,{overview:await joycrewClient.overview()});
    }
    const joycrewProjectMatch=pathname.match(/^\/api\/joycrew\/projects\/([^/]+)$/);
    if(joycrewProjectMatch){
      if(req.method!=='GET')return methodNotAllowed(res,'GET');
      if(rateLimited(req,res,'joycrew'))return;
      return sendJson(res,200,{detail:await joycrewClient.project(joycrewProjectMatch[1])});
    }
    if(pathname==='/api/joycrew/actions'){
      if(req.method!=='GET')return methodNotAllowed(res,'GET');
      return sendJson(res,200,{actions:joycrewActions.list()});
    }
    if(pathname==='/api/joycrew/actions/prepare'){
      if(req.method!=='POST')return methodNotAllowed(res,'POST');
      if(rateLimited(req,res,'joycrew'))return;
      const body=await requestBody(req,requestSchemas.joycrewActionPrepare);
      return sendJson(res,201,{action:joycrewActions.prepare(body.type,body.payload,{source:body.source||'operations-ui'})});
    }
    const actionExecuteMatch=pathname.match(/^\/api\/joycrew\/actions\/([^/]+)\/execute$/);
    if(actionExecuteMatch){
      if(req.method!=='POST')return methodNotAllowed(res,'POST');
      if(rateLimited(req,res,'joycrew'))return;
      const body=await requestBody(req,requestSchemas.joycrewActionExecute);
      return sendJson(res,200,{action:await joycrewActions.execute(actionExecuteMatch[1],{confirmed:body.confirmed})});
    }
    const actionCancelMatch=pathname.match(/^\/api\/joycrew\/actions\/([^/]+)\/cancel$/);
    if(actionCancelMatch){
      if(req.method!=='POST')return methodNotAllowed(res,'POST');
      await requestBody(req,requestSchemas.empty);
      return sendJson(res,200,{action:joycrewActions.cancel(actionCancelMatch[1])});
    }

    if(pathname==='/api/ai/tools'&&req.method==='GET')return sendJson(res,200,{tools:mcpRegistry.list(),mcpTransport:'/api/mcp'});
    if(pathname==='/api/ai/plan'&&req.method==='POST'){
      const body=await requestBody(req,requestSchemas.aiPlan);pruneAiPlans();
      const planned=await mcpRegistry.plan(body.message,{view:body.view||'today',id:body.id||null});
      const planId=newId('plan');
      const plan={id:planId,createdAt:Date.now(),message:body.message,toolName:planned.toolName||null,args:planned.args||{},reason:planned.reason||'',kind:planned.kind,confirmationRequired:Boolean(planned.confirmationRequired),messageReply:planned.message||null,planner:planned.planner||'local_fallback',plannerModel:planned.plannerModel||null,analysis:planned.analysis||null};
      aiPlans.set(planId,plan);
      return sendJson(res,200,{plan:{...plan,state:planned.state,tool:planned.tool}});
    }
    if(pathname==='/api/ai/execute'&&req.method==='POST'){
      const body=await requestBody(req,requestSchemas.aiExecute);pruneAiPlans();
      const plan=aiPlans.get(body.planId);if(!plan)throw Object.assign(new Error('AI 操作预览已过期，请重新描述。'),{statusCode:409});
      if(!body.confirmed&&plan.confirmationRequired)throw Object.assign(new Error('这项操作会改变工作台，必须先确认。'),{statusCode:409});
      if(!plan.toolName){aiPlans.delete(body.planId);const current=await apiState(scopedStore);return sendJson(res,200,{ok:true,reply:plan.messageReply,state:current,plan});}
      // 执行工具时传 scopedStore 作为 store override
      const outcome=await mcpRegistry.call(plan.toolName,plan.args,{confirmed:body.confirmed===true||!plan.confirmationRequired,store:scopedStore});
      aiPlans.delete(body.planId);
      return sendJson(res,200,{ok:true,tool:outcome.tool,result:outcome.result,state:outcome.state,readback:true,plan});
    }
    if(pathname==='/api/mcp'&&req.method==='POST'){
      const body=await requestBody(req,requestSchemas.mcp);const id=Object.hasOwn(body,'id')?body.id:null;
      try{
        if(body.jsonrpc!=='2.0')throw Object.assign(new Error('jsonrpc 必须是 2.0。'),{code:'MCP_INVALID_REQUEST'});
        const params=body.params&&typeof body.params==='object'?body.params:{};
        if(body.method==='initialize')return sendJson(res,200,jsonRpcResult(id,{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'personal-ai-workbench',version:PRODUCT_VERSION}}));
        if(body.method==='notifications/initialized')return sendJson(res,200,jsonRpcResult(id,{}));
        if(body.method==='tools/list')return sendJson(res,200,jsonRpcResult(id,{tools:mcpRegistry.list()}));
        if(body.method==='tools/call'){
          if(typeof params.name!=='string'||!params.name.trim())throw Object.assign(new Error('tools/call 需要 name。'),{code:'MCP_INVALID_PARAMS'});
          const outcome=await mcpRegistry.call(params.name,params.arguments||{},{confirmed:params.confirmed===true,store:scopedStore});
          return sendJson(res,200,jsonRpcResult(id,{content:[{type:'text',text:JSON.stringify(outcome.result)}],structuredContent:{result:outcome.result,state:outcome.state,readback:true}}));
        }
        throw Object.assign(new Error(`未知 MCP 方法：${body.method}`),{code:'MCP_METHOD_NOT_FOUND'});
      }catch(error){return sendJson(res,200,jsonRpcError(id,error));}
    }

    if(pathname==='/api/state'&&req.method==='GET')return sendJson(res,200,await apiState(scopedStore));
    if(pathname==='/api/export'&&req.method==='GET')return sendJson(res,200,{exportedAt:nowIso(),state:await scopedStore.readState(),config:await scopedStore.readConfig()},{'Content-Disposition':`attachment; filename="workbench-export-${new Date().toISOString().slice(0,10)}.json"`});
    if(pathname==='/api/backup'&&req.method==='POST'){await requestBody(req,requestSchemas.empty);const file=await scopedStore.backupNow();return sendJson(res,200,{ok:true,file});}

    if(pathname==='/api/config'&&req.method==='PATCH'){
      const body=await requestBody(req,requestSchemas.config);const config=await updateWorkbenchConfig({appRoot:APP_ROOT,store:scopedStore,workspaceRoot:body.workspaceRoot,settings:body.settings,dataSource:body.dataSource});
      return sendJson(res,200,{ok:true,config:{...config,workspaceRootResolved:resolveWorkspace(APP_ROOT,config)}});
    }

    if(pathname==='/api/businesses'&&req.method==='POST'){const body=await requestBody(req,requestSchemas.business);return sendJson(res,201,{business:await createBusiness({appRoot:APP_ROOT,store:scopedStore,name:body.name})});}
    const bizMatch=pathname.match(/^\/api\/businesses\/([^/]+)$/);
    if(bizMatch&&req.method==='PATCH'){const body=await requestBody(req,requestSchemas.business);return sendJson(res,200,{business:await renameBusiness({appRoot:APP_ROOT,store:scopedStore,businessId:bizMatch[1],name:body.name})});}
    if(bizMatch&&req.method==='DELETE'){await requestBody(req,requestSchemas.empty);await deleteBusiness({store:scopedStore,businessId:bizMatch[1]});return sendJson(res,200,{ok:true});}

    if(pathname==='/api/inbox'&&req.method==='POST'){const body=await requestBody(req,requestSchemas.inbox);return sendJson(res,201,{item:await addInbox({store:scopedStore,text:body.text,source:'manual'})});}
    if(pathname==='/api/inbox/sync'&&req.method==='POST'){
      const body=await readJsonBody(req).catch(()=>({}));
      if(rateLimited(req,res,'sync'))return;
      return sendJson(res,200,{sync:await syncFeishuInbox({store:scopedStore,autoRoute:body.autoRoute===true})});
    }
    if(pathname==='/api/inbox/auto-route'&&req.method==='POST'){
      await requestBody(req,requestSchemas.empty);if(rateLimited(req,res,'sync'))return;
      return sendJson(res,200,{result:await autoRouteInbox({store:scopedStore})});
    }
    if(pathname==='/api/inbox/command'&&req.method==='POST'){const body=await requestBody(req,requestSchemas.inboxCommand);return sendJson(res,200,await processInbox({store:scopedStore,itemId:body.itemId,command:body.command,targetProjectId:body.targetProjectId??null}));}

    if(pathname==='/api/projects'&&req.method==='POST'){
      const body=await requestBody(req,requestSchemas.projectCreate);const result=await createProject({appRoot:APP_ROOT,store:scopedStore,description:body.description,endDate:body.endDate,businessId:body.businessId??null,sourceInboxId:body.sourceInboxId});return sendJson(res,result.needsFollowup?400:201,result);
    }
    if(pathname==='/api/projects/sync'&&req.method==='POST'){
      await requestBody(req,requestSchemas.empty);if(rateLimited(req,res,'sync'))return;const results=await syncAllProjects({appRoot:APP_ROOT,store:scopedStore});return sendJson(res,200,{results});
    }
    const refreshMatch=pathname.match(/^\/api\/projects\/([^/]+)\/sync$/);
    if(refreshMatch&&req.method==='POST'){
      await requestBody(req,requestSchemas.empty);if(rateLimited(req,res,'sync'))return;return sendJson(res,200,await syncProject({appRoot:APP_ROOT,store:scopedStore,projectId:refreshMatch[1]}));
    }
    const classifyMatch=pathname.match(/^\/api\/projects\/([^/]+)\/classify$/);
    if(classifyMatch&&req.method==='POST'){const body=await requestBody(req,requestSchemas.classify);return sendJson(res,200,{project:await assignProjectBusiness({appRoot:APP_ROOT,store:scopedStore,projectId:classifyMatch[1],businessId:body.businessId})});}
    const projectMatch=pathname.match(/^\/api\/projects\/([^/]+)$/);
    if(projectMatch&&req.method==='PATCH'){const body=await requestBody(req,requestSchemas.projectPatch);return sendJson(res,200,{project:await updateProject({appRoot:APP_ROOT,store:scopedStore,projectId:projectMatch[1],patch:body})});}

    if(pathname==='/api/todos/today'&&req.method==='POST'){const body=await requestBody(req,requestSchemas.today);return sendJson(res,200,{todayPlan:await setToday({store:scopedStore,todoId:body.todoId,add:body.add})});}
    const todoMatch=pathname.match(/^\/api\/todos\/([^/]+)$/);
    if(todoMatch&&req.method==='PATCH'){const body=await requestBody(req,requestSchemas.todoPatch);return sendJson(res,200,{todo:await updateTodo({store:scopedStore,todoId:todoMatch[1],patch:body})});}

    if(pathname==='/api/morning/chat'&&req.method==='POST'){
      const body=await requestBody(req,requestSchemas.morning);if(rateLimited(req,res,'morning'))return;return sendJson(res,200,await morningChat({store:scopedStore,message:body.message,sessionId:body.sessionId??null}));
    }

    if(pathname==='/api/confirmations/clear'&&req.method==='POST'){
      const body=await requestBody(req,requestSchemas.confirmationClear);await scopedStore.updateState(s=>{const c=s.confirmations.find(x=>x.id===body.id);s.confirmations=s.confirmations.filter(x=>x.id!==body.id);if(c)addActivity(s,{type:'confirmation_cleared',text:`处理待确认：${c.text}`});});return sendJson(res,200,{ok:true});
    }

    if(pathname==='/api/notes'&&req.method==='POST'){await requestBody(req,requestSchemas.note);return sendJson(res,409,{error:'新备忘必须先进入收件箱，再由你明确处理。'});}

    if(pathname==='/api/crew'&&req.method==='GET'){
      if(rateLimited(req,res,'crew'))return;
      const data=await crewCatalog.catalog();
      return sendJson(res,200,{ok:true,...data});
    }

    if(pathname.startsWith('/api/'))return notFound(res);
    if(await serveStatic(PUBLIC_DIR,pathname,res))return;
    if(req.method==='GET'&&await serveStatic(PUBLIC_DIR,'/',res))return;
    return notFound(res);
  }catch(e){
    console.error('[server]',e);
    const explicitStatus=Number.isInteger(e?.statusCode)&&e.statusCode>=400&&e.statusCode<=599?e.statusCode:500;
    const safeExternal=e instanceof FeishuSourceError||e instanceof JoycrewClientError;
    const publicMessage=(explicitStatus<500||safeExternal)&&typeof e?.message==='string'&&e.message?e.message:'服务器内部错误，请稍后重试。';
    return sendJson(res,explicitStatus,{error:publicMessage,...(typeof e?.code==='string'?{code:e.code}:{}),...(e?.recovery?{recovery:e.recovery}:{}),...(e?.retryable!==undefined?{retryable:Boolean(e.retryable)}:{})});
  }
});

server.on('close',()=>{void harnessNavigator.close();});

const config=initialConfig;
server.listen(port,host,()=>{
  console.log(`\n${PRODUCT_DISPLAY_NAME} v${PRODUCT_VERSION}`);
  console.log(`http://${host==='0.0.0.0'?'127.0.0.1':host}:${port}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`Store backend: ${storeAdapter.backend}`);
  console.log(`Multi-user: ${isMultiUserMode()?'enabled':'disabled'}`);
  console.log(`Workspace: ${resolveWorkspace(APP_ROOT,config)}`);
  const aiConfig=aiRuntimeConfig();
  console.log(`AI: ${aiEnabled()?`${aiConfig.provider} configured · ${aiConfig.profileId} · ${aiConfig.model} / ${aiConfig.reasoningEffort} (not live-verified)`:'local fallback'}`);
  const harnessStatus=harnessNavigator.status();
  console.log(`Harness Copilot: ${harnessStatus.available?`${harnessStatus.harnessVersion} · ${harnessStatus.model} · read + preview`:`${harnessStatus.reason||'unavailable'} (left workbench unaffected)`}`);
  const joycrewStatus=joycrewClient.status();
  const joycrewConfig=joycrewClient.config();
  console.log(`Joycrew: ${joycrewStatus.configured?`${joycrewConfig.baseUrl} · ${joycrewStatus.authMode} · configured (not live-verified)`:`${joycrewStatus.reason||'disabled'}`}`);
  console.log(`Auth: ${authEnabled()?(isMultiUserMode()?'multi-user (JWT)':'password enabled'):'disabled (localhost recommended)'}`);
});

export { server, storeAdapter, APP_ROOT, harnessNavigator, joycrewClient, joycrewActions };
