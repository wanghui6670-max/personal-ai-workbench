const REVIEW_VIEW='inbox-review';
const REVIEW_TOOL='inbox_process';

export function isInboxReviewRoute(route={}){
  return route?.view===REVIEW_VIEW&&typeof route?.id==='string'&&Boolean(route.id.trim());
}

function diaryReviewText(item){
  if(item?.feishuMode!=='mixed_diary')return item?.text||'';
  const heading=Array.isArray(item.feishuHeadingPath)&&item.feishuHeadingPath.length
    ?item.feishuHeadingPath.join(' / ')
    :'无明确章节';
  const blockKind=item.feishuExplicitInbox?'明确 [INBOX] 条目':item.feishuTag==='checkbox'?'复选框记录':'日记正文';
  return `[飞书混合日记｜章节：${heading}｜块类型：${blockKind}] ${item.text||''}`;
}

export function scopedInboxReviewState(state={},route={}){
  if(!isInboxReviewRoute(route))return state;
  const item=(state.inbox||[]).find(candidate=>candidate.id===route.id)||null;
  return {
    inbox:item?[{
      id:item.id,
      text:diaryReviewText(item),
      source:item.source,
      createdAt:item.createdAt
    }]:[],
    projects:(state.projects||[])
      .filter(project=>!project.archived)
      .slice(0,30)
      .map(project=>({
        id:project.id,
        name:project.name,
        businessId:project.businessId??null,
        endDate:project.endDate??null,
        completed:Boolean(project.completed),
        archived:Boolean(project.archived)
      })),
    todos:[],
    todayPlan:[],
    confirmations:[]
  };
}

export function scopedInboxReviewTools(tools=[],route={}){
  if(!isInboxReviewRoute(route))return tools;
  return tools.filter(tool=>tool?.name===REVIEW_TOOL);
}

export function enforceInboxReviewPlan(plan,route={}){
  if(!isInboxReviewRoute(route)||!plan)return plan;
  if(plan.kind==='clarification'||!plan.toolName)return plan;
  if(plan.toolName===REVIEW_TOOL&&plan.args?.itemId===route.id)return plan;
  return {
    ...plan,
    kind:'clarification',
    toolName:null,
    args:{},
    message:'AI 没有形成针对当前这条飞书日记内容的唯一安全处理动作，请你决定。',
    reason:'单条飞书审阅只允许针对目标 item 生成 inbox_process 预览。'
  };
}

export const AI_INBOX_REVIEW_VIEW=REVIEW_VIEW;
export const AI_INBOX_REVIEW_TOOL=REVIEW_TOOL;
