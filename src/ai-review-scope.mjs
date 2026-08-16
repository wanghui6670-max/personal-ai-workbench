const REVIEW_VIEW='inbox-review';
const REVIEW_TOOL='inbox_process';

export function isInboxReviewRoute(route={}){
  return route?.view===REVIEW_VIEW&&typeof route?.id==='string'&&Boolean(route.id.trim());
}

function todoReviewText(item){
  if(item?.source!=='feishu_todo'&&item?.feishuMode!=='todo_only')return item?.text||'';
  const heading=Array.isArray(item.feishuHeadingPath)&&item.feishuHeadingPath.length
    ?item.feishuHeadingPath.join(' / ')
    :'无明确章节';
  const blockKind=item.feishuExplicitInbox?'明确 [INBOX] 待办':item.feishuTodoKind==='native_todo'?'飞书原生待办':'明确待办';
  return `[飞书明确待办｜章节：${heading}｜类型：${blockKind}] ${item.text||''}`;
}

export function inboxReviewPlannerMessage(state={},route={},fallbackMessage=''){
  if(!isInboxReviewRoute(route))return fallbackMessage;
  const item=(state.inbox||[]).find(candidate=>candidate.id===route.id)||null;
  if(!item)return fallbackMessage;
  if(item.source!=='feishu_todo'&&item.feishuMode!=='todo_only')return fallbackMessage;
  const heading=Array.isArray(item.feishuHeadingPath)&&item.feishuHeadingPath.length
    ?item.feishuHeadingPath.join(' / ')
    :'无明确章节';
  return [
    '当前内容已经由飞书来源明确标记为待办；不要再判断它是不是待办，也不要从普通日记里提取新任务。',
    `itemId=${item.id}`,
    `章节上下文=${heading}`,
    `原文=${JSON.stringify(item.text||'')}`,
    '只针对这一条明确待办提出一个处理建议，不要执行。',
    '有明确截止日期且项目唯一时，可以建议 inbox_process 创建待办；缺截止日期必须 clarification。',
    '项目归属不唯一、需要新建项目或事实不足时必须 clarification。',
    '不得自动加入 Today，不得自动创建项目，不得删除或改写飞书原文，不得读取其他日记内容。'
  ].join('；');
}

export function scopedInboxReviewState(state={},route={}){
  if(!isInboxReviewRoute(route))return state;
  const item=(state.inbox||[]).find(candidate=>candidate.id===route.id)||null;
  return {
    inbox:item?[{
      id:item.id,
      text:todoReviewText(item),
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
    message:'AI 没有形成针对当前这条飞书待办的唯一安全处理动作，请你决定。',
    reason:'单条飞书待办审阅只允许针对目标 item 生成 inbox_process 预览。'
  };
}

export const AI_INBOX_REVIEW_VIEW=REVIEW_VIEW;
export const AI_INBOX_REVIEW_TOOL=REVIEW_TOOL;
