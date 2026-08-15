import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const GETNOTE_INSIGHT_SCHEMA_VERSION='getnote-insight-v1';
export const GETNOTE_INSIGHT_INDEX_VERSION='getnote-insight-index-v1';
export const GETNOTE_CANDIDATE_STORE_VERSION='getnote-candidates-v1';

const DIRECTORY_MODE=0o700;
const FILE_MODE=0o600;
const CONTENT_HASH=/^sha256:[a-f0-9]{64}$/;
const HUMAN_STATES=new Set(['pending','accepted','rejected','merged']);
const STORED_STATES=new Set([...HUMAN_STATES,'stale']);
const RESOLUTION_TYPES=new Set(['todo','inbox','existing_todo']);

export class GetnoteInsightError extends Error{
  constructor(message,{code='INVALID_GETNOTE_INSIGHT',statusCode=400,cause}={}){
    super(message,{cause});
    this.name='GetnoteInsightError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function fail(message,code='INVALID_GETNOTE_INSIGHT',statusCode=400){throw new GetnoteInsightError(message,{code,statusCode});}
function plainObject(value,label){if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} 必须是对象。`);return value;}
function knownKeys(value,allowed,label){const unknown=Object.keys(value).find(key=>!allowed.has(key));if(unknown)fail(`${label} 包含不支持的字段：${unknown}。`);}
function text(value,label,{max=2000,optional=false}={}){
  if(value===undefined||value===null){if(optional)return null;fail(`${label} 不能为空。`);}
  const next=String(value).trim();
  if(!next){if(optional)return null;fail(`${label} 不能为空。`);}
  if(next.length>max)fail(`${label} 不能超过 ${max} 个字符。`);
  return next;
}
function confidence(value,label){const number=Number(value);if(!Number.isFinite(number)||number<0||number>1)fail(`${label} 必须是 0 到 1 之间的数字。`);return number;}
function array(value,label,{max=200}={}){if(value===undefined)return[];if(!Array.isArray(value))fail(`${label} 必须是数组。`);if(value.length>max)fail(`${label} 数量不能超过 ${max}。`);return value;}
function uniqueStrings(value,label,{required=false,max=100}={}){
  const items=array(value,label,{max}).map((item,index)=>text(item,`${label}[${index}]`,{max:128}));
  const result=[...new Set(items)];
  if(required&&!result.length)fail(`${label} 至少需要一条 evidence。`);
  return result;
}
function normalizeWhitespace(value){return String(value??'').replace(/\s+/g,' ').trim();}
function digest(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function canonicalEvidenceIds(ids){return [...new Set(ids.map(String))].sort();}
function dateOnly(value,label){
  if(value===undefined||value===null||value==='')return null;
  const raw=String(value).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))fail(`${label} 必须是 YYYY-MM-DD 或 null。`);
  const date=new Date(`${raw}T00:00:00.000Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==raw)fail(`${label} 不是有效日期。`);
  return raw;
}
function optionalUrl(value,label){
  const raw=text(value,label,{max:2000,optional:true});
  if(!raw)return'';
  let url;
  try{url=new URL(raw);}catch{fail(`${label} 不是有效 URL。`);}
  if(!['http:','https:'].includes(url.protocol))fail(`${label} 只允许 http/https URL。`);
  return url.toString();
}
function normalizeContentHash(value){const raw=String(value??'').trim().toLowerCase();if(!CONTENT_HASH.test(raw))fail('source.contentHash 必须是 sha256:<64 hex>。');return raw;}

export function getnoteContentHash(content){return `sha256:${digest(String(content??''))}`;}

export function evidenceIdFor({noteId,excerpt,speaker=null}={}){
  const note=text(noteId,'noteId',{max:256});
  const quote=text(excerpt,'evidence excerpt',{max:2000});
  const who=speaker===undefined||speaker===null?'':String(speaker).trim();
  return `ev_${digest(`${note}\0${normalizeWhitespace(quote)}\0${normalizeWhitespace(who)}`).slice(0,24)}`;
}

export function candidateKeyFor({noteId,kind='action',evidenceIds=[]}={}){
  const note=text(noteId,'noteId',{max:256});
  const type=text(kind,'candidate kind',{max:40});
  const evidence=canonicalEvidenceIds(uniqueStrings(evidenceIds,'candidate evidenceIds',{required:true}));
  return `cand_${digest(`${note}\0${type}\0${evidence.join('\0')}`).slice(0,32)}`;
}

