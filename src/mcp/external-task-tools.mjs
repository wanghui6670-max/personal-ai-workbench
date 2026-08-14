import {
  readExternalTaskIntegration,
  updateExternalTaskIntegration,
  syncExternalTasks,
  publishDailySummary
} from '../task-sync-domain.mjs';

let activeWrite=null;

function toolError(message,statusCode=400,code='MCP_TOOL_INVALID_ARGUMENT'){
  return Object.assign(new Error(message),{statusCode,code});
}
function requireObject(args){if(!args||typeof args!=='object'||Array.isArray(args))throw toolError('工具参数必须是 JSON 对象。');return args;}
function descriptor({name,description,inputSchema={},readOnly=false,requiresConfirmation=false,execute}){
  return Object.freeze({name,description,inputSchema,readOnly,requiresConfirmation,execute});
}

export async function withExternalTaskWriteLease(operation,work){
  if(activeWrite){
    throw toolError(
      `外部待办管线正在执行“${activeWrite.operation}”，请等待完成后再执行“${operation}”。`,
      409,
      'EXTERNAL_TASK_PIPELINE_BUSY'
    );
  }
  const lease={operation,startedAt:Date.now()};
  activeWrite=lease;
  try{return await work();}
  finally{if(activeWrite===lease)activeWrite=null;}
}

export function createExternalTaskTools(){
  return[
    descriptor({
      name:'external_task_integration_read',
      description:'读取得到大脑 CLI 待办来源、飞书每日工作日记和本机日历镜像设置；不返回任何凭证。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      readOnly:true,
      execute:async context=>readExternalTaskIntegration({store:context.store})
    }),
    descriptor({
      name:'external_task_integration_update',
      description:'配置得到大脑 CLI 单向来源、最近笔记扫描数量、飞书日记沉淀目标和本机 ICS 日历；不接受任意命令、凭证或文件路径。',
      inputSchema:{
        type:'object',additionalProperties:false,
        properties:{
          enabled:{type:'boolean'},
          noteLimit:{type:'integer',minimum:20,maximum:500},
          journalDocumentUrl:{type:'string'},
          journalHeading:{type:'string',minLength:1,maxLength:80},
          calendarEnabled:{type:'boolean'},
          calendarName:{type:'string',minLength:1,maxLength:80}
        },required:[]
      },
      requiresConfirmation:true,
      execute:async(context,args)=>withExternalTaskWriteLease(
        '更新得到大脑集成设置',
        ()=>updateExternalTaskIntegration({store:context.store,patch:requireObject(args)})
      )
    }),
    descriptor({
      name:'external_tasks_sync',
      description:'分页读取得到大脑最近笔记，并通过 getnote note todos 解析会议待办；先把快照写入飞书日记并读回，再更新本机 ICS 日历和工作台缓存。没有明确日期的事项只进入收件箱。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      requiresConfirmation:true,
      execute:async context=>withExternalTaskWriteLease(
        '同步得到大脑待办',
        ()=>syncExternalTasks({store:context.store})
      )
    }),
    descriptor({
      name:'daily_summary_publish',
      description:'把当天完成事项、到期待办和工作台关键动作沉淀到飞书每日工作日记。正文只保存到飞书。',
      inputSchema:{type:'object',additionalProperties:false,properties:{notes:{type:'string',maxLength:4000}},required:[]},
      requiresConfirmation:true,
      execute:async(context,args)=>withExternalTaskWriteLease('沉淀每日总结',()=>{
        const input=requireObject(args);
        return publishDailySummary({store:context.store,notes:typeof input.notes==='string'?input.notes:''});
      })
    })
  ];
}

export function planExternalTaskMessage({message}){
  const text=String(message||'').trim();
  if(!text)return null;
  if(/(?:同步|读取|拉取).*(?:得到大脑|Get笔记|getnote|外部待办)|(?:得到大脑|Get笔记|getnote|外部待办).*(?:同步|读取|拉取)/i.test(text)){
    return{kind:'tool',toolName:'external_tasks_sync',args:{},reason:'按你的明确指令从得到大脑 CLI 读取笔记待办，并依次沉淀飞书日记与本机日历。'};
  }
  if(/(?:沉淀|发布|写入|保存).*(?:今日总结|每日总结|工作总结)|(?:今日总结|每日总结).*(?:飞书|日记)/.test(text)){
    const notes=text.replace(/(?:沉淀|发布|写入|保存|今日总结|每日总结|工作总结|到飞书|飞书|日记|请|帮我)/g,'').trim();
    return{kind:'tool',toolName:'daily_summary_publish',args:notes?{notes}:{},reason:'把今天的任务状态与工作台关键动作写入飞书每日工作日记。'};
  }
  if(/(?:配置|设置).*(?:得到大脑|Get笔记|getnote|本机日历|每日工作日记)/i.test(text)){
    return{kind:'tool',toolName:'panel_navigate',args:{view:'today',id:null,modal:'settings'},reason:'打开设置，由你配置得到大脑 CLI、飞书日记和本机日历。'};
  }
  return null;
}
