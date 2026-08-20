import { randomUUID } from 'node:crypto';

function nowIso(){
  return new Date().toISOString();
}

export function createSessionManager({store,projectLookup=null,execution=null,authorities=null}={}){
  if(!store)throw new Error('createSessionManager requires store');
  const lookup=projectLookup||(async()=>null);
  const readGit=authorities?.readGit||(async()=>null);
  const readFeishu=authorities?.readFeishu||(async()=>null);
  const openingProjects=new Map();

  async function open(input={}){
    if(input.type&&input.type!=='project'){
      throw Object.assign(new Error('P0 只支持 project session'),{code:'HARNESS_SESSION_TYPE_UNSUPPORTED'});
    }
    return openProject(input);
  }

  async function openProject({projectId,goal=''}={}){
    if(!projectId)throw new Error('openProject requires projectId');
    const existing=store.list().find(item=>item.type==='project'&&item.projectId===projectId);
    if(existing)return existing;
    if(openingProjects.has(projectId))return openingProjects.get(projectId);
    const opening=(async()=>{
      const current=store.list().find(item=>item.type==='project'&&item.projectId===projectId);
      if(current)return current;
      return store.create({
        id:`sess_${randomUUID().replaceAll('-','')}`,
        type:'project',
        projectId,
        goal:String(goal||''),
        checkpoint:null,
        workingMemory:{},
        contextRefs:[],
        decisionRefs:[],
        executionRefs:[],
        updatedAt:nowIso()
      });
    })();
    openingProjects.set(projectId,opening);
    try{
      return await opening;
    }finally{
      if(openingProjects.get(projectId)===opening)openingProjects.delete(projectId);
    }
  }

  async function checkpoint(sessionId,{note='',facts}={}){
    const session=store.get(sessionId);
    if(!session)throw Object.assign(new Error(`未知 session：${sessionId}`),{code:'HARNESS_SESSION_NOT_FOUND'});
    return store.update(sessionId,{
      checkpoint:{
        note:String(note||''),
        facts:facts&&typeof facts==='object'?facts:{}
      },
      updatedAt:nowIso()
    });
  }

  async function hydrate(sessionId){
    const session=store.get(sessionId);
    if(!session)throw Object.assign(new Error(`未知 session：${sessionId}`),{code:'HARNESS_SESSION_NOT_FOUND'});
    const project=await lookup(session.projectId);
    const liveGit=project?await readGit(project):null;
    const liveFeishu=project?await readFeishu(project):null;
    const executions=execution?.list?await execution.list({sessionRef:sessionId,limit:20}):[];
    const facts=session.checkpoint?.facts||{};
    const conflicts=[];
    if(facts.gitHead!=null&&liveGit?.head!=null&&facts.gitHead!==liveGit.head){
      conflicts.push({path:'gitHead',checkpoint:facts.gitHead,live:liveGit.head});
    }
    if(facts.feishuUrl!=null&&liveFeishu?.documentUrl!=null&&facts.feishuUrl!==liveFeishu.documentUrl){
      conflicts.push({path:'feishuUrl',checkpoint:facts.feishuUrl,live:liveFeishu.documentUrl});
    }
    return {
      session,
      project:project?{id:project.id,name:project.name,git:project.git||'',feishu:project.feishu||''}:null,
      live:{git:liveGit,feishu:liveFeishu,executions},
      checkpoint:session.checkpoint,
      conflicts,
      authority:'live'
    };
  }

  return Object.freeze({open,openProject,hydrate,checkpoint});
}