export function insightCacheKeyFor({noteId,contentHash,parserVersion,modelProfile}={}){
  const note=text(noteId,'noteId',{max:256});
  const hash=normalizeContentHash(contentHash);
  const version=text(parserVersion,'parserVersion',{max:100});
  const profile=text(modelProfile,'modelProfile',{max:200});
  return `gni_${digest(JSON.stringify([note,hash,version,profile])).slice(0,40)}`;
}

function normalizeNote(value){
  const note=plainObject(value,'note');
  knownKeys(note,new Set(['noteId','title','createdAt','updatedAt','noteUrl']),'note');
  return{
    noteId:text(note.noteId,'note.noteId',{max:256}),
    title:text(note.title,'note.title',{max:500}),
    createdAt:text(note.createdAt,'note.createdAt',{max:100,optional:true}),
    updatedAt:text(note.updatedAt,'note.updatedAt',{max:100,optional:true}),
    noteUrl:optionalUrl(note.noteUrl,'note.noteUrl')
  };
}
function normalizeSource(value){
  const source=plainObject(value,'source');
  knownKeys(source,new Set(['contentHash','language']),'source');
  return{contentHash:normalizeContentHash(source.contentHash),language:text(source.language??'zh-CN','source.language',{max:40})};
}
function normalizeParser(value){
  const parser=plainObject(value,'parser');
  knownKeys(parser,new Set(['version','modelProfile','parsedAt']),'parser');
  return{version:text(parser.version,'parser.version',{max:100}),modelProfile:text(parser.modelProfile,'parser.modelProfile',{max:200}),parsedAt:text(parser.parsedAt,'parser.parsedAt',{max:100})};
}
function normalizeEvidence(items,noteId){
  const result=[];const ids=new Set();
  for(const [index,raw] of array(items,'evidence',{max:200}).entries()){
    const item=plainObject(raw,`evidence[${index}]`);
    knownKeys(item,new Set(['id','excerpt','speaker']),`evidence[${index}]`);
    const excerpt=text(item.excerpt,`evidence[${index}].excerpt`,{max:2000});
    const speaker=text(item.speaker,`evidence[${index}].speaker`,{max:200,optional:true});
    const id=evidenceIdFor({noteId,excerpt,speaker});
    if(item.id!==undefined&&String(item.id)!==id)fail(`evidence[${index}].id 与确定性证据 ID 不一致。`);
    if(ids.has(id))continue;
    ids.add(id);result.push({id,excerpt,speaker});
  }
  return result;
}
function evidenceRefs(value,label,evidenceSet,{required=true}={}){
  const ids=uniqueStrings(value,label,{required,max:100});
  for(const id of ids)if(!evidenceSet.has(id))fail(`${label} 引用了不存在的 evidence：${id}。`);
  return ids;
}
function normalizeSummary(value,evidenceSet){
  const summary=plainObject(value,'summary');
  knownKeys(summary,new Set(['text','confidence','evidenceIds']),'summary');
  return{text:text(summary.text,'summary.text',{max:5000}),confidence:confidence(summary.confidence,'summary.confidence'),evidenceIds:evidenceRefs(summary.evidenceIds,'summary.evidenceIds',evidenceSet)};
}
function normalizeTopics(items){
  return array(items,'topics',{max:50}).map((raw,index)=>{
    const item=plainObject(raw,`topics[${index}]`);knownKeys(item,new Set(['text','confidence']),`topics[${index}]`);
    return{text:text(item.text,`topics[${index}].text`,{max:300}),confidence:confidence(item.confidence,`topics[${index}].confidence`)};
  });
}
function normalizeDecisions(items,evidenceSet){
  return array(items,'decisions',{max:100}).map((raw,index)=>{
    const item=plainObject(raw,`decisions[${index}]`);knownKeys(item,new Set(['text','status','confidence','evidenceIds']),`decisions[${index}]`);
    const status=text(item.status,`decisions[${index}].status`,{max:20});
    if(!['confirmed','tentative'].includes(status))fail(`decisions[${index}].status 只能是 confirmed 或 tentative。`);
    return{text:text(item.text,`decisions[${index}].text`,{max:1000}),status,confidence:confidence(item.confidence,`decisions[${index}].confidence`),evidenceIds:evidenceRefs(item.evidenceIds,`decisions[${index}].evidenceIds`,evidenceSet)};
  });
}
function normalizeActions(items,noteId,evidenceSet){
  const seen=new Set();
  return array(items,'actionCandidates',{max:100}).map((raw,index)=>{
    const item=plainObject(raw,`actionCandidates[${index}]`);
    knownKeys(item,new Set(['text','ownerHint','dueHint','explicitDueDate','confidence','evidenceIds']),`actionCandidates[${index}]`);
    const evidenceIds=evidenceRefs(item.evidenceIds,`actionCandidates[${index}].evidenceIds`,evidenceSet);
    const candidateKey=candidateKeyFor({noteId,kind:'action',evidenceIds});
    if(seen.has(candidateKey))fail(`actionCandidates[${index}] 与另一候选使用了同一组 evidence；v1 要求拆分证据。`);
    seen.add(candidateKey);
    return{
      candidateKey,
      text:text(item.text,`actionCandidates[${index}].text`,{max:1000}),
      ownerHint:text(item.ownerHint,`actionCandidates[${index}].ownerHint`,{max:200,optional:true}),
      dueHint:text(item.dueHint,`actionCandidates[${index}].dueHint`,{max:300,optional:true}),
      explicitDueDate:dateOnly(item.explicitDueDate,`actionCandidates[${index}].explicitDueDate`),
      confidence:confidence(item.confidence,`actionCandidates[${index}].confidence`),
      evidenceIds
    };
  });
}
function normalizeRisks(items,evidenceSet){
  return array(items,'risks',{max:100}).map((raw,index)=>{
    const item=plainObject(raw,`risks[${index}]`);knownKeys(item,new Set(['text','severity','confidence','evidenceIds']),`risks[${index}]`);
    const severity=text(item.severity,`risks[${index}].severity`,{max:20});
    if(!['low','medium','high','critical'].includes(severity))fail(`risks[${index}].severity 无效。`);
    return{text:text(item.text,`risks[${index}].text`,{max:1000}),severity,confidence:confidence(item.confidence,`risks[${index}].confidence`),evidenceIds:evidenceRefs(item.evidenceIds,`risks[${index}].evidenceIds`,evidenceSet)};
  });
}
function normalizeQuestions(items,evidenceSet){
  return array(items,'openQuestions',{max:100}).map((raw,index)=>{
    const item=plainObject(raw,`openQuestions[${index}]`);knownKeys(item,new Set(['text','confidence','evidenceIds']),`openQuestions[${index}]`);
    return{text:text(item.text,`openQuestions[${index}].text`,{max:1000}),confidence:confidence(item.confidence,`openQuestions[${index}].confidence`),evidenceIds:evidenceRefs(item.evidenceIds,`openQuestions[${index}].evidenceIds`,evidenceSet)};
  });
}
function normalizeProjects(items,evidenceSet){
  return array(items,'projectCandidates',{max:50}).map((raw,index)=>{
    const item=plainObject(raw,`projectCandidates[${index}]`);knownKeys(item,new Set(['name','confidence','evidenceIds']),`projectCandidates[${index}]`);
    return{name:text(item.name,`projectCandidates[${index}].name`,{max:300}),confidence:confidence(item.confidence,`projectCandidates[${index}].confidence`),evidenceIds:evidenceRefs(item.evidenceIds,`projectCandidates[${index}].evidenceIds`,evidenceSet)};
  });
}
function normalizeQuality(value){
  const quality=plainObject(value,'quality');knownKeys(quality,new Set(['overallConfidence','warnings']),'quality');
  return{overallConfidence:confidence(quality.overallConfidence,'quality.overallConfidence'),warnings:array(quality.warnings,'quality.warnings',{max:50}).map((item,index)=>text(item,`quality.warnings[${index}]`,{max:500}))};
}

