import crypto,{randomUUID} from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createGetnoteReader} from './getnote-runtime.mjs';
import {createGetnoteNoteClient} from './getnote-note-client.mjs';
import {parseNotesPage} from './task-cli.mjs';
import {ensureBusinessDirs,resolveWorkspace} from './projects.mjs';
import {addActivity} from './store.mjs';
import {newId,nowIso} from './utils.mjs';

const BUSINESS_NAME='自媒体';
const BUSINESS_ID='biz_media';
const CONTENT_FOLDER='得到大脑内容';
const MANIFEST_FILE='.getnote-content-index.json';
const DEFAULT_LIMIT=50;
const MAX_LIMIT=200;
const PRIVATE_DIR_MODE=0o700;
const PRIVATE_FILE_MODE=0o600;

export class GetnoteContentSyncError extends Error{
  constructor(message,{code='GETNOTE_CONTENT_SYNC_FAILED',statusCode=500,cause}={}){
    super(message,{cause});
    this.name='GetnoteContentSyncError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function fail(message,code='GETNOTE_CONTENT_SYNC_FAILED',statusCode=500,cause){
  throw new GetnoteContentSyncError(message,{code,statusCode,cause});
}
function normalizeLimit(value=DEFAULT_LIMIT){
  const number=Number(value??DEFAULT_LIMIT);
  if(!Number.isInteger(number)||number<1||number>MAX_LIMIT)fail(`得到大脑内容同步数量必须是 1-${MAX_LIMIT} 的整数。`,'INVALID_GETNOTE_CONTENT_LIMIT',400);
  return number;
}
function safeSlug(value){
  const text=String(value||'未命名')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\0\r\n]/g,'-')
    .replace(/\s+/g,'_')
    .replace(/_{2,}/g,'_')
    .replace(/^-+|-+$/g,'')
    .slice(0,64);
  return text||'未命名';
}
function noteHash(noteId){return crypto.createHash('sha256').update(String(noteId)).digest('hex').slice(0,12);}
function contentHash(content){return crypto.createHash('sha256').update(String(content||'')).digest('hex');}
function datePrefix(value){
  const match=String(value||'').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1]||'未标日期';
}
function nextBusinessFolder(config){
  let max=0;
  for(const business of config.businesses||[]){
    const match=String(business.folder||'').match(/^(\d+)_/);
    if(match)max=Math.max(max,Number(match[1]));
  }
  return `${String(max+1).padStart(2,'0')}_自媒体`;
}
async function ensureSelfMediaBusiness({appRoot,store}){
  let selected=null;
  await store.updateConfig(config=>{
    selected=(config.businesses||[]).find(business=>business.name===BUSINESS_NAME)||null;
    if(selected)return structuredClone(selected);
    const id=(config.businesses||[]).some(business=>business.id===BUSINESS_ID)?newId('biz'):BUSINESS_ID;
    selected={id,name:BUSINESS_NAME,folder:nextBusinessFolder(config)};
    config.businesses.push(selected);
    return structuredClone(selected);
  });
  const config=await store.readConfig();
  await ensureBusinessDirs(appRoot,config);
  return structuredClone(selected);
}
async function safeDirectory(target,label){
  let stat=null;
  try{stat=await fsp.lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat?.isSymbolicLink()||stat&&!stat.isDirectory())fail(`${label} 不是安全目录。`,'UNSAFE_GETNOTE_CONTENT_PATH',409);
  if(!stat)await fsp.mkdir(target,{recursive:true,mode:PRIVATE_DIR_MODE});
  const created=await fsp.lstat(target);
  if(created.isSymbolicLink()||!created.isDirectory())fail(`${label} 不是安全目录。`,'UNSAFE_GETNOTE_CONTENT_PATH',409);
  await fsp.chmod(target,PRIVATE_DIR_MODE).catch(()=>{});
}
async function safeReadJson(file){
  let stat;
  try{stat=await fsp.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(stat.isSymbolicLink()||!stat.isFile())fail('得到大脑内容索引不是安全普通文件。','UNSAFE_GETNOTE_CONTENT_PATH',409);
  if(stat.size>2*1024*1024)fail('得到大脑内容索引过大。','GETNOTE_CONTENT_INDEX_TOO_LARGE',409);
  try{return JSON.parse(await fsp.readFile(file,'utf8'));}
  catch(error){fail('得到大脑内容索引损坏，已拒绝覆盖。','GETNOTE_CONTENT_INDEX_INVALID',409,error);}
}
async function safeAtomicWrite(file,content){
  let stat=null;
  try{stat=await fsp.lstat(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat?.isSymbolicLink()||stat&&!stat.isFile())fail(`目标文件 ${path.basename(file)} 不是安全普通文件。`,'UNSAFE_GETNOTE_CONTENT_PATH',409);
  const tmp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  let created=false;
  try{
    await fsp.writeFile(tmp,content,{encoding:'utf8',flag:'wx',mode:PRIVATE_FILE_MODE});
    created=true;
    await fsp.chmod(tmp,PRIVATE_FILE_MODE).catch(()=>{});
    await fsp.rename(tmp,file);
    created=false;
  }finally{if(created)await fsp.unlink(tmp).catch(()=>{});}
}
function markdown(detail,syncedAt){
  const lines=[
    '---',
    `source: ${JSON.stringify('getnote')}`,
    `source_note_id: ${JSON.stringify(detail.noteId)}`,
    `title: ${JSON.stringify(detail.title)}`,
    `note_type: ${JSON.stringify(detail.noteType||'')}`,
    `created_at: ${JSON.stringify(detail.createdAt||'')}`,
    `updated_at: ${JSON.stringify(detail.updatedAt||'')}`,
    `source_url: ${JSON.stringify(detail.noteUrl||'')}`,
    `source_field: ${JSON.stringify(detail.sourceField||'')}`,
    `synced_at: ${JSON.stringify(syncedAt)}`,
    '---','',`# ${detail.title||'未命名笔记'}`,'',detail.content||'',''
  ];
  return lines.join('\n');
}
async function listRecentNotes(reader,limit){
  const notes=[];
  const cursors=new Set();
  let cursor=null;
  while(notes.length<limit){
    const payload=await reader.listNotes({limit:Math.min(20,limit-notes.length),cursor});
    const page=parseNotesPage(payload);
    notes.push(...page.notes);
    if(!page.hasMore||!page.cursor||cursors.has(page.cursor)||page.notes.length===0)break;
    cursors.add(page.cursor);cursor=page.cursor;
  }
  return notes.slice(0,limit);
}
function manifestNotes(value){return Array.isArray(value?.notes)?value.notes:[];}

export async function readGetnoteContentStatus({appRoot,store}={}){
  const config=await store.readConfig();
  const business=(config.businesses||[]).find(item=>item.name===BUSINESS_NAME)||null;
  if(!business)return{configured:false,business:null,directory:null,lastSyncAt:null,noteCount:0,errors:[]};
  const directory=path.join(resolveWorkspace(appRoot,config),business.folder,CONTENT_FOLDER);
  const manifest=await safeReadJson(path.join(directory,MANIFEST_FILE)).catch(error=>{
    if(error?.code==='ENOENT')return null;
    throw error;
  });
  return{
    configured:true,business,directory,
    lastSyncAt:manifest?.lastSyncAt||null,
    noteCount:manifestNotes(manifest).length,
    errors:Array.isArray(manifest?.errors)?manifest.errors.slice(0,20):[],
    notes:manifestNotes(manifest).slice(0,30).map(item=>({noteId:item.noteId,title:item.title,filename:item.filename,updatedAt:item.updatedAt||null,syncedAt:item.syncedAt||null}))
  };
}

export async function syncGetnoteContent({appRoot,store,limit=DEFAULT_LIMIT,reader=null,noteClient=null}={}){
  const bounded=normalizeLimit(limit);
  const business=await ensureSelfMediaBusiness({appRoot,store});
  const config=await store.readConfig();
  const workspace=resolveWorkspace(appRoot,config);
  const directory=path.join(workspace,business.folder,CONTENT_FOLDER);
  await safeDirectory(directory,'得到大脑内容目录');
  const manifestPath=path.join(directory,MANIFEST_FILE);
  const previous=await safeReadJson(manifestPath)||{version:1,notes:[],errors:[]};
  const previousById=new Map(manifestNotes(previous).map(item=>[String(item.noteId),item]));
  const runtime=reader||createGetnoteReader();
  const client=noteClient||createGetnoteNoteClient({reader:runtime});
  const notes=await listRecentNotes(runtime,bounded);
  const nextById=new Map(previousById);
  const errors=[];
  let created=0,updated=0,skipped=0;
  const syncedAt=nowIso();

  for(const note of notes){
    try{
      const detail=await client.fetch(note.noteId);
      const hash=contentHash(detail.content);
      const existing=previousById.get(String(detail.noteId));
      const filename=existing?.filename||`${datePrefix(detail.createdAt||detail.updatedAt)}_${safeSlug(detail.title)}_${noteHash(detail.noteId)}.md`;
      const target=path.join(directory,filename);
      const same=existing?.contentHash===hash&&existing?.updatedAt===(detail.updatedAt||null);
      if(same){
        let present=true;try{const stat=await fsp.lstat(target);present=stat.isFile()&&!stat.isSymbolicLink();}catch{present=false;}
        if(present){skipped+=1;nextById.set(String(detail.noteId),{...existing,syncedAt});continue;}
      }
      await safeAtomicWrite(target,markdown(detail,syncedAt));
      if(existing)updated+=1;else created+=1;
      nextById.set(String(detail.noteId),{
        noteId:String(detail.noteId),title:detail.title,filename,
        noteType:detail.noteType||'',createdAt:detail.createdAt||null,updatedAt:detail.updatedAt||null,
        sourceUrl:detail.noteUrl||'',sourceField:detail.sourceField||'',contentHash:hash,syncedAt
      });
    }catch(error){
      errors.push({noteId:String(note.noteId),title:note.title||'未命名笔记',code:error?.code||'GETNOTE_CONTENT_NOTE_FAILED',message:String(error?.message||'笔记读取失败').slice(0,240)});
    }
  }

  const manifest={
    version:1,source:'getnote',businessId:business.id,businessName:business.name,
    directory:CONTENT_FOLDER,lastSyncAt:syncedAt,requestedLimit:bounded,
    notes:[...nextById.values()].sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''))),
    errors:errors.slice(0,100)
  };
  await safeAtomicWrite(manifestPath,`${JSON.stringify(manifest,null,2)}\n`);
  await store.updateState(state=>{
    addActivity(state,{type:'getnote_content_synced',text:`自媒体得到大脑内容已同步到本地：新增 ${created}，更新 ${updated}，未变化 ${skipped}，读取失败 ${errors.length}。`});
  });
  return{
    ok:true,business,directory,limit:bounded,sourceCount:notes.length,
    created,updated,skipped,failed:errors.length,errors:errors.slice(0,20),lastSyncAt:syncedAt,
    noteCount:manifest.notes.length
  };
}
