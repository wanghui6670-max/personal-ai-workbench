import { readProjectRecords, appendProjectSummary } from '../domain.mjs';

const nonEmptyString={type:'string',minLength:1};

function descriptor({name,description,inputSchema,readOnly=false,requiresConfirmation=false,execute}){
  return Object.freeze({name,description,inputSchema,readOnly,requiresConfirmation,execute});
}

function findProject(state,message){
  const text=String(message||'').replace(/\s/g,'').toLowerCase();
  const projects=Array.isArray(state?.projects)?state.projects:[];
  const exact=projects.filter(project=>text.includes(String(project.name||'').replace(/\s/g,'').toLowerCase()));
  if(exact.length===1)return exact[0];
  return null;
}

export function planProjectRecordMessage({message,state}){
  const text=String(message||'').trim();
  if(!text)return null;
  const project=findProject(state,text);
  const wantsRecords=/(查看|读取|看看|回顾|打开).*(项目)?(分析|总结|复盘|记录)|(项目)?(分析|总结|复盘|记录).*(查看|读取|看看|回顾)/.test(text);
  if(wantsRecords){
    if(!project)return {kind:'clarification',message:'请明确项目名称，我只会从该项目绑定的飞书项目文档读取分析与总结。'};
    return {kind:'tool',toolName:'project_records_read',args:{projectId:project.id},reason:`从「${project.name}」绑定的飞书项目文档读取分析与总结，不读取本地副本。`};
  }
  const summaryMatch=text.match(/(?:追加|保存|记录|写入)(?:一条)?(?:阶段)?总结(?:到[^：:，,。]*)?[：:]\s*([\s\S]+)$/);
  if(summaryMatch){
    if(!project)return {kind:'clarification',message:'请明确项目名称；阶段总结只写入该项目绑定的飞书项目文档。'};
    const summary=summaryMatch[1].trim();
    if(!summary)return {kind:'clarification',message:'请补充要写入飞书项目文档的阶段总结正文。'};
    return {kind:'tool',toolName:'project_summary_append',args:{projectId:project.id,text:summary},reason:`把你明确提供的阶段总结追加到「${project.name}」的飞书项目文档；写入前仍需确认。`};
  }
  return null;
}

export function createProjectRecordTools(){
  return [
    descriptor({
      name:'project_records_read',
      description:'从项目绑定的飞书项目文档读取分析与阶段总结。正文不缓存在工作台本地状态。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:nonEmptyString},required:['projectId']},
      readOnly:true,
      execute:async(context,args)=>readProjectRecords({store:context.store,projectId:String(args.projectId).trim()})
    }),
    descriptor({
      name:'project_summary_append',
      description:'把用户确认的阶段总结追加到项目绑定的飞书项目文档；本地仅记录不含正文的审计事件。',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:nonEmptyString,text:{type:'string',minLength:1,maxLength:6000}},required:['projectId','text']},
      requiresConfirmation:true,
      execute:async(context,args)=>appendProjectSummary({store:context.store,projectId:String(args.projectId).trim(),text:String(args.text).trim()})
    })
  ];
}
