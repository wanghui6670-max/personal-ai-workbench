import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

function booleanEnabled(value){
  return ['1','true','yes','on'].includes(String(value??'').trim().toLowerCase());
}

function inside(parent,target){
  const relative=path.relative(parent,target);
  return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));
}

function safePort(value){
  const raw=String(value??'').trim();
  const port=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isInteger(port)||port<1||port>65535){
    throw Object.assign(new Error('PORT 必须是 1 到 65535 之间的整数。'),{code:'HOST_P0_INVALID_PORT'});
  }
  return port;
}

function gitCommit(value){
  const commit=String(value??'').trim().toLowerCase();
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('buildCommit 必须是完整的 40 位 Git SHA。');
  return commit;
}

function doctorContractError(message,code){
  return Object.assign(new Error(message),{code});
}

function normalizeDoctorReport(report){
  if(!report||typeof report!=='object'||Array.isArray(report))throw doctorContractError('doctor JSON 报告必须是对象。','HOST_P0_DOCTOR_CONTRACT_INVALID');
  if(report.schemaVersion!==1)throw doctorContractError('doctor JSON schemaVersion 不受支持。','HOST_P0_DOCTOR_SCHEMA_UNSUPPORTED');
  if(typeof report.ok!=='boolean')throw doctorContractError('doctor JSON 缺少布尔 ok 字段。','HOST_P0_DOCTOR_CONTRACT_INVALID');
  if(!Array.isArray(report.checks))throw doctorContractError('doctor JSON 缺少 checks 数组。','HOST_P0_DOCTOR_CONTRACT_INVALID');
  const seen=new Set();
  const checks=report.checks.map(check=>{
    if(!check||typeof check!=='object'||Array.isArray(check)||typeof check.id!=='string'||!check.id.trim()){
      throw doctorContractError('doctor JSON 包含无效 check id。','HOST_P0_DOCTOR_CONTRACT_INVALID');
    }
    if(seen.has(check.id))throw doctorContractError(`doctor JSON 包含重复 check id：${check.id}。`,'HOST_P0_DOCTOR_CHECK_DUPLICATE');
    seen.add(check.id);
    if(typeof check.required!=='boolean'||typeof check.ok!=='boolean'){
      throw doctorContractError(`doctor JSON check ${check.id} 缺少布尔 required 或 ok。`,'HOST_P0_DOCTOR_CONTRACT_INVALID');
    }
    if(Object.hasOwn(check,'liveRead')&&typeof check.liveRead!=='boolean'){
      throw doctorContractError(`doctor JSON check ${check.id} 的 liveRead 必须是布尔值。`,'HOST_P0_DOCTOR_CONTRACT_INVALID');
    }
    return Object.freeze({...check});
  });
  return Object.freeze({schemaVersion:report.schemaVersion,ok:report.ok,checks:Object.freeze(checks)});
}

export function parseDoctorJsonReport(stdout){
  if(typeof stdout!=='string'||!stdout.trim())throw doctorContractError('doctor JSON 输出为空。','HOST_P0_DOCTOR_JSON_EMPTY');
  let parsed;
  try{parsed=JSON.parse(stdout);}catch{throw doctorContractError('doctor JSON 无法解析。','HOST_P0_DOCTOR_JSON_INVALID');}
  return normalizeDoctorReport(parsed);
}

export function evaluateHostDoctorReport(report){
  const normalized=normalizeDoctorReport(report);
  const byId=new Map(normalized.checks.map(check=>[check.id,check]));
  const failedRequiredCheckIds=normalized.checks.filter(check=>check.required&&!check.ok).map(check=>check.id);
  const summary=id=>{
    const check=byId.get(id);
    return Object.freeze({
      present:Boolean(check),
      ok:check?.ok===true,
      required:check?.required===true,
      liveRead:check?.liveRead===true
    });
  };
  const getnoteRuntime=summary('getnote_runtime');
  const larkCli=summary('lark_cli');
  return Object.freeze({
    ok:normalized.ok===true&&failedRequiredCheckIds.length===0,
    failedRequiredCheckIds:Object.freeze(failedRequiredCheckIds),
    getnoteRuntime,
    larkCli,
    realCliReadChecks:getnoteRuntime.ok&&getnoteRuntime.liveRead||larkCli.ok&&larkCli.liveRead
  });
}

