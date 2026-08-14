import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseWorkbenchEnv } from './env.mjs';

function nonEmpty(value){
  return typeof value==='string'&&value.trim()?value.trim():null;
}

async function isDirectory(value){
  try{return (await fsp.stat(value)).isDirectory();}
  catch{return false;}
}

export function encodeEnvValue(value){
  const text=String(value??'');
  if(text==='')return '';
  if(/^[A-Za-z0-9_./:@+,-]+$/.test(text)&&!text.includes('#'))return text;
  return `"${text
    .replace(/\\/g,'\\\\')
    .replace(/"/g,'\\"')
    .replace(/\n/g,'\\n')
    .replace(/\r/g,'\\r')
    .replace(/\t/g,'\\t')}"`;
}

export function upsertEnvSource(source,updates,{header='# Personal AI Workbench macOS P0 binding'}={}){
  const requested=new Map(Object.entries(updates).map(([key,value])=>[key,String(value??'')]));
  const seen=new Set();
  const output=[];
  for(const rawLine of String(source??'').replace(/^\uFEFF/,'').split(/\r?\n/)){
    const match=rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key=match?.[1]||null;
    if(!key||!requested.has(key)){output.push(rawLine);continue;}
    if(seen.has(key))continue;
    seen.add(key);
    output.push(`${key}=${encodeEnvValue(requested.get(key))}`);
  }
  const missing=[...requested.keys()].filter(key=>!seen.has(key));
  while(output.length&&output.at(-1)==='')output.pop();
  if(missing.length){
    if(output.length)output.push('');
    output.push(header);
    for(const key of missing)output.push(`${key}=${encodeEnvValue(requested.get(key))}`);
  }
  return `${output.join('\n')}\n`;
}

export function envValuesFromSource(source){
  return parseWorkbenchEnv(source).values;
}

export async function legacyDataPresent(dataDir){
  try{
    const entries=await fsp.readdir(dataDir);
    return entries.some(name=>name!=='.gitkeep'&&!name.startsWith('.DS_Store'));
  }catch(error){
    if(error?.code==='ENOENT')return false;
    throw error;
  }
}

export async function chooseMacosWorkspace({explicit=null,existing=null,home,additionalCandidates=[]}={}){
  const explicitValue=nonEmpty(explicit);
  if(explicitValue){
    const resolved=path.resolve(explicitValue);
    if(!(await isDirectory(resolved)))throw new Error(`指定的 WORKSPACE_ROOT 不存在或不是目录：${resolved}`);
    return resolved;
  }
  const existingValue=nonEmpty(existing);
  if(existingValue){
    const resolved=path.resolve(existingValue);
    if(!(await isDirectory(resolved)))throw new Error(`现有 .env 的 WORKSPACE_ROOT 不存在或不是目录：${resolved}`);
    return resolved;
  }
  const candidates=[
    path.join(home,'AI-Work-OS'),
    path.join(home,'ai-work-os'),
    path.join(home,'Documents','AI-Work-OS'),
    path.join(home,'Documents','ai-work-os'),
    ...additionalCandidates
  ];
  const matches=new Map();
  for(const candidate of [...new Set(candidates.map(value=>path.resolve(value)))]){
    if(!(await isDirectory(candidate)))continue;
    const real=await fsp.realpath(candidate);
    if(!matches.has(real))matches.set(real,candidate);
  }
  const unique=[...matches.values()];
  if(unique.length===1)return unique[0];
  if(unique.length>1)throw new Error(`发现多个可能的项目根目录，请使用 --workspace 明确指定：\n${unique.join('\n')}`);
  throw new Error(`未找到 AI-Work-OS。预期默认路径：${path.join(home,'AI-Work-OS')}。可使用 --workspace <绝对路径> 指定。`);
}

export async function chooseMacosDataDir({explicit=null,existing=null,appRoot,home}={}){
  const selected=nonEmpty(explicit)||nonEmpty(existing);
  if(selected)return path.resolve(selected);
  const legacy=path.join(appRoot,'data');
  if(await legacyDataPresent(legacy))return legacy;
  return path.join(home,'Library','Application Support','PersonalAIWorkbench','data');
}

export function macosP0Updates({workspaceRoot,dataDir,port=44173}={}){
  const numericPort=Number(port);
  if(!Number.isInteger(numericPort)||numericPort<1||numericPort>65535)throw new Error('端口必须是 1 到 65535 之间的整数。');
  if(!path.isAbsolute(workspaceRoot)||!path.isAbsolute(dataDir))throw new Error('WORKSPACE_ROOT 与 DATA_DIR 必须是绝对路径。');
  const relative=path.relative(path.resolve(dataDir),path.resolve(workspaceRoot));
  const reverse=path.relative(path.resolve(workspaceRoot),path.resolve(dataDir));
  if(relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative))||(!reverse.startsWith('..')&&!path.isAbsolute(reverse))){
    throw new Error('WORKSPACE_ROOT 与 DATA_DIR 不能相同或互相嵌套。');
  }
  return Object.freeze({
    HOST:'127.0.0.1',
    PORT:String(numericPort),
    DATA_DIR:path.resolve(dataDir),
    WORKSPACE_ROOT:path.resolve(workspaceRoot),
    TRUSTED_ORIGINS:'',
    COOKIE_SECURE:'0',
    JOYCREW_ENABLED:'0',
    HARNESS_ENABLED:'0',
    AI_PROVIDER_ENABLED:'0',
    ALLOW_INSECURE_PUBLIC:'0'
  });
}

export async function writeEnvAtomically(file,source,{backupDir=null}={}){
  let previous=null;
  try{previous=await fsp.readFile(file,'utf8');}
  catch(error){if(error?.code!=='ENOENT')throw error;}
  let backupPath=null;
  if(previous!==null&&backupDir){
    await fsp.mkdir(backupDir,{recursive:true,mode:0o700});
    backupPath=path.join(backupDir,`.env-before-bootstrap-${new Date().toISOString().replace(/[:.]/g,'-')}`);
    await fsp.writeFile(backupPath,previous,{encoding:'utf8',mode:0o600});
  }
  const temp=`${file}.tmp-${process.pid}`;
  try{
    await fsp.writeFile(temp,source,{encoding:'utf8',mode:0o600});
    await fsp.rename(temp,file);
    await fsp.chmod(file,0o600);
  }finally{
    await fsp.rm(temp,{force:true}).catch(()=>undefined);
  }
  return Object.freeze({previous,backupPath,created:previous===null});
}

export async function restoreEnvFile(file,record){
  if(record?.previous===null){await fsp.rm(file,{force:true});return;}
  if(typeof record?.previous==='string'){
    const temp=`${file}.rollback-${process.pid}`;
    try{
      await fsp.writeFile(temp,record.previous,{encoding:'utf8',mode:0o600});
      await fsp.rename(temp,file);
      await fsp.chmod(file,0o600);
    }finally{
      await fsp.rm(temp,{force:true}).catch(()=>undefined);
    }
  }
}
