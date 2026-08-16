import { batchDeleteInboxLocal } from '../inbox-batch-domain.mjs';

const itemId={type:'string',minLength:1,maxLength:160};

export function createInboxBatchTools(){
  return [Object.freeze({
    name:'inbox_batch_delete',
    description:'一次性从 Workbench 本地待处理区删除一批已选记录；不删除飞书原文，飞书来源 ACK 保留，因此历史来源不会因删除本地候选而重新导入。',
    inputSchema:{
      type:'object',additionalProperties:false,
      properties:{itemIds:{type:'array',minItems:1,maxItems:500,uniqueItems:true,items:itemId}},
      required:['itemIds']
    },
    readOnly:false,
    requiresConfirmation:true,
    execute:async(context,args)=>batchDeleteInboxLocal({store:context.store,itemIds:args.itemIds})
  })];
}
