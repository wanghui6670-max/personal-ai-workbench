import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeResolve, sanitizeFolderName, dueDeltaDays, clamp, compactText, nowIso, boundedInteger } from './utils.mjs';
import { analyzeProjectWithAI } from './ai.mjs';

const execFileAsync=promisify(execFile);
const IGNORED=new Set(['.git','node_modules','.DS_Store','.next','dist','build','coverage']);
const TEXT_EXT=new Set(['.md','.txt','.json','.yaml','.yml','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.html','.css','.scss','.sql','.toml','.ini']);
const MANAGED_START='<!-- personal-ai-workbench:managed:start -->';
const MANAGED_END='<!-- personal-ai-workbench:managed:end -->';
const PROJECT_ID_PREFIX='<!-- personal-ai-workbench:project-id:';
const NO_FOLLOW=fsConstants.O_NOFOLLOW||0;
const SCAN_DEFAULTS=Object.freeze({maxFiles:600,maxDirectories:400,maxDepth:12,maxDurationMs:5_000});
const SCAN_CAPS=Object.freeze({maxFiles:5_000,maxDirectories:5_000,maxDepth:32,maxDurationMs:30_000});

export function projectScanBudget(env=process.env){
  return{
    maxFiles:boundedInteger(env.WORKBENCH_SCAN_MAX_FILES,SCAN_DEFAULTS.maxFiles,{max:SCAN_CAPS.maxFiles}),
    maxDirectories:boundedInteger(env.WORKBENCH_SCAN_MAX_DIRECTORIES,SCAN_DEFAULTS.maxDirectories,{max:SCAN_CAPS.maxDirectories}),
    maxDepth:boundedInteger(env.WORKBENCH_SCAN_MAX_DEPTH,SCAN_DEFAULTS.maxDepth,{max:SCAN_CAPS.maxDepth}),
    maxDurationMs:boundedInteger(env.WORKBENCH_SCAN_MAX_DURATION_MS,SCAN_DEFAULTS.maxDurationMs,{min:10,max:SCAN_CAPS.maxDurationMs})
  };
}

export function resolveWorkspace(appRoot,config){
  const override=process.env.WORKSPACE_ROOT;
  const raw=override||config.workspaceRoot||'./workspace';
  return path.isAbsolute(raw)?path.resolve(raw):path.resolve(appRoot,raw);
}
export function businessById(config,id){ return config.businesses.find(b=>b.id===id)||null; }
export function projectPath(appRoot,config,project){
  const biz=businessById(config,project.businessId); if(!biz)return null;
  return safeResolve(resolveWorkspace(appRoot,config),biz.folder,project.folder);
}

function insideRealRoot(realRoot,target){
  return target===realRoot||target.startsWith(realRoot+path.sep);
}

function recordRecursiveCreation(firstCreated,root,created){
  if(!firstCreated)return;
  const first=path.resolve(firstCreated),target=path.resolve(root);
  const relative=path.relative(first,target);
  if(relative.startsWith('..')||path.isAbsolute(relative))return;
  let current=first;
  if(!created.includes(current))created.push(current);
  for(const component of relative.split(path.sep).filter(Boolean)){
    current=path.join(current,component);
    if(!created.includes(current))created.push(current);
  }
}

async function workspaceInfo(root,{create=false,created=[]}={}){
  const createdStart=created.length;
  if(create){
    const firstCreated=await fsp.mkdir(root,{recursive:true});
    recordRecursiveCreation(firstCreated,root,created);
  }
  let leaf;
  try{leaf=await fsp.lstat(root);}catch(e){if(e.code==='ENOENT')return{exists:false,root,realRoot:null};throw e;}
  if(leaf.isSymbolicLink())throw new Error('工作区根路径不能是符号链接。');
  const stat=await fsp.stat(root);
  if(!stat.isDirectory())throw new Error('工作区根路径不是目录。');
  const realRoot=await fsp.realpath(root),realStat=await fsp.stat(realRoot);
  for(let index=createdStart;index<created.length;index++)created[index]=await fsp.realpath(created[index]);
  return{exists:true,root,realRoot,identity:{dev:realStat.dev,ino:realStat.ino}};
}

