import { askStructured } from './ai.mjs';

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

function extractionPlan({route,candidates=[],reason='',analysis=[]}){
  if(!route?.id)return null;
  const safe=Array.isArray(candidates)?candidates.slice(0,5):[];
  const fallbackReason=safe.length
    ?`从当前日记内容提取到 ${safe.length} 个可独立执行的待办。`
    :'当前日记内容没有可独立执行的待办。';
  return{
    kind:'tool',
    toolName:'diary_extract_todos',
    args:{itemId:route.id,candidates:safe},
    category:safe.length?'todo':'non_todo',
    destination:'todo_candidate',
    confidence:safe.length?Math.max(...safe.map(item=>Number(item.confidence)||0)):1,
    reason:reason||fallbackReason,
    message:safe.length?`提取到 ${safe.length} 个待办候选；背景、分析和日常记录不进入待办。`:'没有提取到待办；这条日记只保留在飞书。',
    messageReply:safe.length?`提取到 ${safe.length} 个待办候选。`:'没有提取到待办。',
    analysis
  };
}

export function normalizeDiaryTodoExtraction(decision={},analysis={},route={},options={}){
  if(!route?.id||!Array.isArray(decision.todoCandidates))return null;
  const projects=Array.isArray(options.projects)?options.projects:[];
  const projectIds=new Set(projects.map(project=>project.id));
  const seen=new Set();
  const candidates=[];
  for(const raw of decision.todoCandidates.slice(0,5)){
    const text=String(raw?.text||'').replace(/\s+/g,' ').trim();
    if(!text||text.length>240)continue;
    const key=text.toLocaleLowerCase('zh-CN');
    if(seen.has(key))continue;
    seen.add(key);
    const dueDate=typeof raw.dueDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate)?raw.dueDate:null;
    const targetProjectId=typeof raw.targetProjectId==='string'&&projectIds.has(raw.targetProjectId)?raw.targetProjectId:null;
    candidates.push({
      text,
      dueDate,
      targetProjectId,
      confidence:Number.isFinite(raw.confidence)?Math.max(0,Math.min(1,raw.confidence)):0,
      reason:String(raw.reason||'').replace(/\s+/g,' ').trim().slice(0,260)
    });
  }
  return extractionPlan({route,candidates,reason:String(decision.reason||''),analysis});
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
  const candidateSchema={
    type:'object',additionalProperties:false,
    properties:{
      text:boundedText(240),
      dueDate:{anyOf:[{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$'},{type:'null'}]},
      targetProjectId,
      confidence:{type:'number',minimum:0,maximum:1},
      reason:boundedText(260)
    },
    required:['text','dueDate','targetProjectId','confidence','reason']
  };
  const decisionSchema={
    type:'object',additionalProperties:false,
    properties:{
      todoCandidates:{type:'array',maxItems:5,items:candidateSchema},
      reason:boundedText(420)
    },
    required:['todoCandidates','reason']
  };
  const schema=analysisSchema(decisionSchema,evidenceIds);
  const projectText=projects.map((project,index)=>`[project_${index+1}] ${project.id} | ${project.name} | 计划结束 ${project.endDate||'未知'}`).join('\n')||'（当前没有可匹配项目）';
  const result=await askStructured({
    name:'mixed_diary_todo_extraction',
    description:'Extract zero to five atomic actionable todos from one Feishu mixed-diary block; leave narrative and analysis in Feishu.',
    schema,
    instructions:[
      '你是个人工作台的飞书日记待办提取器。不要给整段日记贴一个标签；要从当前这一段里提取 0 到 5 个真正可以独立执行的下一步动作。',
      '一段可以同时包含背景、复盘、观点和多个动作。背景、分析、已经发生的事情全部留在飞书，不得复制成待办；只输出动作本身。',
      '待办 text 必须是简洁、独立、可执行的动作，忠实于原文。可以删掉背景铺垫，但不能发明对象、范围、数量、日期、交付物或结论。',
      '“建议/结论/价值/原则/复盘/感受/已经完成/今天发生了什么”本身不是待办。只有泛泛的“以后注意”“要重视”“记住这一点”而没有具体可执行动作时，也不要提取。',
      '明确出现补完、跟进、联系、确认、准备、提交、发送、拍摄、修改、整理、采购、发布、选择后执行等下一步行动时，可以提取。一个段落有两个独立动作就输出两个候选。',
      '否定表达不是待办，例如“不要发布”“不是再整理”“无需跟进”“不用修改”。不得把否定动作反向提取成正向任务。',
      'checkbox 或明确 [INBOX] 只是强提示，不代表整段都要进入待办；仍然只提取实际动作。',
      'dueDate 只有原文明示了可可靠转换为 YYYY-MM-DD 的截止日期时才填写，否则必须为 null；绝不能猜日期。',
      'targetProjectId 只有原文与一个现有项目能够唯一、明确对应时才填写，否则必须为 null；绝不能新建项目。',
      '不要自动加入 Today，不要创建 Todo，不要删除或改写飞书原文。你的输出只用于生成 Workbench 的待办候选。',
      'analysis.evidence 只引用给定 evidence ID，输出可审计摘要，不输出隐藏思维链。'
    ].join('\n'),
    input:`[diary_item] ${item.text||''}\n\n可匹配项目：\n${projectText}`,
    env,fetchImpl
  });
  if(!result?.decision)return null;
  return normalizeDiaryTodoExtraction(result.decision,result.analysis,route,{projects});
}

function stripDiaryPrefix(text){return String(text||'').replace(/^\[飞书混合日记[^\]]*\]\s*/,'').trim();}
function localActionSentences(text){
  const source=stripDiaryPrefix(text);
  const parts=source.split(/[。！？!?；;\n]+/).map(part=>part.trim()).filter(Boolean);
  const action=/待办|记得|需要(?:去|做|补|改|跟|联|确|准|提|发|拍|整|采|更|处)|要(?:去|做|补|改|跟|联|确|准|提|发|拍|整|采|更|处)|补完|补充|跟进|联系|确认|准备|提交|发送|拍摄|再拍|修改|整理|采购|发布|更新|处理|完成|选一个|试\s*\d+个/i;
  const actionVerb='(?:补完|补充|跟进|联系|确认|准备|提交|发送|拍摄|再拍|修改|整理|采购|发布|更新|处理|完成|去做|做|补|改|跟|联|确|准|提|发|拍|整|采|更|处)';
  const negatedAction=new RegExp(`(?:不是(?:再)?|不要|不需要|不用|无需|别|不能|禁止)[^，。！？；;]{0,12}${actionVerb}`,'i');
  const vague=/^(?:以后|后续)?(?:要|需要)?(?:注意|重视|记住|提醒自己)(?:这|那|这一|这一点|一下)?$/;
  return parts.filter(part=>action.test(part)&&!negatedAction.test(part)&&!vague.test(part)).slice(0,3);
}

export function localDiaryReviewPlan({state={},route={}}={}){
  const item=(state.inbox||[]).find(candidate=>candidate.id===route?.id)||(state.inbox||[])[0];
  if(!item)return null;
  const projects=(state.projects||[]).filter(project=>!project.archived);
  const sentences=localActionSentences(item.text);
  const candidates=sentences.map(text=>{
    const matched=projects.filter(project=>project.name&&text.includes(project.name));
    return{text,dueDate:null,targetProjectId:matched.length===1?matched[0].id:null,confidence:.55,reason:'本地回退检测到明确且未被否定的行动表达；未推测截止日期。'};
  });
  return extractionPlan({route,candidates,reason:candidates.length?'本地回退从当前日记段落中提取明确行动。':'本地回退未检测到足够明确的下一步行动。',analysis:[]});
}