export function validateHostBinding({appRoot,dataDir,workspaceRoot,host='127.0.0.1',port='4173',joycrewEnabled='0',requireJoycrewDisabled=true}={}){
  const app=path.resolve(String(appRoot||''));
  const data=String(dataDir||'').trim();
  const workspace=String(workspaceRoot||'').trim();
  if(!data||!path.isAbsolute(data))throw Object.assign(new Error('真实主机 P0 要求在 .env 中设置绝对 DATA_DIR。'),{code:'HOST_P0_DATA_DIR_REQUIRED'});
  if(!workspace||!path.isAbsolute(workspace))throw Object.assign(new Error('真实主机 P0 要求在 .env 中设置绝对 WORKSPACE_ROOT。'),{code:'HOST_P0_WORKSPACE_REQUIRED'});
  const normalizedData=path.resolve(data);
  const normalizedWorkspace=path.resolve(workspace);
  if(normalizedData===normalizedWorkspace||inside(normalizedData,normalizedWorkspace)||inside(normalizedWorkspace,normalizedData)){
    throw Object.assign(new Error('DATA_DIR 与 WORKSPACE_ROOT 必须是彼此独立的目录，不能相同或互相嵌套。'),{code:'HOST_P0_PATH_OVERLAP'});
  }
  const normalizedHost=String(host||'').trim().toLowerCase().replace(/^\[|\]$/g,'');
  if(!['127.0.0.1','localhost','::1'].includes(normalizedHost)){
    throw Object.assign(new Error('真实主机 P0 只允许绑定 localhost；远程访问在现场验收后再配置。'),{code:'HOST_P0_LOOPBACK_REQUIRED'});
  }
  if(requireJoycrewDisabled&&booleanEnabled(joycrewEnabled)){
    throw Object.assign(new Error('真实主机 P0 必须保持 JOYCREW_ENABLED=0。'),{code:'HOST_P0_JOYCREW_MUST_BE_DISABLED'});
  }
  return Object.freeze({
    appRoot:app,
    dataDir:normalizedData,
    workspaceRoot:normalizedWorkspace,
    host:normalizedHost==='localhost'?'127.0.0.1':normalizedHost,
    port:safePort(port)
  });
}

export function pathFingerprint(value){
  return crypto.createHash('sha256').update(path.resolve(String(value||''))).digest('hex');
}

async function fileSha256(file){
  return new Promise((resolve,reject)=>{
    const hash=crypto.createHash('sha256');
    const stream=createReadStream(file);
    stream.on('error',reject);
    stream.on('data',chunk=>hash.update(chunk));
    stream.on('end',()=>resolve(hash.digest('hex')));
  });
}

function ignored(relative,ignorePrefixes){
  const normalized=relative.split(path.sep).join('/');
  return ignorePrefixes.some(prefix=>normalized===prefix||normalized.startsWith(`${prefix}/`));
}

