const REVIEW_VIEW='inbox-review';
const REVIEW_TOOL='inbox_process';

export function isInboxReviewRoute(route={}){
  return route?.view===REVIEW_VIEW&&typeof route?.id==='string'&&Boolean(route.id.trim());
}

export function scopedInboxReviewState(state={},route={}){
  if(!isInboxReviewRoute(route))return state;
  const item=(state.inbox||[]).find(candidate=>candidate.id===route.id)||null;
  return {
    inbox:item?[{
      id:item.id,
      text:item.text,
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
    message:'AI 没有形成针对当前这条飞书收件箱事项的唯一安全处理动作，请你决定。',
    reason:'单条飞书审阅只允许针对目标 item 生成 inbox_process 预览。'
  };
}

export const AI_INBOX_REVIEW_VIEW=REVIEW_VIEW;
export const AI_INBOX_REVIEW_TOOL=REVIEW_TOOL;