async function assertWorkspaceIdentity(info){
  const current=await fsp.stat(info.realRoot);
  if(!current.isDirectory()||!sameEntry(info.identity,current))throw new Error('工作区根目录在操作期间发生变化，已拒绝继续。');
}

async function assertWorkspaceBinding(info){
  const current=await workspaceInfo(info.root);
  if(!current.exists||current.realRoot!==info.realRoot||!sameEntry(info.identity,current.identity))throw new Error('工作区根目录在操作期间发生变化，已拒绝继续。');
}

async function safeDirectory(root,parts,{create=false,created=[]}={}){
  const target=safeResolve(root,...parts);
  const info=await workspaceInfo(root,{create,created});
  if(!info.exists)return{exists:false,target,realRoot:null};
  const relative=path.relative(root,target);
  const components=relative?relative.split(path.sep).filter(Boolean):[];
  let current=root;
  for(const component of components){
    current=path.join(current,component);
    let stat;
    try{stat=await fsp.lstat(current);}catch(e){
      if(e.code!=='ENOENT')throw e;
      if(!create)return{exists:false,target,realRoot:info.realRoot};
      try{await fsp.mkdir(current);if(!created.includes(current))created.push(current);}
      catch(mkdirError){if(mkdirError.code!=='EEXIST')throw mkdirError;}
      stat=await fsp.lstat(current);
    }
    if(stat.isSymbolicLink())throw new Error(`检测到不安全的符号链接目录：${current}`);
    if(!stat.isDirectory())throw new Error(`项目路径不是目录：${current}`);
    const realCurrent=await fsp.realpath(current);
    if(!insideRealRoot(info.realRoot,realCurrent))throw new Error(`项目路径越出工作区：${current}`);
  }
  return{exists:true,target,realRoot:info.realRoot};
}

async function rollbackEmptyDirectories(created,{strict=false}={}){
  const failures=[];
  for(const dir of [...created].reverse()){
    try{
      const stat=await fsp.lstat(dir);
      if(!stat.isSymbolicLink()&&stat.isDirectory())await fsp.rmdir(dir);
    }catch(e){
      if(e.code==='ENOENT')continue;
      if(strict)failures.push(`${dir}: ${e.message}`);
    }
  }
  if(failures.length)throw new Error(`无法完整回滚新建目录（${failures.join('；')}）`);
}

function rollbackFailure(scope,error,rollbackError){
  const combined=new Error(`${scope}失败，且文件系统回滚未完整完成：${rollbackError.message}`,{cause:error});
  combined.code='FILESYSTEM_ROLLBACK_FAILED';
  return combined;
}

async function createExclusiveBusinessDirectory(root,folder,created){
  const info=await workspaceInfo(root,{create:true,created});
  const target=safeResolve(root,folder);
  try{await fsp.mkdir(target);}
  catch(error){
    if(error.code==='EEXIST')throw new Error('新的业务目录已存在，请换一个名称。');
    throw error;
  }
  created.push(target);
  const stat=await fsp.lstat(target);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('新业务路径不是安全目录，已拒绝创建。');
  const realTarget=await fsp.realpath(target);
  if(!insideRealRoot(info.realRoot,realTarget))throw new Error(`项目路径越出工作区：${target}`);
}

export async function prepareBusinessDirs(appRoot,config,{exclusiveFolder=null}={}){
  const root=resolveWorkspace(appRoot,config),created=[];
  let info;
  try{
    info=await workspaceInfo(root,{create:true,created});
    for(const biz of config.businesses){
      await assertWorkspaceBinding(info);
      if(biz.folder===exclusiveFolder)await createExclusiveBusinessDirectory(info.realRoot,biz.folder,created);
      else await safeDirectory(info.realRoot,[biz.folder],{create:true,created});
    }
  }catch(error){
    try{await rollbackEmptyDirectories(created,{strict:true});}
    catch(rollbackError){throw rollbackFailure('创建业务目录',error,rollbackError);}
    throw error;
  }
  let rolledBack=false;
  return{
    root,
    async rollback(){
      if(rolledBack)return;
      await assertWorkspaceIdentity(info);
      await rollbackEmptyDirectories(created,{strict:true});
      rolledBack=true;
    }
  };
}

export async function ensureBusinessDirs(appRoot,config){
  return (await prepareBusinessDirs(appRoot,config)).root;
}

