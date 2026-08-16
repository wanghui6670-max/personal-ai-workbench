import { applyDiaryTodoExtraction } from '../diary-todo-extraction.mjs';

const nullableDate={anyOf:[{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$'},{type:'null'}]};
const nullableString={anyOf:[{type:'string',minLength:1},{type:'null'}]};

export function createDiaryExtractionTools(){
  return [Object.freeze({
    name:'diary_extract_todos',
    description:'内部解析动作：把一条尚未解析的飞书混合日记记录替换为 0-5 个原子待办候选。只改变 Workbench 待处理暂存，不创建 Todo、不加入 Today、不建项目、不修改飞书原文。',
    inputSchema:{
      type:'object',additionalProperties:false,
      properties:{
        itemId:{type:'string',minLength:1},
        candidates:{
          type:'array',maxItems:5,
          items:{
            type:'object',additionalProperties:false,
            properties:{
              text:{type:'string',minLength:1,maxLength:240},
              dueDate:nullableDate,
              targetProjectId:nullableString,
              confidence:{type:'number',minimum:0,maximum:1},
              reason:{type:'string',maxLength:260}
            },
            required:['text','dueDate','targetProjectId','confidence','reason']
          }
        }
      },
      required:['itemId','candidates']
    },
    readOnly:false,
    requiresConfirmation:false,
    execute:async(context,args)=>applyDiaryTodoExtraction({store:context.store,itemId:args.itemId,candidates:args.candidates})
  })];
}
