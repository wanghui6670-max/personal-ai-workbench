import { askStructured } from './ai.mjs';

const CATEGORY_LABELS=Object.freeze({
  todo:'待办候选',
  project_progress:'项目进展',
  analysis:'分析思考',
  daily_record:'日常记录',
  needs_decision:'需要你决定'
});

const boundedText=max=>({type:'string',pattern:`^[\\s\\S]{1,${max}}$`});

function analysisSchema(decisionSchema,evidenceIds){
  const ids=[...new Set(evidenceIds)];
  const evidenceId={type:'string',enum:ids};
  return{
    type:'object',additionalProperties:false,
    properties:{
      analysis:{
        type:'object',additionalProperties:false,
        properties:{
          evidence:{type:'array',minItems:1,maxItems:10,items:{type:'object',additionalProperties:false,properties:{id:evidenceId,observation:boundedText(220)},required:['id','observation']}},
          conflicts:{type:'array',maxItems:6,items:boundedText(220)},
          gaps:{type:'array',maxItems:6,items:boundedText(220)}
        },required:['evidence','conflicts','gaps']
      },
      decision:decisionSchema
    },required:['analysis','decision']
  };
}

function categoryLabel(category){return CATEGORY_LABELS[category]||CATEGORY_LABELS.needs_decision;}

function clarification(decision,analysis,override){
  const label=categoryLabel(decision.category);
  const message=override||decision.message||'需要你补充信息后再处理。';
  return{
    kind:'clarification',toolName:null,args:{},
    category:decision.category,destination:decision.destination,
    confidence:decision.confidence,
    reason:`分类：${label}。${decision.reason}`,
    message,messageReply:message,analysis
  };
}

function toolPlan(decision,analysis,args){
  const label=categoryLabel(decision.category);
  return{
    kind:'tool',toolName:'inbox_process',args,
    category:decision.category,destination:decision.destination,
    confidence:decision.confidence,
    reason:`分类：${label}。${decision.reason}`,
    message:decision.message,messageReply:decision.message,analysis
  };
}

export function normalizeDiaryReviewDecision(decision={},analysis={},route={}){
  if(!route?.id||!CATEGORY_LABELS[decision.category])return null;
  const destination=decision.destination;
  if(destination==='memo'){
    return toolPlan(decision,analysis,{itemId:route.id,command:'只是备忘'});
  }
  if(destination==='project_note'){
    if(!decision.targetProjectId)return clarification(decision,analysis,'识别为项目进展，但还不能唯一确定目标项目。');
    return toolPlan(decision,analysis,{itemId:route.id,command:'归入该项目作为项目记录',targetProjectId:decision.targetProjectId});
  }
  if(destination==='todo'){
    if(!decision.dueDate)return clarification(decision,analysis,'已经识别为待办候选；还缺一个明确截止日期。');
    const args={itemId:route.id,command:`创建待办，截止 ${decision.dueDate}`};
    if(decision.targetProjectId)args.targetProjectId=decision.targetProjectId;
    if(decision.targetProjectId)args.command=`作为项目待办，截止 ${decision.dueDate}`;
    else args.command=`创建独立待办，截止 ${decision.dueDate}`;
    return toolPlan(decision,analysis,args);
  }
  return clarification(decision,analysis);
}