async function lstatOrNull(target){
  try{return await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

function sameEntry(left,right){
  return left.dev===right.dev&&left.ino===right.ino;
}

export async function stageBusinessDirectoryRename(appRoot,config,oldFolder,newFolder){
  const root=resolveWorkspace(appRoot,config);
  const info=await workspaceInfo(root);
  if(!info.exists)throw new Error('工作区根目录不存在。');
  const oldPath=safeResolve(info.realRoot,oldFolder),newPath=safeResolve(info.realRoot,newFolder);
  if(oldPath===newPath)return{rollback:async()=>{}};
  const oldDirectory=await safeDirectory(info.realRoot,[oldFolder],{create:false});
  await assertWorkspaceBinding(info);
  const destination=await lstatOrNull(newPath);
  if(destination)throw new Error('新的业务目录已存在，请换一个名称。');

  if(!oldDirectory.exists){
    const created=[];
    try{await safeDirectory(info.realRoot,[newFolder],{create:true,created});}
    catch(error){
      try{await rollbackEmptyDirectories(created,{strict:true});}
      catch(rollbackError){throw rollbackFailure('创建改名后的业务目录',error,rollbackError);}
      throw error;
    }
    let rolledBack=false;
    return{async rollback(){if(rolledBack)return;await assertWorkspaceIdentity(info);await rollbackEmptyDirectories(created,{strict:true});rolledBack=true;}};
  }

  await assertWorkspaceBinding(info);
  const before=await fsp.lstat(oldPath);
  if(before.isSymbolicLink()||!before.isDirectory())throw new Error('原业务路径不是安全目录，已拒绝改名。');
  await assertWorkspaceBinding(info);
  await fsp.rename(oldPath,newPath);
  let rolledBack=false;
  return{
    async rollback(){
      if(rolledBack)return;
      await assertWorkspaceIdentity(info);
      if(await lstatOrNull(oldPath))throw new Error('原业务目录位置已被占用，拒绝覆盖回滚。');
      const current=await lstatOrNull(newPath);
      if(!current||current.isSymbolicLink()||!current.isDirectory()||!sameEntry(before,current))throw new Error('改名后的业务目录已发生变化，拒绝覆盖回滚。');
      await fsp.rename(newPath,oldPath);
      rolledBack=true;
    }
  };
}

export async function ensureProjectDir(appRoot,config,project){
  const biz=businessById(config,project.businessId);if(!biz)return null;
  const root=resolveWorkspace(appRoot,config),created=[];
  const dir=projectPath(appRoot,config,project);
  try{
    await safeDirectory(root,[biz.folder,project.folder],{create:true,created});
    for(const sub of ['01_原始资料','02_工作过程','03_最终交付','99_归档'])await safeDirectory(root,[biz.folder,project.folder,sub],{create:true,created});
    await writeProjectMd(dir,project,{root});
    return dir;
  }catch(e){
    await rollbackEmptyDirectories(created);
    throw e;
  }
}

async function rollbackPreparedProject({info,created,projectMd}){
  await assertWorkspaceBinding(info);
  const failures=[];
  if(projectMd){
    try{
      const current=await readProjectMd(projectMd.path);
      if(current.exists&&sameFile(projectMd.stat,current.stat)&&current.content===projectMd.content)await fsp.unlink(projectMd.path);
      else if(current.exists)failures.push(`${projectMd.path}: 文件已发生变化，已拒绝删除`);
    }catch(error){if(error.code!=='ENOENT')failures.push(`${projectMd.path}: ${error.message}`);}
  }
  for(const entry of [...created].reverse()){
    try{
      const current=await fsp.lstat(entry.path,{bigint:true});
      if(current.isSymbolicLink()||!current.isDirectory()||!sameEntry(entry.stat,current)){
        failures.push(`${entry.path}: 目录已发生变化，已拒绝删除`);
        continue;
      }
      await fsp.rmdir(entry.path);
    }catch(error){if(error.code!=='ENOENT')failures.push(`${entry.path}: ${error.message}`);}
  }
  if(failures.length)throw new Error(`无法完整回滚本次新建项目（${failures.join('；')}）`);
}

// A prepared project directory records only artifacts created by this
// invocation. Its rollback therefore preserves a pre-existing project
// directory and user files while removing newly added empty subdirectories and
// a newly created PROJECT.md. Exclusive mode additionally guarantees that a
// new project/classification cannot merge into a directory created by someone
// else between folder selection and filesystem creation.
export async function prepareProjectDir(appRoot,config,project,{exclusive=false}={}){
  const biz=businessById(config,project.businessId);if(!biz)return null;
  const root=resolveWorkspace(appRoot,config),createdPaths=[];
  let info=null,projectMd=null;
  try{
    info=await workspaceInfo(root,{create:true,created:createdPaths});
    const business=await safeDirectory(info.realRoot,[biz.folder],{create:true,created:createdPaths});
    await assertWorkspaceBinding(info);
    const dir=safeResolve(info.realRoot,biz.folder,project.folder);
    if(path.dirname(dir)!==business.target)throw new Error('项目文件夹名称无效，已拒绝创建。');
    if(exclusive){
      try{await fsp.mkdir(dir);}
      catch(error){
        if(error.code==='EEXIST')throw new Error('项目目录已存在，已拒绝覆盖。');
        throw error;
      }
      createdPaths.push(dir);
    }else await safeDirectory(info.realRoot,[biz.folder,project.folder],{create:true,created:createdPaths});
    for(const sub of ['01_原始资料','02_工作过程','03_最终交付','99_归档'])await safeDirectory(info.realRoot,[biz.folder,project.folder,sub],{create:true,created:createdPaths});
    const writtenProjectMd=await writeProjectMd(dir,project,{root:info.realRoot});
    if(writtenProjectMd.created)projectMd=writtenProjectMd;
    const created=[];
    for(const createdPath of createdPaths){
      const stat=await fsp.lstat(createdPath,{bigint:true});
      if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`本次新建路径不是安全目录：${createdPath}`);
      created.push({path:createdPath,stat});
    }
    let rolledBack=false;
    return{
      dir,
      async rollback(){
        if(rolledBack)return;
        await rollbackPreparedProject({info,created,projectMd});
        rolledBack=true;
      }
    };
  }catch(error){
    if(info){
      const created=[];
      for(const createdPath of createdPaths){
        try{
          const stat=await fsp.lstat(createdPath,{bigint:true});
          if(!stat.isSymbolicLink()&&stat.isDirectory())created.push({path:createdPath,stat});
        }catch(readError){if(readError.code!=='ENOENT')throw readError;}
      }
      try{await rollbackPreparedProject({info,created,projectMd});}
      catch(rollbackError){throw rollbackFailure('创建项目目录',error,rollbackError);}
    }
    throw error;
  }
}

export async function prepareNewProjectDir(appRoot,config,project){
  return prepareProjectDir(appRoot,config,project,{exclusive:true});
}

function managedLine(value){
  return String(value??'').replaceAll(MANAGED_START,'[managed start]').replaceAll(MANAGED_END,'[managed end]').replace(/[\r\n]+/g,' ').trim();
}

function managedBlock(project){
  const projectId=String(project.id||'unknown').replace(/[^A-Za-z0-9_-]/g,'_');
  return `${MANAGED_START}\n${PROJECT_ID_PREFIX}${projectId} -->\n# ${managedLine(project.name)}\n\n> 这是工作台生成的轻量项目索引。真实资料仍以本地文件夹为准。\n\n- 项目介绍：${managedLine(project.intro)}\n- 开始时间：${managedLine(project.startDate)}\n- 计划结束：${managedLine(project.endDate)}\n- Git：${managedLine(project.git||'未设置')}\n- 飞书：${managedLine(project.feishu||'未设置')}\n\n## 当前进度\n\n- 状态：${managedLine(project.progress?.status||'未启动')}\n- 百分比：${project.progress?.percent??0}%\n- 进度说明：${managedLine(project.progress?.summary||'尚未同步')}\n- 当前卡点：${managedLine(project.progress?.blocker||'暂无明确卡点')}\n- 上下文恢复：${managedLine(project.progress?.resume||'尚未同步')}\n- 最近同步：${managedLine(project.progress?.syncedAt||'尚未同步')}\n${MANAGED_END}`;
}

function mergeManagedBlock(existing,project){
  const block=managedBlock(project),start=existing.indexOf(MANAGED_START),end=existing.indexOf(MANAGED_END);
  if(start===-1&&end===-1)return existing?`${existing}${existing.endsWith('\n')?'\n':'\n\n'}${block}\n`:`${block}\n`;
  if(start<0||end<start||existing.indexOf(MANAGED_START,start+MANAGED_START.length)>=0||existing.indexOf(MANAGED_END,end+MANAGED_END.length)>=0)throw new Error('PROJECT.md 的工作台托管区块不完整，已拒绝覆盖。');
  const blockEnd=end+MANAGED_END.length,owned=existing.slice(start,blockEnd);
  const owner=owned.match(/<!-- personal-ai-workbench:project-id:([A-Za-z0-9_-]+) -->/);
  const expected=String(project.id||'unknown').replace(/[^A-Za-z0-9_-]/g,'_');
  if(!owner||owner[1]!==expected)throw new Error('PROJECT.md 属于其他项目或无法确认归属，已拒绝覆盖。');
  return existing.slice(0,start)+block+existing.slice(blockEnd);
}

function sameFile(left,right){
  return left.dev===right.dev&&left.ino===right.ino&&left.nlink===right.nlink&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs;
}

async function readProjectMd(target){
  let before;
  try{before=await fsp.lstat(target,{bigint:true});}catch(e){if(e.code==='ENOENT')return{exists:false,content:'',stat:null,mode:0o644};throw e;}
  if(before.isSymbolicLink())throw new Error('PROJECT.md 是符号链接，已拒绝读写。');
  if(!before.isFile())throw new Error('PROJECT.md 不是普通文件，已拒绝覆盖。');
  if(before.nlink>1n)throw new Error('PROJECT.md 是硬链接，已拒绝读写。');
  const handle=await fsp.open(target,fsConstants.O_RDONLY|NO_FOLLOW);
  try{
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile())throw new Error('PROJECT.md 不是普通文件，已拒绝覆盖。');
    if(opened.nlink>1n)throw new Error('PROJECT.md 是硬链接，已拒绝读写。');
    if(!sameFile(before,opened))throw new Error('PROJECT.md 在读取期间发生变化，已取消更新。');
    return{exists:true,content:await handle.readFile({encoding:'utf8'}),stat:opened,mode:Number(opened.mode&0o777n)};
  }finally{await handle.close();}
}