export async function snapshotTree(root,{maxEntries=100_000,maxDurationMs=60_000,hashFiles=false,maxHashBytes=16*1024*1024,ignorePrefixes=[],ignoreNames=[],maxDepth=Infinity}={}){
  const resolved=await fsp.realpath(root);
  const started=Date.now();
  const entries=[];
  const counts={files:0,directories:0,symlinks:0,other:0,contentHashedFiles:0};
  if(maxDepth!==Infinity&&(!Number.isInteger(maxDepth)||maxDepth<0))throw new Error('maxDepth 必须是非负整数或 Infinity。');

  async function walk(full,relative,depth){
    if(Date.now()-started>maxDurationMs)throw Object.assign(new Error('目录快照超时。'),{code:'HOST_P0_SNAPSHOT_TIMEOUT'});
    if(relative!=='.'&&(ignored(relative,ignorePrefixes)||ignoreNames.includes(path.basename(relative))))return;
    if(entries.length>=maxEntries)throw Object.assign(new Error('目录快照超过条目上限。'),{code:'HOST_P0_SNAPSHOT_LIMIT'});
    const stat=await fsp.lstat(full);
    const base={path:relative.split(path.sep).join('/'),mode:stat.mode&0o7777};
    if(stat.isDirectory()){
      counts.directories+=1;entries.push({...base,type:'directory'});
      if(depth>=maxDepth)return;
      const names=(await fsp.readdir(full)).sort((a,b)=>a.localeCompare(b));
      for(const name of names)await walk(path.join(full,name),relative==='.'?name:path.join(relative,name),depth+1);
      return;
    }
    if(stat.isFile()){
      counts.files+=1;
      const item={...base,type:'file',size:stat.size};
      if(hashFiles&&stat.size<=maxHashBytes){
        item.sha256=await fileSha256(full);
        counts.contentHashedFiles+=1;
      }else{
        item.mtimeMs=Math.trunc(stat.mtimeMs);
      }
      entries.push(item);return;
    }
    if(stat.isSymbolicLink()){
      counts.symlinks+=1;entries.push({...base,type:'symlink',target:await fsp.readlink(full)});return;
    }
    counts.other+=1;entries.push({...base,type:'other',size:stat.size,mtimeMs:Math.trunc(stat.mtimeMs)});
  }

  await walk(resolved,'.',0);
  entries.sort((a,b)=>a.path.localeCompare(b.path));
  const digest=crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return Object.freeze({rootFingerprint:pathFingerprint(resolved),entryCount:entries.length,digest,counts,maxDepth:Number.isFinite(maxDepth)?maxDepth:null});
}

export function compareSnapshots(before,after){
  return Object.freeze({
    equal:before?.digest===after?.digest,
    beforeDigest:before?.digest||null,
    afterDigest:after?.digest||null,
    beforeEntries:before?.entryCount??null,
    afterEntries:after?.entryCount??null
  });
}

function xmlEscape(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'
  }[char]));
}

export function buildMacosLaunchAgentPlist({label='com.dongjue.personal-ai-workbench',appRoot,nodePath,home,pathEnv,stdoutPath,stderrPath,buildCommit}={}){
  for(const [name,value] of Object.entries({label,appRoot,nodePath,home,pathEnv,stdoutPath,stderrPath})){
    if(typeof value!=='string'||!value.trim())throw new Error(`${name} 不能为空。`);
  }
  const commit=gitCommit(buildCommit);
  const serverPath=path.join(appRoot,'src','server.mjs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(serverPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(appRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>WORKBENCH_BUILD_COMMIT</key>
    <string>${xmlEscape(commit)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>20</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export function validateHostReadinessReport(report,{productVersion,commit,appRoot,dataDir,workspaceRoot,maxAgeMs=24*60*60*1000,now=Date.now()}={}){
  if(!report||typeof report!=='object'||Array.isArray(report))throw new Error('P0 主机报告格式无效。');
  if(report.status!=='passed')throw new Error('P0 主机报告未通过。');
  if(report.productVersion!==productVersion)throw new Error('P0 主机报告版本与当前产品不一致。');
  if(report.commit!==commit)throw new Error('P0 主机报告提交与当前代码不一致。');
  const finished=Date.parse(report.finishedAt||'');
  if(!Number.isFinite(finished)||finished>now||now-finished>maxAgeMs)throw new Error('P0 主机报告已过期，请重新运行预检。');
  if(report.binding?.appRootFingerprint!==pathFingerprint(appRoot))throw new Error('P0 主机报告的应用目录与当前目录不一致。');
  if(report.binding?.dataDirFingerprint!==pathFingerprint(dataDir))throw new Error('P0 主机报告的 DATA_DIR 与当前配置不一致。');
  if(report.binding?.workspaceRootFingerprint!==pathFingerprint(workspaceRoot))throw new Error('P0 主机报告的 WORKSPACE_ROOT 与当前配置不一致。');
  if(report.scope?.joycrewEnabled!==false||report.scope?.externalWrites!==false)throw new Error('P0 主机报告的安全范围不符合安装条件。');
  return true;
}