export async function planDiaryReviewAI({state={},route={},env=process.env,fetchImpl=globalThis.fetch}={}){
  const item=(state.inbox||[]).find(candidate=>candidate.id===route?.id)||(state.inbox||[])[0];
  if(!item)return null;
  const projects=(state.projects||[]).filter(project=>!project.archived).slice(0,30);
  const projectIds=projects.map(project=>project.id);
  const evidenceIds=['diary_item',...projects.map((_,index)=>`project_${index+1}`)];
  const targetProjectId=projectIds.length
    ?{anyOf:[{type:'string',enum:projectIds},{type:'null'}]}
    :{type:'null'};
  const decisionSchema={
    type:'object',additionalProperties:false,
    properties:{
      category:{type:'string',enum:Object.keys(CATEGORY_LABELS)},
      destination:{type:'string',enum:['todo','project_note','memo','clarification']},
      targetProjectId,
      dueDate:{anyOf:[{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$'},{type:'null'}]},
      confidence:{type:'number',minimum:0,maximum:1},
      reason:boundedText(420),
      message:boundedText(520)
    },
    required:['category','destination','targetProjectId','dueDate','confidence','reason','message']
  };
  const schema=analysisSchema(decisionSchema,evidenceIds);
  const projectText=projects.map((project,index)=>`[project_${index+1}] ${project.id} | ${project.name} | 计划结束 ${project.endDate||'未知'}`).join('\n')||'（当前没有可匹配项目）';
  const result=await askStructured({
    name:'mixed_diary_review',
    description:'Classify one Feishu mixed-diary block and propose a safe destination without executing it.',
    schema,
    instructions:[
      '你是个人工作台的飞书混合日记分流器。你的第一职责是自动分类，第二职责才是判断是否已经足够安全生成处理预览。',
      '无论信息是否足够执行，都必须先给出 category 和 destination；不能因为缺截止日期就把明确待办改成“需要决定”。',
      'category 只能是 todo、project_progress、analysis、daily_record、needs_decision。',
      '明确行动、跟进、拍摄、补完、准备、联系、提交、选择后要执行的事项归 todo。即使没有截止日期，仍然 category=todo、destination=todo、dueDate=null。',
      '描述某个既有项目已经发生的进展、结果、卡点或状态归 project_progress。只有项目名称/上下文唯一匹配时才能填写 targetProjectId；否则 destination=clarification。',
      '方法、观点、结论、复盘、创意、文案、策略判断归 analysis，默认 destination=memo。',
      '生活/工作流水、经历、日记式事实记录归 daily_record，默认 destination=memo。',
      '只有真正无法判断类别、必须新建项目、或涉及多个互斥处理方向时才使用 needs_decision / clarification。',
      '待办只有原文明确给出截止日期时才能填写 dueDate；绝不能猜日期。',
      '不得自动加入 Today，不得自动创建项目，不得删除飞书原文。你只产生预览，任何状态写入仍由后续确认门控制。',
      'analysis.evidence 只引用给定 evidence ID，输出可审计摘要，不输出隐藏思维链。'
    ].join('\n'),
    input:`[diary_item] ${item.text||''}\n\n可匹配项目：\n${projectText}`,
    env,fetchImpl
  });
  if(!result?.decision)return null;
  return normalizeDiaryReviewDecision(result.decision,result.analysis,route);
}

export function localDiaryReviewPlan({state={},route={}}={}){
  const item=(state.inbox||[]).find(candidate=>candidate.id===route?.id)||(state.inbox||[])[0];
  if(!item)return null;
  const text=String(item.text||'');
  const projects=(state.projects||[]).filter(project=>!project.archived);
  const matched=projects.filter(project=>project.name&&text.includes(project.name));
  const todoSignal=/复选框记录|待办|提醒|记得|补完|补充|准备|跟进|联系|提交|发送|拍摄|后再拍|要做|需要做|选一个|试\s*\d+个/i.test(text);
  const progressSignal=/进展|已完成|完成了|做到|目前|当前|卡点|结果|交付|上线|更新到|推进到/i.test(text);
  const analysisSignal=/分析|复盘|建议|结论|策略|价值|方法|原则|思考|应该|核心是|不是.*而是/i.test(text);
  if(matched.length===1&&progressSignal){
    return toolPlan({category:'project_progress',destination:'project_note',confidence:.66,reason:'本地回退识别到唯一项目名称和进展表达。',message:'已自动归为项目进展，等你确认后写入项目记录。'},[],{itemId:route.id,command:'归入该项目作为项目记录',targetProjectId:matched[0].id});
  }
  if(todoSignal){
    return clarification({category:'todo',destination:'todo',confidence:.58,reason:'本地回退识别到明确行动表达，但没有可靠截止日期。',message:'已经自动归为待办候选；补一个截止日期即可。'},[],'已经自动归为待办候选；补一个截止日期即可。');
  }
  if(analysisSignal){
    return toolPlan({category:'analysis',destination:'memo',confidence:.57,reason:'本地回退识别到分析/方法/结论表达。',message:'已自动归为分析思考，建议保存为备忘。'},[],{itemId:route.id,command:'只是备忘'});
  }
  return toolPlan({category:'daily_record',destination:'memo',confidence:.51,reason:'本地回退未识别到明确行动或项目进展，按日常记录处理。',message:'已自动归为日常记录，建议保存为备忘。'},[],{itemId:route.id,command:'只是备忘'});
}

export { CATEGORY_LABELS };