async function assertProjectMdUnchanged(target,before){
  let current;
  try{current=await fsp.lstat(target,{bigint:true});}catch(e){
    if(e.code==='ENOENT'&&!before.exists)return;
    if(e.code==='ENOENT')throw new Error('PROJECT.md 在写入期间被移除，已取消更新。');
    throw e;
  }
  if(current.isSymbolicLink())throw new Error('PROJECT.md 是符号链接，已拒绝写入。');
  if(!current.isFile())throw new Error('PROJECT.md 不是普通文件，已拒绝覆盖。');
  if(current.nlink>1n)throw new Error('PROJECT.md 是硬链接，已拒绝写入。');
  if(!before.exists||!sameFile(current,before.stat))throw new Error('PROJECT.md 在写入期间发生变化，已取消更新。');
}

export async function writeProjectMd(dir,project,{root=null}={}){
  if(root){
    const relative=path.relative(root,dir);
    const checked=await safeDirectory(root,[relative],{create:false});
    if(!checked.exists)throw new Error('项目目录不存在。');
  }else{
    const stat=await fsp.lstat(dir);
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('项目目录不是安全的普通目录。');
  }
  const target=path.join(dir,'PROJECT.md'),before=await readProjectMd(target);
  const content=mergeManagedBlock(before.content,project);
  const temp=path.join(dir,`.PROJECT.md.workbench-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try{
    handle=await fsp.open(temp,fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_WRONLY|NO_FOLLOW,0o600);
    await handle.writeFile(content,'utf8');
    await handle.sync();
    if(root){
      const relative=path.relative(root,dir);
      const checked=await safeDirectory(root,[relative],{create:false});
      if(!checked.exists)throw new Error('项目目录在写入期间被移除。');
    }
    await assertProjectMdUnchanged(target,before);
    if(before.exists)await fsp.rename(temp,target);
    else {await fsp.link(temp,target);await fsp.unlink(temp);}
    await handle.chmod(before.mode);
    await handle.sync();
    const stat=await handle.stat({bigint:true});
    await handle.close();handle=null;
    return{created:!before.exists,path:target,stat,content};
  }finally{
    if(handle)await handle.close().catch(()=>{});
    await fsp.unlink(temp).catch(()=>{});
  }
}

async function projectFolderExists(appRoot,config,businessId,folder){
  const biz=businessById(config,businessId);if(!biz)throw new Error('业务板块不存在');
  const root=resolveWorkspace(appRoot,config),business=await safeDirectory(root,[biz.folder],{create:false});
  if(!business.exists)return false;
  const candidate=safeResolve(root,biz.folder,folder);
  let stat;
  try{stat=await fsp.lstat(candidate);}catch(e){if(e.code==='ENOENT')return false;throw e;}
  if(stat.isSymbolicLink())throw new Error(`检测到不安全的符号链接项目目录：${candidate}`);
  const realRoot=(await workspaceInfo(root)).realRoot,realCandidate=await fsp.realpath(candidate);
  if(!insideRealRoot(realRoot,realCandidate))throw new Error(`项目路径越出工作区：${candidate}`);
  return true;
}

export async function uniqueProjectFolder({appRoot,config,projects,name,businessId=null,excludeProjectId=null}){
  const base=newProjectFolder(name),used=new Set(projects.filter(p=>p.id!==excludeProjectId&&p.folder).map(p=>p.folder));
  for(let index=1;index<10000;index++){
    const suffix=index===1?'':`-${index}`;
    const candidate=`${base.slice(0,Math.max(1,80-suffix.length))}${suffix}`;
    if(used.has(candidate))continue;
    if(businessId&&await projectFolderExists(appRoot,config,businessId,candidate))continue;
    return candidate;
  }
  throw new Error('无法为项目分配唯一目录。');
}

export async function walkProjectFiles(dir,options={}){
  const configured=projectScanBudget({});
  const budget={
    maxFiles:boundedInteger(options.maxFiles,configured.maxFiles,{max:SCAN_CAPS.maxFiles}),
    maxDirectories:boundedInteger(options.maxDirectories,configured.maxDirectories,{max:SCAN_CAPS.maxDirectories}),
    maxDepth:boundedInteger(options.maxDepth,configured.maxDepth,{max:SCAN_CAPS.maxDepth}),
    maxDurationMs:boundedInteger(options.maxDurationMs,configured.maxDurationMs,{max:SCAN_CAPS.maxDurationMs})
  };
  const now=typeof options.now==='function'?options.now:Date.now;
  const startedAt=now(),files=[],reasons=new Set();let directoriesVisited=0,maxDepthVisited=0,stop=false;
  const elapsed=()=>Math.max(0,now()-startedAt);
  function checkDuration(){if(elapsed()>=budget.maxDurationMs){reasons.add('max_duration');stop=true;return true;}return false;}
  async function visit(current,rel='',depth=0){
    if(stop||checkDuration())return;
    if(directoriesVisited>=budget.maxDirectories){reasons.add('max_directories');stop=true;return;}
    directoriesVisited+=1;maxDepthVisited=Math.max(maxDepthVisited,depth);
    let entries=[];try{entries=await fsp.readdir(current,{withFileTypes:true});}catch{return;}
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
      if(stop||checkDuration())return;
      if(IGNORED.has(entry.name))continue;
      const abs=path.join(current,entry.name),relative=path.join(rel,entry.name);
      if(entry.isDirectory()){
        if(depth>=budget.maxDepth){reasons.add('max_depth');continue;}
        await visit(abs,relative,depth+1);
      }else if(entry.isFile()){
        if(files.length>=budget.maxFiles){reasons.add('max_files');stop=true;return;}
        try{const stat=await fsp.stat(abs);files.push({path:relative,size:stat.size,mtime:stat.mtime.toISOString()});}catch{}
      }
    }
  }
  await visit(dir);
  return{files,scan:{complete:reasons.size===0,reasons:[...reasons],directoriesVisited,maxDepthVisited,durationMs:elapsed(),budget}};
}

async function readSmall(file,max=10000){
  try{
    const st=await fsp.lstat(file);if(st.isSymbolicLink()||!st.isFile())return '';
    const fd=await fsp.open(file,fsConstants.O_RDONLY|NO_FOLLOW);try{const opened=await fd.stat();const buf=Buffer.alloc(Math.min(opened.size,max));await fd.read(buf,0,buf.length,0);return buf.toString('utf8');}finally{await fd.close();}
  }catch{return '';}
}

export function sanitizeGitRemote(value){
  const raw=String(value||'').trim();
  if(!raw||/[\u0000-\u001f\u007f\s]/.test(raw))return '';
  if(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//i.test(raw)){
    try{
      const remote=new URL(raw);
      remote.username='';
      remote.password='';
      remote.search='';
      remote.hash='';
      return remote.toString();
    }catch{return '';}
  }
  if(/[?#]/.test(raw))return '';
  const scpLike=raw.match(/^(?:[^@\s]+@)?([^:@\s]+):(.+)$/);
  if(scpLike){
    const [,host,repositoryPath]=scpLike;
    if(!repositoryPath||/[?#]/.test(repositoryPath))return '';
    return `${host}:${repositoryPath}`;
  }
  if(/[@?#]/.test(raw))return '';
  return raw;
}

export async function readGitAuthority(dir){
  if(!dir)return {head:null,remote:'',dirty:false};
  try{
    const gitDir=await fsp.lstat(path.join(dir,'.git'));
    if(!gitDir.isDirectory()&&!gitDir.isFile())return {head:null,remote:'',dirty:false};
  }catch{
    return {head:null,remote:'',dirty:false};
  }
  const git=await gitInfo(dir);
  return {
    head:git.commits[0]?.hash||null,
    remote:git.remote||'',
    dirty:!!git.dirty
  };
}

async function gitInfo(dir){
  try{
    const prefix=['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.pager=cat','-C',dir];
    const options={
      env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},
      timeout:3000
    };
    const [log,remote,status]=await Promise.all([
      execFileAsync('git',[...prefix,'log','-12','--pretty=format:%h|%cI|%s'],options).catch(()=>({stdout:''})),
      execFileAsync('git',[...prefix,'remote','get-url','origin'],options).catch(()=>({stdout:''})),
      execFileAsync('git',[...prefix,'status','--porcelain'],options).catch(()=>({stdout:''}))
    ]);
    const commits=String(log.stdout||'').trim().split('\n').filter(Boolean).map(line=>{const [hash,date,...subject]=line.split('|');return{hash,date,subject:subject.join('|')};});
    const gitRemote=sanitizeGitRemote(remote.stdout);
    return {isRepo:!!commits.length||!!gitRemote,commits,remote:gitRemote,dirty:!!String(status.stdout||'').trim()};
  }catch{return{isRepo:false,commits:[],remote:'',dirty:false};}
}

function fallbackProgress(project,files,git,exists){
  const work=files.filter(f=>f.path!=='PROJECT.md');
  const lastMs=Math.max(0,...work.map(f=>Date.parse(f.mtime)||0),...git.commits.map(c=>Date.parse(c.date)||0));
  const lastActivity=lastMs?new Date(lastMs).toISOString():null;
  if(!exists)return{percent:0,status:'未启动',summary:'项目目录不存在或不可访问。',resume:'项目目录当前不可访问。',blocker:'项目目录不可访问。',lastActivity,confidence:.2};
  if(project.completed)return{percent:100,status:'已完成',summary:'项目已标记完成。',resume:'项目已完成。',blocker:'暂无明确卡点。',lastActivity,confidence:1};
  if(!work.length&&!git.commits.length)return{percent:0,status:'未启动',summary:'项目已建立，但还没有真实工作痕迹。',resume:'尚未检测到创建、修改、保存或 Git 提交等工作痕迹。',blocker:'暂无明确卡点。',lastActivity,confidence:.9};
  const raw=work.filter(f=>f.path.startsWith('01_原始资料')).length;
  const process=work.filter(f=>f.path.startsWith('02_工作过程')).length;
  const deliver=work.filter(f=>f.path.startsWith('03_最终交付')).length;
  let percent=18;if(raw)percent=Math.max(percent,28);if(process)percent=Math.max(percent,45+Math.min(25,process*4));if(deliver)percent=Math.max(percent,82+Math.min(14,deliver*3));if(git.commits.length>=3)percent=Math.min(95,percent+4);
  const delta=dueDeltaDays(project.endDate);let blocker='暂无明确卡点。';
  if(delta<0)blocker=`项目已超过计划结束日期 ${Math.abs(delta)} 天。`;
  else if(delta<=2&&percent<80)blocker=`距离计划结束只剩 ${delta} 天，存在延期风险。`;
  else if(lastActivity&&Date.now()-Date.parse(lastActivity)>7*86400000)blocker='最近 7 天没有检测到项目活动。';
  const bits=[];if(raw)bits.push(`原始资料 ${raw} 项`);if(process)bits.push(`工作过程 ${process} 项`);if(deliver)bits.push(`最终交付 ${deliver} 项`);if(git.commits.length)bits.push(`Git 提交 ${git.commits.length} 条`);
  const latest=work.slice().sort((a,b)=>b.mtime.localeCompare(a.mtime))[0];
  const summary=`${bits.join('，')||`已有 ${work.length} 个工作文件`}；项目正在推进。`;
  return{percent:clamp(percent,0,99),status:'进行中',summary,resume:latest?`上次主要工作痕迹在「${latest.path}」。${summary}${blocker!=='暂无明确卡点。'?` 当前卡点：${blocker}`:''}`:summary,blocker,lastActivity,confidence:.68};
}

export async function analyzeProject(appRoot,config,project){
  const dir=projectPath(appRoot,config,project);let exists=false;
  if(dir){
    const biz=businessById(config,project.businessId);
    const checked=await safeDirectory(resolveWorkspace(appRoot,config),[biz.folder,project.folder],{create:false});
    exists=checked.exists;
  }
  const walked=exists?await walkProjectFiles(dir,projectScanBudget()):{files:[],scan:{complete:true,reasons:[],directoriesVisited:0,maxDepthVisited:0,durationMs:0,budget:projectScanBudget()}};
  const files=walked.files.sort((a,b)=>b.mtime.localeCompare(a.mtime));
  const projectMd=exists?(await readProjectMd(path.join(dir,'PROJECT.md'))).content.slice(0,12000):'';
  const git=exists?await gitInfo(dir):{isRepo:false,commits:[],remote:'',dirty:false};
  const fallback=fallbackProgress(project,files,git,exists);
  const snippets=[];
  for(const f of files.slice(0,12)){
    if(!TEXT_EXT.has(path.extname(f.path).toLowerCase()))continue;
    const content=await readSmall(path.join(dir,f.path),3000); if(content)snippets.push(`--- ${f.path} ---\n${content}`);
    if(snippets.length>=5)break;
  }
  const ai=await analyzeProjectWithAI({project,projectMd,files,git,snippets,fallback});
  const chosen=ai||fallback;
  const progress={...fallback,...chosen,percent:clamp(Math.round(chosen.percent??fallback.percent),0,project.completed?100:99),lastActivity:fallback.lastActivity,syncedAt:nowIso(),confidence:chosen.confidence??fallback.confidence};
  if(!project.completed&&progress.status==='已完成')progress.status=progress.lastActivity?'进行中':'未启动';
  if(!walked.scan.complete){
    progress.confidence=Math.min(.35,progress.confidence??.35);
    progress.summary=`${progress.summary}（目录扫描达到安全预算，仅依据部分证据）`;
    progress.blocker=progress.blocker&&progress.blocker!=='暂无明确卡点。'?`${progress.blocker}；目录扫描未完成，需要确认进度。`:'目录扫描达到安全预算，需要确认进度。';
  }
  if(project.completed){progress.percent=100;progress.status='已完成';}
  return {progress,gitRemote:git.remote||project.git||'',filesCount:files.length,dir,scan:walked.scan};
}

export function defaultProjectName(description){
  return compactText(String(description).split(/[。；;\n]/)[0].replace(/^(我要|需要|帮我|项目[:：]?)/,''),28)||'新项目';
}
export function newProjectFolder(name){ return sanitizeFolderName(name); }
export { SCAN_DEFAULTS,SCAN_CAPS };