export function normalizeGetnoteInsight(value){
  const input=plainObject(value,'GetNoteInsightV1');
  knownKeys(input,new Set(['schemaVersion','note','source','parser','summary','topics','decisions','actionCandidates','risks','openQuestions','projectCandidates','evidence','quality']),'GetNoteInsightV1');
  if(input.schemaVersion!==GETNOTE_INSIGHT_SCHEMA_VERSION)fail(`schemaVersion 必须是 ${GETNOTE_INSIGHT_SCHEMA_VERSION}。`);
  const note=normalizeNote(input.note);
  const evidence=normalizeEvidence(input.evidence,note.noteId);
  const evidenceSet=new Set(evidence.map(item=>item.id));
  return{
    schemaVersion:GETNOTE_INSIGHT_SCHEMA_VERSION,
    note,
    source:normalizeSource(input.source),
    parser:normalizeParser(input.parser),
    summary:normalizeSummary(input.summary,evidenceSet),
    topics:normalizeTopics(input.topics),
    decisions:normalizeDecisions(input.decisions,evidenceSet),
    actionCandidates:normalizeActions(input.actionCandidates,note.noteId,evidenceSet),
    risks:normalizeRisks(input.risks,evidenceSet),
    openQuestions:normalizeQuestions(input.openQuestions,evidenceSet),
    projectCandidates:normalizeProjects(input.projectCandidates,evidenceSet),
    evidence,
    quality:normalizeQuality(input.quality)
  };
}

