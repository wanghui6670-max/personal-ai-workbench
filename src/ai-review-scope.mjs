const REVIEW_VIEW='inbox-review';
const REVIEW_TOOLS=new Set(['inbox_process','diary_extract_todos']);

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
    '只解析当前这一条飞书混合日记内容，不要把整段强行归为一个类别。',
    `itemId=${item.id}`,
    `章节上下文=${heading}`,
    `块类型=${blockKind}`,
    `原文=${JSON.stringify(item.text||'')}`,
    '从原文提取 0 到 5 个真正可独立执行的下一步动作；背景、分析、复盘、已经发生的事情继续留在飞书。',
    '不要猜截止日期，不要猜项目，不得自动加入 Today，不得新建项目，不得删除或改写飞书原文。'
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
  return tools.filter(tool=>REVIEW_TOOLS.has(tool?.name));
}

export function enforceInboxReviewPlan(plan,route={}){
  if(!isInboxReviewRoute(route)||!plan)return plan;
  if(plan.kind==='clarification'||!plan.toolName)return plan;
  if(REVIEW_TOOLS.has(plan.toolName)&&plan.args?.itemId===route.id)return plan;
  return {
    ...plan,
    kind:'clarification',
    toolName:null,
    args:{},
    message:'AI 没有形成针对当前这条飞书日记内容的安全解析结果，请重新分析。',
    reason:'单条飞书审阅只允许针对目标 item 执行原子待办提取或 inbox_process。'
  };
}

export const AI_INBOX_REVIEW_VIEW=REVIEW_VIEW;
export const AI_INBOX_REVIEW_TOOL='inbox_process';
export const AI_DIARY_EXTRACTION_TOOL='diary_extract_todos';
