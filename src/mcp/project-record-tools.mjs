import { readProjectRecords, appendProjectSummary } from '../domain.mjs';

const nonEmptyString={type:'string',minLength:1};

function descriptor({name,description,inputSchema,readOnly=false,requiresConfirmation=false,execute}){
  return Object.freeze({name,description,inputSchema,readOnly,requiresConfirmation,execute});
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