function parserShape(insight){
  return{
    schemaVersion:insight.schemaVersion,
    note:{...insight.note},source:{...insight.source},parser:{...insight.parser},summary:{...insight.summary,evidenceIds:[...insight.summary.evidenceIds]},
    topics:insight.topics.map(item=>({...item})),decisions:insight.decisions.map(item=>({...item,evidenceIds:[...item.evidenceIds]})),
    actionCandidates:insight.actionCandidates.map(({candidateKey,...item})=>({...item,evidenceIds:[...item.evidenceIds]})),
    risks:insight.risks.map(item=>({...item,evidenceIds:[...item.evidenceIds]})),openQuestions:insight.openQuestions.map(item=>({...item,evidenceIds:[...item.evidenceIds]})),
    projectCandidates:insight.projectCandidates.map(item=>({...item,evidenceIds:[...item.evidenceIds]})),evidence:insight.evidence.map(item=>({...item})),
    quality:{overallConfidence:insight.quality.overallConfidence,warnings:[...insight.quality.warnings]}
  };
}
function emptyIndex(){return{schemaVersion:GETNOTE_INSIGHT_INDEX_VERSION,entries:{},latestByNote:{}};}
function emptyCandidates(){return{schemaVersion:GETNOTE_CANDIDATE_STORE_VERSION,items:{}};}
function sameJson(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function nowIso(){return new Date().toISOString();}

export class GetnoteInsightStore{
  constructor(dataDir){
    this.dataDir=path.resolve(String(dataDir));this.root=path.join(this.dataDir,'getnote');this.insightDir=path.join(this.root,'insights');
    this.indexFile=path.join(this.root,'index.json');this.candidateFile=path.join(this.root,'candidates.json');this._queue=Promise.resolve();
  }
  _unsafe(label,message='不能是符号链接'){return new GetnoteInsightError(`不安全的 GetNote 存储路径：${label}${message}`,{code:'UNSAFE_GETNOTE_INSIGHT_PATH',statusCode:500});}
  async _stat(target,label,type=null){
    let stat;try{stat=await fsp.lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink())throw this._unsafe(label);
    if(type==='directory'&&!stat.isDirectory())throw this._unsafe(label,'必须是目录');
    if(type==='file'&&!stat.isFile())throw this._unsafe(label,'必须是普通文件');
    return stat;
  }
  async _ensureDirectory(target,label){const existing=await this._stat(target,label,'directory');if(!existing)await fsp.mkdir(target,{recursive:true,mode:DIRECTORY_MODE});await this._stat(target,label,'directory');await fsp.chmod(target,DIRECTORY_MODE);}
  async _ensureJsonFile(target,label,initial){
    const existing=await this._stat(target,label,'file');
    if(!existing){try{await fsp.writeFile(target,JSON.stringify(initial,null,2),{encoding:'utf8',flag:'wx',mode:FILE_MODE});}catch(error){if(error.code!=='EEXIST')throw error;}}
    await this._stat(target,label,'file');await fsp.chmod(target,FILE_MODE);
  }
  async ensure(){await this._ensureDirectory(this.dataDir,'DATA_DIR');await this._ensureDirectory(this.root,'getnote');await this._ensureDirectory(this.insightDir,'getnote/insights');await this._ensureJsonFile(this.indexFile,'getnote/index.json',emptyIndex());await this._ensureJsonFile(this.candidateFile,'getnote/candidates.json',emptyCandidates());}
  async _readJson(target,label){
    await this.ensure();await this._stat(target,label,'file');
    try{return JSON.parse(await fsp.readFile(target,'utf8'));}catch(error){throw new GetnoteInsightError(`${label} 无法读取为 JSON。`,{code:'GETNOTE_INSIGHT_STORE_CORRUPT',statusCode:500,cause:error});}
  }
  async _atomicWrite(target,label,value){
    await this.ensure();await this._stat(target,label,'file');const tmp=`${target}.${process.pid}.${crypto.randomUUID()}.tmp`;let created=false;
    try{await fsp.writeFile(tmp,JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx',mode:FILE_MODE});created=true;await fsp.chmod(tmp,FILE_MODE);await this._stat(target,label,'file');await fsp.rename(tmp,target);created=false;}
    catch(error){if(created)await fsp.unlink(tmp).catch(()=>{});throw error;}
  }
  async _writeImmutable(target,label,value){
    await this.ensure();if(await this._stat(target,label,'file'))return false;
    try{await fsp.writeFile(target,JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx',mode:FILE_MODE});await fsp.chmod(target,FILE_MODE);return true;}catch(error){if(error.code==='EEXIST')return false;throw error;}
  }
  _enqueue(fn){const run=this._queue.then(fn,fn);this._queue=run.then(()=>undefined,()=>undefined);return run;}
  _validateIndex(index){if(!index||index.schemaVersion!==GETNOTE_INSIGHT_INDEX_VERSION||!index.entries||!index.latestByNote)throw new GetnoteInsightError('GetNote insight index 格式无效。',{code:'GETNOTE_INSIGHT_STORE_CORRUPT',statusCode:500});return index;}
  _validateCandidates(store){
    if(!store||store.schemaVersion!==GETNOTE_CANDIDATE_STORE_VERSION||!store.items||typeof store.items!=='object'||Array.isArray(store.items))throw new GetnoteInsightError('GetNote candidate store 格式无效。',{code:'GETNOTE_INSIGHT_STORE_CORRUPT',statusCode:500});
    for(const item of Object.values(store.items))if(!STORED_STATES.has(item?.state))throw new GetnoteInsightError('GetNote candidate state 无效。',{code:'GETNOTE_INSIGHT_STORE_CORRUPT',statusCode:500});
    return store;
  }
  _filename(cacheKey){return `${cacheKey}.json`;}
  _safeInsightFile(filename){const raw=String(filename||'');if(path.basename(raw)!==raw||!/^gni_[a-f0-9]{40}\.json$/.test(raw))throw this._unsafe('insight file','文件名无效');return path.join(this.insightDir,raw);}

  async findCachedInsight({noteId,contentHash,parserVersion,modelProfile}={}){
    const cacheKey=insightCacheKeyFor({noteId,contentHash,parserVersion,modelProfile});
    const index=this._validateIndex(await this._readJson(this.indexFile,'getnote/index.json'));const entry=index.entries[cacheKey];if(!entry)return null;
    const target=this._safeInsightFile(entry.file);if(!await this._stat(target,entry.file,'file'))throw new GetnoteInsightError('GetNote insight index 指向的缓存文件不存在。',{code:'GETNOTE_INSIGHT_STORE_CORRUPT',statusCode:500});
    return normalizeGetnoteInsight(JSON.parse(await fsp.readFile(target,'utf8')));
  }

  async putInsight(value){
    return this._enqueue(async()=>{
      const insight=normalizeGetnoteInsight(value);
      const cacheKey=insightCacheKeyFor({noteId:insight.note.noteId,contentHash:insight.source.contentHash,parserVersion:insight.parser.version,modelProfile:insight.parser.modelProfile});
      const filename=this._filename(cacheKey);const target=this._safeInsightFile(filename);await this.ensure();
      const persisted=parserShape(insight);const created=await this._writeImmutable(target,filename,persisted);const replayed=!created;
      if(!created){const existing=normalizeGetnoteInsight(JSON.parse(await fsp.readFile(target,'utf8')));if(!sameJson(existing,insight))throw new GetnoteInsightError('相同 GetNote cache tuple 已存在不同解析结果，拒绝静默覆盖。',{code:'GETNOTE_INSIGHT_CACHE_CONFLICT',statusCode:409});}
      const index=this._validateIndex(await this._readJson(this.indexFile,'getnote/index.json'));
      index.entries[cacheKey]={cacheKey,file:filename,noteId:insight.note.noteId,title:insight.note.title,contentHash:insight.source.contentHash,parserVersion:insight.parser.version,modelProfile:insight.parser.modelProfile,parsedAt:insight.parser.parsedAt};
      index.latestByNote[insight.note.noteId]=cacheKey;await this._atomicWrite(this.indexFile,'getnote/index.json',index);
      const candidates=await this._reconcileCandidates(insight);return{cacheKey,insight,replayed,candidates};
    });
  }

  _candidateSnapshot(insight,candidate){
    return{candidateKey:candidate.candidateKey,noteId:insight.note.noteId,noteTitle:insight.note.title,noteUrl:insight.note.noteUrl,sourceContentHash:insight.source.contentHash,parserVersion:insight.parser.version,modelProfile:insight.parser.modelProfile,text:candidate.text,ownerHint:candidate.ownerHint,dueHint:candidate.dueHint,explicitDueDate:candidate.explicitDueDate,confidence:candidate.confidence,evidenceIds:[...candidate.evidenceIds]};
  }
  async _reconcileCandidates(insight){
    const store=this._validateCandidates(await this._readJson(this.candidateFile,'getnote/candidates.json'));const timestamp=nowIso();const current=new Set();
    for(const candidate of insight.actionCandidates){
      const snapshot=this._candidateSnapshot(insight,candidate);current.add(candidate.candidateKey);const existing=store.items[candidate.candidateKey];
      if(existing){const wasStale=existing.state==='stale';Object.assign(existing,snapshot,{sourcePresent:true,lastSeenAt:timestamp});if(wasStale){existing.state='pending';existing.staleAt=null;}}
      else store.items[candidate.candidateKey]={...snapshot,state:'pending',sourcePresent:true,firstSeenAt:timestamp,lastSeenAt:timestamp,reviewedAt:null,staleAt:null,sourceChangedAt:null,resolution:null};
    }
    for(const item of Object.values(store.items)){
      if(item.noteId!==insight.note.noteId||current.has(item.candidateKey)||item.sourcePresent===false)continue;
      item.sourcePresent=false;if(item.state==='pending'){item.state='stale';item.staleAt=timestamp;}else item.sourceChangedAt=timestamp;
    }
    await this._atomicWrite(this.candidateFile,'getnote/candidates.json',store);
    return Object.values(store.items).filter(item=>item.noteId===insight.note.noteId).map(item=>structuredClone(item));
  }

  async listCandidates({states=null,noteId=null}={}){
    const store=this._validateCandidates(await this._readJson(this.candidateFile,'getnote/candidates.json'));const allowed=states===null?null:new Set(Array.isArray(states)?states:[states]);
    return Object.values(store.items).filter(item=>(!allowed||allowed.has(item.state))&&(!noteId||item.noteId===noteId)).sort((a,b)=>String(b.lastSeenAt||b.firstSeenAt).localeCompare(String(a.lastSeenAt||a.firstSeenAt))).map(item=>structuredClone(item));
  }
  _normalizeResolution(value,state){
    if(!['accepted','merged'].includes(state))return null;
    const resolution=plainObject(value,'candidate resolution');knownKeys(resolution,new Set(['type','id']),'candidate resolution');const type=text(resolution.type,'candidate resolution.type',{max:40});
    if(!RESOLUTION_TYPES.has(type))fail('candidate resolution.type 无效。','INVALID_GETNOTE_CANDIDATE_REVIEW');
    return{type,id:text(resolution.id,'candidate resolution.id',{max:256})};
  }
  async setCandidateReviewState(candidateKey,{expectedState,state,resolution=null}={}){
    return this._enqueue(async()=>{
      const key=text(candidateKey,'candidateKey',{max:80});const nextState=text(state,'candidate state',{max:20});const expected=text(expectedState,'candidate expectedState',{max:20});
      if(!HUMAN_STATES.has(nextState))fail('人工审核状态无效。','INVALID_GETNOTE_CANDIDATE_REVIEW');
      const store=this._validateCandidates(await this._readJson(this.candidateFile,'getnote/candidates.json'));const item=store.items[key];
      if(!item)throw new GetnoteInsightError('候选事项不存在。',{code:'GETNOTE_CANDIDATE_NOT_FOUND',statusCode:404});
      if(item.state!==expected)throw new GetnoteInsightError(`候选事项状态已变化：expected=${expected} actual=${item.state}。`,{code:'GETNOTE_CANDIDATE_CONFLICT',statusCode:409});
      const allowed=(expected==='pending'&&['accepted','rejected','merged'].includes(nextState))||(expected==='rejected'&&nextState==='pending'&&item.sourcePresent===true);
      if(!allowed)throw new GetnoteInsightError(`不允许候选状态从 ${expected} 变为 ${nextState}。`,{code:'GETNOTE_CANDIDATE_CONFLICT',statusCode:409});
      item.state=nextState;item.reviewedAt=nextState==='pending'?null:nowIso();item.resolution=this._normalizeResolution(resolution,nextState);
      await this._atomicWrite(this.candidateFile,'getnote/candidates.json',store);return structuredClone(item);
    });
  }
}
