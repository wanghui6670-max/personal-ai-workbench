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
      description:'读取得到大脑只读任务来源、最近笔记扫描数量、任务时区、可选飞书每日工作日记 sink 和 ICS 镜像设置；不返回任何凭证。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      readOnly:true,
      execute:async context=>readExternalTaskIntegration({store:context.store})
    }),
    descriptor({
      name:'external_task_integration_update',
      description:'配置得到大脑单向只读来源、最近笔记扫描数量、IANA 任务时区、可选飞书日记 sink 和 ICS 镜像；不接受任意命令、凭证或文件路径。',
      inputSchema:{
        type:'object',additionalProperties:false,
        properties:{
          enabled:{type:'boolean'},
          noteLimit:{type:'integer',minimum:20,maximum:500},
          timeZone:{type:'string',minLength:1,maxLength:100},
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
      description:'读取得到大脑最近笔记并继续追踪工作台仍未完成事项对应的旧笔记，只解析明确 meeting_todos；先原子提交 Workbench 任务状态，再尝试可选飞书任务快照与 ICS 派生输出。无明确日期的事项进入 Inbox，不自动加入 Today。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      requiresConfirmation:true,
      execute:async context=>withExternalTaskWriteLease(
        '同步得到大脑待办',
        ()=>syncExternalTasks({store:context.store})
      )
    }),
    descriptor({
      name:'daily_summary_publish',
      description:'把当天完成事项、到期待办和工作台关键动作沉淀到已配置的飞书每日工作日记。正文只保存到飞书；未配置飞书日记时该操作不可用，但不影响任务同步。',
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
    return{kind:'tool',toolName:'external_tasks_sync',args:{},reason:'按你的明确指令只读取得到大脑 meeting_todos，先提交 Workbench，再尝试可选飞书与 ICS 派生输出。'};
  }
  if(/(?:沉淀|发布|写入|保存).*(?:今日总结|每日总结|工作总结)|(?:今日总结|每日总结).*(?:飞书|日记)/.test(text)){
    const notes=text.replace(/(?:沉淀|发布|写入|保存|今日总结|每日总结|工作总结|到飞书|飞书|日记|请|帮我)/g,'').trim();
    return{kind:'tool',toolName:'daily_summary_publish',args:notes?{notes}:{},reason:'把今天的任务状态与工作台关键动作写入已配置的飞书每日工作日记。'};
  }
  if(/(?:配置|设置).*(?:得到大脑|Get笔记|getnote|任务时区|本机日历|每日工作日记)/i.test(text)){
    return{kind:'tool',toolName:'panel_navigate',args:{view:'today',id:null,modal:'settings'},reason:'打开设置，由你配置得到大脑来源、任务时区、可选飞书日记和 ICS 镜像。'};
  }
  return null;
}
