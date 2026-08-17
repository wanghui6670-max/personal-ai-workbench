function projectSessionError(message,code,statusCode=400){
  return Object.assign(new Error(message),{code,statusCode});
}

function safeProjectId(value){
  const id=String(value??'').trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)){
    throw projectSessionError('projectId 格式无效。','PROJECT_SESSION_PROJECT_ID_INVALID');
  }
  return id;
}

function authorityRefs(project){
  const refs=[
    {authority:'workbench',kind:'project',refId:project.id},
    {authority:'local_workspace',kind:'project',refId:project.id},
    {authority:'git',kind:'project',refId:project.id}
  ];
  if(typeof project.feishu==='string'&&project.feishu.trim()){
    refs.push({authority:'feishu_project_record',kind:'project',refId:project.id});
  }
  return refs;
}

function cursorValue(value){return value===undefined||value===null||value===''?null:String(value);}

function projectCursor(project){
  const progress=project?.progress&&typeof project.progress==='object'?project.progress:{};
  return{
    lastActivity:cursorValue(progress.lastActivity),
    syncedAt:cursorValue(progress.syncedAt),
    feishuRevisionId:cursorValue(progress.feishuRevisionId),
    feishuRecordBlockId:cursorValue(progress.feishuRecordBlockId),
    feishuRecordedAt:cursorValue(progress.feishuRecordedAt),
    feishuOperationId:cursorValue(progress.feishuOperationId)
  };
}

export class ProjectSessionManager{
  constructor({workbenchStore,sessionStore,clock=()=>new Date().toISOString()}={}){
    if(!workbenchStore||typeof workbenchStore.readState!=='function')throw new TypeError('ProjectSessionManager requires workbenchStore.readState');
    if(!sessionStore||typeof sessionStore.upsert!=='function'||typeof sessionStore.update!=='function')throw new TypeError('ProjectSessionManager requires ProjectSessionStore');
    if(typeof clock!=='function')throw new TypeError('ProjectSessionManager clock must be callable');
    this.workbenchStore=workbenchStore;
    this.sessionStore=sessionStore;
    this.clock=clock;
  }

  async #project(projectId){
    const id=safeProjectId(projectId);
    const state=await this.workbenchStore.readState();
    const project=(Array.isArray(state?.projects)?state.projects:[]).find(candidate=>candidate?.id===id);
    if(!project)throw projectSessionError('项目不存在，不能创建脱离 Workbench 真相源的 Session。','PROJECT_SESSION_PROJECT_NOT_FOUND',404);
    return project;
  }

  async openProject(projectId){
    const project=await this.#project(projectId);
    const sessionId=`project:${project.id}`;
    const now=String(this.clock());
    const refs=authorityRefs(project);
    const cursor=projectCursor(project);
    return this.sessionStore.upsert(sessionId,current=>{
      if(current&&current.projectId!==project.id){
        throw projectSessionError('Project Session 与当前项目身份冲突。','PROJECT_SESSION_IDENTITY_CONFLICT',409);
      }
      return current?{
        ...current,
        authorityRefs:refs,
        cursor,
        updatedAt:now
      }:{
        version:1,
        id:sessionId,
        type:'project',
        projectId:project.id,
        status:'open',
        authorityRefs:refs,
        cursor,
        executionRefs:[],
        createdAt:now,
        updatedAt:now
      };
    });
  }

  async attachExecution(sessionId,executionId){
    const sid=String(sessionId??'').trim();
    const eid=String(executionId??'').trim();
    if(!sid||!eid)throw projectSessionError('sessionId 和 executionId 不能为空。','PROJECT_SESSION_REF_INVALID');
    const now=String(this.clock());
    return this.sessionStore.update(sid,current=>({
      ...current,
      executionRefs:[...current.executionRefs,eid],
      updatedAt:now
    }));
  }
}
