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

export function inboxReviewPlannerMessage(state={},route={},fallbackMessage=''){
  if(!isInboxReviewRoute(route))return fallbackMessage;
  const item=(state.inbox||[]).find(candidate=>candidate.id===route.id)||null;
  if(!item)return fallbackMessage;
  if(item.feishuMode!=='mixed_diary')return fallbackMessage;
  const heading=Array.isArray(item.feishuHeadingPath)&&item.feishuHeadingPath.length
    ?item.feishuHeadingPath.join(' / ')
    :'无明确章节';
  const blockKind=item.feishuExplicitInbox?'明确 [INBOX] 条目':item.feishuTag==='checkbox'?'复选框记录':'日记正文';
  return [
    '只分析当前这一条飞书混合日记内容并提出一个处理建议，不要执行。',
    `itemId=${item.id}`,
    `章节上下文=${heading}`,
    `块类型=${blockKind}`,
    `原文=${JSON.stringify(item.text||'')}`,
    '先判断它属于：待办、项目进展、分析思考、日常记录、需要你决定。',
    '明确待办：可建议 inbox_process 创建待办；没有明确截止日期必须 clarification。',
    '明确属于已有项目：可建议归入项目记录；项目不唯一必须 clarification。',
    '分析思考或日常记录：优先建议“只是备忘”，不要变成任务。',
    '需要新建项目、事实不足或无法唯一判断：必须 clarification。',
    '不得自动加入 Today，不得自动创建项目，不得删除飞书原文，不得因为猜测而处理。'
  ].join('；');
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
