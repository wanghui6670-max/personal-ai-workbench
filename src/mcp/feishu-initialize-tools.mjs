import { syncFeishuInbox } from '../domain.mjs';

export function createFeishuInitializeTools(){
  return [Object.freeze({
    name:'feishu_initial_import',
    description:'在用户显式确认后重新建立当前飞书日记基线：完整读取当前文档、清空旧来源 ACK 后重新去重并导入，供 AI 分类；完成后普通同步继续只处理新增 block。可用于首次初始化，也可在需要时手动重新初始化。',
    inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
    readOnly:false,
    requiresConfirmation:true,
    execute:async context=>syncFeishuInbox({store:context.store,initialize:true})
  })];
}
