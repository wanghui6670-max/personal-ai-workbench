import { deriveState } from '../domain.mjs';
import { projectRecordConfigured } from '../feishu.mjs';
import { compactText } from '../utils.mjs';
import { sanitizeGitRemote } from '../projects.mjs';

const nonEmptyString={type:'string',minLength:1};
const SEARCH_SNIPPET_MAX=160;

function descriptor({name,description,inputSchema,readOnly=false,requiresConfirmation=false,execute}){
  return Object.freeze({name,description,inputSchema,readOnly,requiresConfirmation,execute});
}

function notFound(message='项目不存在'){
  return Object.assign(new Error(message),{statusCode:404,code:'PROJECT_NOT_FOUND'});
}

function findProject(state,message){
  const text=String(message||'').replace(/\s/g,'').toLowerCase();
  const projects=Array.isArray(state?.projects)?state.projects:[];
  const exact=projects.filter(project=>text.includes(String(project.name||'').replace(/\s/g,'').toLowerCase()));
  if(exact.length===1)return exact[0];
  return null;
}

function extractSearchQuery(message,project){
  const name=String(project?.name||'').trim();
  let leftover=String(message||'');
  if(name)leftover=leftover.split(name).join(' ');
  leftover=leftover
    .replace(/搜索|检索|查找|知识检索|一下|请|帮我|项目|知识|的/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  return leftover;
}

function derivedProject(context,projectId){
  const derived=deriveState(context.appRoot,context.state,context.config,context.aiEnabled);
  const project=derived.projects.find(item=>item.id===projectId);
  if(!project)throw notFound();
  const todos=derived.todos.filter(todo=>todo.projectId===projectId);
  const notes=(derived.notes||[]).filter(note=>note.projectId===projectId);
  return {derived,project,todos,notes};
}

function overviewFrom(project,todos,notes){
  const open=todos.filter(todo=>!todo.done).length;
  const done=todos.filter(todo=>todo.done).length;
  const feishuBound=projectRecordConfigured(project);
  const documentUrl=feishuBound?String(project.feishu||'').trim():'';
  const gitRemote=sanitizeGitRemote(project.git);
  return {
    projectId:project.id,
    name:project.name,
    status:project.status||project.progress?.status||'未启动',
    progress:{
      percent:Number(project.progress?.percent||0),
      status:project.progress?.status||project.status||'未启动',
      hasBlocker:Boolean(project.progress?.hasBlocker)
    },
    todos:{open,done,total:todos.length},
    assets:{
      folder:Boolean(project.folder||project.absPath),
      gitConfigured:Boolean(gitRemote),
      feishuBound
    },
    git:{
      remote:gitRemote,
      configured:Boolean(gitRemote)
    },
    feishu:{
      bound:feishuBound,
      documentUrl
    },
    notes:{count:notes.length},
    constraints:{
      endDate:project.endDate||'',
      completed:Boolean(project.completed),
      archived:Boolean(project.archived)
    }
  };
}

function chapterCatalog(project,todos){
  const feishuBound=projectRecordConfigured(project);
  const gitRemote=sanitizeGitRemote(project.git);
  const open=todos.filter(todo=>!todo.done).length;
  const done=todos.filter(todo=>todo.done).length;
  const titles=todos.map(todo=>String(todo.title||'').trim()).filter(Boolean).join(' ');
  return [
    {
      chapter:'assets',
      haystack:[project.name,project.intro,project.folder,project.absPath,'资产盘点'].filter(Boolean).join(' '),
      snippet:compactText(project.absPath||project.folder||'尚未绑定本地文件夹',SEARCH_SNIPPET_MAX)
    },
    {
      chapter:'feishu',
      haystack:[feishuBound?project.feishu:'',feishuBound?'飞书已绑定':'飞书未绑定','飞书记录'].join(' '),
      snippet:compactText(feishuBound?`飞书已绑定 ${project.feishu}`:'飞书未绑定',SEARCH_SNIPPET_MAX)
    },
    {
      chapter:'todos',
      haystack:['待办与卡点',project.progress?.hasBlocker?'有卡点 卡点':'无卡点',`未完成${open}`,`已完成${done}`,titles].join(' '),
      snippet:compactText(
        project.progress?.hasBlocker
          ?`待办未完成 ${open}，存在卡点`
          :`待办未完成 ${open}，暂无明确卡点`,
        SEARCH_SNIPPET_MAX
      )
    },
    {
      chapter:'git',
      haystack:[gitRemote,'本地 Git',gitRemote?'Git 已配置':'Git 未设置'].filter(Boolean).join(' '),
      snippet:compactText(gitRemote||'未设置 Git',SEARCH_SNIPPET_MAX)
    },
    {
      chapter:'constraints',
      haystack:[project.status,project.progress?.status,project.endDate,project.intro,'约束',project.completed?'已完成':'未完成'].filter(Boolean).join(' '),
      snippet:compactText(`状态 ${project.status||project.progress?.status||'未启动'}，计划结束 ${project.endDate||'未设'}`,SEARCH_SNIPPET_MAX)
    }
  ];
}

export function planProjectKnowledgeMessage({message,state}){
  const text=String(message||'').trim();
  if(!text)return null;
  const project=findProject(state,text);
  const wantsSearch=/(搜索|检索|查找).*(知识|卡点|资产|约束|git|Git|飞书)|知识检索/.test(text);
  if(wantsSearch){
    if(!project)return {kind:'clarification',message:'请明确项目名称，我只会在该项目的本地指针里检索。'};
    const query=extractSearchQuery(text,project);
    if(!query)return {kind:'clarification',message:'请补充要检索的关键词。'};
    return {
      kind:'tool',
      toolName:'project_knowledge_search',
      args:{projectId:project.id,query},
      reason:`在「${project.name}」的本地指针中检索，不读取飞书正文。`
    };
  }
  const wantsOverview=/(盘点|总览|概况|资产盘点|知识索引)/.test(text);
  if(wantsOverview){
    if(!project)return {kind:'clarification',message:'请明确项目名称，我只会盘点该项目的本地指针。'};
    return {
      kind:'tool',
      toolName:'project_overview',
      args:{projectId:project.id},
      reason:`盘点「${project.name}」的本地资产、待办、Git 与飞书绑定指针。`
    };
  }
  return null;
}

export function createProjectKnowledgeTools(){
  return [
    descriptor({
      name:'project_overview',
      description:'读取单个项目的指针级资产盘点：进度、待办计数、本地文件夹、Git 与飞书绑定。不返回飞书正文或备忘正文。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:nonEmptyString},required:['projectId']},
      readOnly:true,
      execute:async(context,args)=>{
        const {project,todos,notes}=derivedProject(context,String(args.projectId).trim());
        return overviewFrom(project,todos,notes);
      }
    }),
    descriptor({
      name:'project_knowledge_search',
      description:'在单个项目的本地指针中检索资产、待办标题、Git、飞书绑定与约束；不读取飞书正文或备忘正文。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:nonEmptyString,query:nonEmptyString},required:['projectId','query']},
      readOnly:true,
      execute:async(context,args)=>{
        const query=String(args.query||'').trim();
        const {project,todos}=derivedProject(context,String(args.projectId).trim());
        const needle=query.toLowerCase();
        const hits=chapterCatalog(project,todos)
          .filter(item=>item.haystack.toLowerCase().includes(needle))
          .map(item=>({chapter:item.chapter,snippet:item.snippet}));
        return {projectId:project.id,query,hits};
      }
    })
  ];
}
