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

export async function snapshotTree(root,{maxEntries=100_000,maxDurationMs=60_000,hashFiles=false,maxHashBytes=16*1024*1024,ignorePrefixes=[],ignoreNames=[]}={}){
  const resolved=await fsp.realpath(root);
  const started=Date.now();
  const entries=[];
  const counts={files:0,directories:0,symlinks:0,other:0,contentHashedFiles:0};

  async function walk(full,relative){
    if(Date.now()-started>maxDurationMs)throw Object.assign(new Error('目录快照超时。'),{code:'HOST_P0_SNAPSHOT_TIMEOUT'});
    if(entries.length>=maxEntries)throw Object.assign(new Error('目录快照超过条目上限。'),{code:'HOST_P0_SNAPSHOT_LIMIT'});
    if(relative!=='.'&&(ignored(relative,ignorePrefixes)||ignoreNames.includes(path.basename(relative))))return;
    const stat=await fsp.lstat(full);
    const base={path:relative.split(path.sep).join('/'),mode:stat.mode&0o7777,mtimeMs:Math.trunc(stat.mtimeMs)};
    if(stat.isDirectory()){
      counts.directories+=1;entries.push({...base,type:'directory'});
      const names=(await fsp.readdir(full)).sort((a,b)=>a.localeCompare(b));
      for(const name of names)await walk(path.join(full,name),relative==='.'?name:path.join(relative,name));
      return;
    }
    if(stat.isFile()){
      counts.files+=1;
      const item={...base,type:'file',size:stat.size};
      if(hashFiles&&stat.size<=maxHashBytes){item.sha256=await fileSha256(full);counts.contentHashedFiles+=1;}
      entries.push(item);return;
    }
    if(stat.isSymbolicLink()){
      counts.symlinks+=1;entries.push({...base,type:'symlink',target:await fsp.readlink(full)});return;
    }
    counts.other+=1;entries.push({...base,type:'other',size:stat.size});
  }

  await walk(resolved,'.');
  entries.sort((a,b)=>a.path.localeCompare(b.path));
  const digest=crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return Object.freeze({rootFingerprint:pathFingerprint(resolved),entryCount:entries.length,digest,counts});
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

export function buildMacosLaunchAgentPlist({label='com.dongjue.personal-ai-workbench',appRoot,nodePath,home,pathEnv,stdoutPath,stderrPath}={}){
  for(const [name,value] of Object.entries({label,appRoot,nodePath,home,pathEnv,stdoutPath,stderrPath})){
    if(typeof value!=='string'||!value.trim())throw new Error(`${name} 不能为空。`);
  }
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
