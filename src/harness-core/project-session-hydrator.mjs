const SAFE_ERROR_CODE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeErrorCode(error,fallback){
  const code=typeof error?.code==='string'?error.code.trim():'';
  return SAFE_ERROR_CODE.test(code)?code:fallback;
}

function boundedText(value,max=4000){
  const text=String(value??'');
  return text.length<=max?text:`${text.slice(0,Math.max(0,max-1))}…`;
}

function optionalTime(value){
  if(value===undefined||value===null||value==='')return null;
  const text=String(value);
  return Number.isFinite(Date.parse(text))?text:null;
}

function optionalPointer(value,max=256){
  if(value===undefined||value===null||value==='')return null;
  const text=String(value).trim();
  if(!text||/[\r\n\0]/.test(text))return null;
  return boundedText(text,max);
}

function normalizeProject(project){
  return Object.freeze({
    id:String(project.id),
    name:boundedText(project.name,200),
    businessId:project.businessId?String(project.businessId):null,
    endDate:project.endDate?String(project.endDate):null,
    status:String(project.status||project.progress?.status||'未启动'),
    completed:project.completed===true,
    archived:project.archived===true
  });
}

function normalizeFiles(value){
  if(!Array.isArray(value))return[];
  return Object.freeze(value.slice(0,20).map(item=>Object.freeze({
    path:boundedText(item?.path,512),
    mtime:optionalTime(item?.mtime),
    size:Number.isFinite(Number(item?.size))?Math.max(0,Number(item.size)):0
  })));
}

function normalizeCommits(value){
  if(!Array.isArray(value))return[];
  return Object.freeze(value.slice(0,20).map(item=>Object.freeze({
    hash:optionalPointer(item?.hash,128),
    date:optionalTime(item?.date),
    subject:boundedText(item?.subject,300)
  })));
}

function normalizeWorkspace(raw){
  const status=raw?.status==='ok'?'ok':'unavailable';
  const gitStatus=['ok','not_repo','unavailable'].includes(raw?.git?.status)?raw.git.status:'unavailable';
  return Object.freeze({
    status,
    errorCode:status==='ok'?null:optionalPointer(raw?.errorCode,128),
    latestActivity:status==='ok'?optionalTime(raw?.latestActivity):null,
    fileCount:status==='ok'&&Number.isInteger(raw?.fileCount)&&raw.fileCount>=0?raw.fileCount:0,
    recentFiles:status==='ok'?normalizeFiles(raw?.recentFiles):Object.freeze([]),
    git:Object.freeze({
      status:gitStatus,
      errorCode:gitStatus==='unavailable'?optionalPointer(raw?.git?.errorCode,128):null,
      head:gitStatus==='ok'?optionalPointer(raw?.git?.head,256):null,
      dirty:gitStatus==='ok'?raw?.git?.dirty===true:false,
      recentCommits:gitStatus==='ok'?normalizeCommits(raw?.git?.recentCommits):Object.freeze([])
    })
  });
}

function unavailableWorkspace(error){
  const errorCode=safeErrorCode(error,'WORKSPACE_EVIDENCE_UNAVAILABLE');
  return Object.freeze({
    status:'unavailable',errorCode,latestActivity:null,fileCount:0,recentFiles:Object.freeze([]),
    git:Object.freeze({status:'unavailable',errorCode,head:null,dirty:false,recentCommits:Object.freeze([])})
  });
}

function normalizeRecords(value){
  if(!Array.isArray(value))return[];
  return Object.freeze(value.slice(-10).map(item=>Object.freeze({
    blockId:optionalPointer(item?.blockId,256),
    recordedAt:optionalTime(item?.recordedAt),
    operationId:optionalPointer(item?.operationId,256),
    text:boundedText(item?.text,4000)
  })));
}

function normalizeFeishu(raw){
  return Object.freeze({
    status:'ok',
    errorCode:null,
    revisionId:optionalPointer(raw?.revisionId,256),
    records:normalizeRecords(raw?.records)
  });
}

function unavailableFeishu(error){
  return Object.freeze({
    status:'unavailable',
    errorCode:safeErrorCode(error,'FEISHU_PROJECT_RECORD_UNAVAILABLE'),
    revisionId:null,
    records:Object.freeze([])
  });
}

function notConfiguredFeishu(){
  return Object.freeze({status:'not_configured',errorCode:null,revisionId:null,records:Object.freeze([])});
}

