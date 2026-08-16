import { syncFeishuInbox } from '../domain.mjs';

export function createFeishuInitializeTools(){
  return [Object.freeze({
    name:'feishu_initial_import',
    description:'一次性重新建立当前飞书日记基线：完整读取当前文档、清空旧来源 ACK 后重新去重并导入，供 AI 分类；完成后普通同步继续只处理新增 block。仅应由用户显式点击初始化入口触发。',
    inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
    readOnly:false,
    requiresConfirmation:true,
    execute:async context=>syncFeishuInbox({store:context.store,initialize:true})
  })];
}
