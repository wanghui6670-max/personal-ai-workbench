import {readGetnoteContentStatus,syncGetnoteContent} from '../getnote-content-sync.mjs';

const integerLimit={type:'integer',minimum:1,maximum:200};

function requireObject(args){
  if(!args||typeof args!=='object'||Array.isArray(args))throw Object.assign(new Error('工具参数必须是 JSON 对象。'),{statusCode:400,code:'MCP_TOOL_INVALID_ARGUMENT'});
  return args;
}

export function createContentTools(){
  return [
    Object.freeze({
      name:'getnote_content_status',
      description:'读取“自媒体 / 得到大脑内容”本地同步状态；不会读取得到大脑、不会写文件。',
      inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
      readOnly:true,
      requiresConfirmation:false,
      execute:async context=>readGetnoteContentStatus({appRoot:context.appRoot,store:context.store})
    }),
    Object.freeze({
      name:'getnote_content_sync',
      description:'用户确认后，从得到大脑只读拉取最近笔记原文，保存到“自媒体 / 得到大脑内容”本地文件夹；不会创建待办、不会加入 Today、不会写回得到大脑。',
      inputSchema:{type:'object',additionalProperties:false,properties:{limit:integerLimit},required:[]},
      readOnly:false,
      requiresConfirmation:true,
      execute:async(context,args)=>{
        const input=requireObject(args);
        return syncGetnoteContent({appRoot:context.appRoot,store:context.store,limit:Number.isInteger(input.limit)?input.limit:50});
      }
    })
  ];
}

export function planContentMessage({message}={}){
  const text=String(message||'').trim();
  if(!/(得到大脑|GetNote|Get笔记)/i.test(text))return null;
  if(/(待办|任务|meeting_todos)/i.test(text)){
    return{
      kind:'clarification',toolName:null,args:{},
      reason:'得到大脑已退出个人待办主链路；个人收件箱主来源改为飞书云文档。',
      message:'得到大脑现在只用于“自媒体”内容采集，不再同步成个人待办。要处理工作事项，请先同步飞书收件箱；要采集得到大脑内容，可以说“同步得到大脑内容到自媒体”。'
    };
  }
  if(!/(内容|素材|笔记|自媒体)/.test(text))return null;
  // Read-only status questions win over the generic word “同步”, e.g.
  // “查看得到大脑内容同步到哪里” must never be interpreted as a write.
  if(/(状态|同步到哪里|目录|多少篇|保存在哪里|本地位置)/.test(text)){
    return{kind:'tool',toolName:'getnote_content_status',args:{},reason:'用户在查询自媒体得到大脑内容同步状态。',message:'我会读取本地同步状态。'};
  }
  if(/(同步|拉取|导入|采集|保存到本地)/.test(text)){
    const match=text.match(/(?:最近|前)?\s*(\d{1,3})\s*(?:篇|条)/);
    const parsed=match?Number(match[1]):50;
    const limit=Number.isInteger(parsed)&&parsed>=1&&parsed<=200?parsed:50;
    return{
      kind:'tool',toolName:'getnote_content_sync',args:{limit},
      reason:'用户明确要求把得到大脑内容同步到自媒体本地内容目录。',
      message:'我会只读取得到大脑内容并写入自媒体本地目录；不会把它们变成任务，执行前仍需要你确认。'
    };
  }
  return null;
}