function changed(previous,current){
  if(previous===undefined||previous===null)return null;
  return previous!==current;
}

function currentProject(state,projectId){
  const project=(Array.isArray(state?.projects)?state.projects:[]).find(candidate=>candidate?.id===projectId);
  if(!project){
    throw Object.assign(new Error('项目已不在当前 Workbench 真相源中。'),{
      code:'PROJECT_SESSION_PROJECT_NOT_FOUND',statusCode:404
    });
  }
  return project;
}

export class ProjectSessionHydrator{
  constructor({workbenchStore,sessionManager,readWorkspaceEvidence,readFeishuRecords}={}){
    if(!workbenchStore||typeof workbenchStore.readState!=='function')throw new TypeError('ProjectSessionHydrator requires workbenchStore.readState');
    if(!sessionManager||typeof sessionManager.openProject!=='function'||typeof sessionManager.checkpoint!=='function'){
      throw new TypeError('ProjectSessionHydrator requires ProjectSessionManager');
    }
    if(typeof readWorkspaceEvidence!=='function'||typeof readFeishuRecords!=='function'){
      throw new TypeError('ProjectSessionHydrator requires Authority readers');
    }
    this.workbenchStore=workbenchStore;
    this.sessionManager=sessionManager;
    this.readWorkspaceEvidence=readWorkspaceEvidence;
    this.readFeishuRecords=readFeishuRecords;
  }

  async hydrateProject(projectId){
    const session=await this.sessionManager.openProject(projectId);
    const previousCursor=structuredClone(session.cursor);
    const state=await this.workbenchStore.readState();
    const project=currentProject(state,session.projectId);

    let workspace;
    try{workspace=normalizeWorkspace(await this.readWorkspaceEvidence({project,session}));}
    catch(error){workspace=unavailableWorkspace(error);}

    const hasFeishu=session.authorityRefs.some(ref=>ref.authority==='feishu_project_record');
    let feishu=notConfiguredFeishu();
    if(hasFeishu){
      try{feishu=normalizeFeishu(await this.readFeishuRecords({projectId:project.id,project,session}));}
      catch(error){feishu=unavailableFeishu(error);}
    }

    const workspaceChanged=workspace.status==='ok'
      ?changed(previousCursor.workspaceLastActivity,workspace.latestActivity)
      :null;
    const gitChanged=workspace.git.status==='ok'||workspace.git.status==='not_repo'
      ?changed(previousCursor.gitHead,workspace.git.head)
      :null;
    const feishuChanged=feishu.status==='ok'
      ?changed(previousCursor.feishuRevisionId,feishu.revisionId)
      :null;

    const cursorPatch={
      lastActivity:project.progress?.lastActivity??null,
      syncedAt:project.progress?.syncedAt??null
    };
    if(workspace.status==='ok')cursorPatch.workspaceLastActivity=workspace.latestActivity;
    if(workspace.git.status==='ok'||workspace.git.status==='not_repo')cursorPatch.gitHead=workspace.git.head;
    if(feishu.status==='ok'){
      const latest=feishu.records.at(-1)||null;
      cursorPatch.feishuRevisionId=feishu.revisionId;
      cursorPatch.feishuRecordBlockId=latest?.blockId??null;
      cursorPatch.feishuRecordedAt=latest?.recordedAt??null;
      cursorPatch.feishuOperationId=latest?.operationId??null;
    }

    const checkpointed=await this.sessionManager.checkpoint(session.id,cursorPatch);
    return Object.freeze({
      session:Object.freeze({
        id:session.id,
        projectId:session.projectId,
        previousCursor:Object.freeze(previousCursor),
        checkpointCursor:Object.freeze(structuredClone(checkpointed.cursor)),
        executionRefs:Object.freeze([...checkpointed.executionRefs])
      }),
      project:normalizeProject(project),
      authorities:Object.freeze({
        workspace:Object.freeze({
          status:workspace.status,
          errorCode:workspace.errorCode,
          latestActivity:workspace.latestActivity,
          fileCount:workspace.fileCount,
          recentFiles:workspace.recentFiles
        }),
        git:workspace.git,
        feishu
      }),
      changes:Object.freeze({workspace:workspaceChanged,git:gitChanged,feishu:feishuChanged})
    });
  }
}
