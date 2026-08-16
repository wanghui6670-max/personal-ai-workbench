import { addActivity } from './store.mjs';
import { newId, nowIso } from './utils.mjs';
import { isValidDateOnly } from './validation.mjs';

function badRequest(message,statusCode=400){
  return Object.assign(new Error(message),{statusCode,code:'INVALID_REQUEST'});
}

function normalizeText(value){return String(value??'').replace(/\s+/g,' ').trim();}
function textKey(value){return normalizeText(value).toLocaleLowerCase('zh-CN');}

function validateCandidate(candidate,index){
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw badRequest(`第 ${index+1} 个待办候选格式无效。`);
  const text=normalizeText(candidate.text);
  if(!text||text.length>240)throw badRequest(`第 ${index+1} 个待办候选必须是 1-240 字的明确动作。`);
  const dueDate=candidate.dueDate===null||candidate.dueDate===undefined?null:String(candidate.dueDate).trim();
  if(dueDate&&!isValidDateOnly(dueDate))throw badRequest(`第 ${index+1} 个待办候选截止日期无效。`);
  const targetProjectId=candidate.targetProjectId===null||candidate.targetProjectId===undefined?null:String(candidate.targetProjectId).trim();
  if(candidate.targetProjectId!==null&&candidate.targetProjectId!==undefined&&!targetProjectId)throw badRequest(`第 ${index+1} 个待办候选项目 ID 无效。`);
  const confidence=Number(candidate.confidence);
  const safeConfidence=Number.isFinite(confidence)?Math.max(0,Math.min(1,confidence)):null;
  const reason=normalizeText(candidate.reason).slice(0,260);
  return{text,dueDate,targetProjectId,confidence:safeConfidence,reason};
}

export async function applyDiaryTodoExtraction({store,itemId,candidates=[]}={}){
  if(!store)throw badRequest('缺少工作台存储。');
  if(typeof itemId!=='string'||!itemId.trim())throw badRequest('itemId 必须是非空字符串。');
  if(!Array.isArray(candidates)||candidates.length>5)throw badRequest('单条飞书日记最多提取 5 个待办候选。');
  const normalized=candidates.map(validateCandidate);
  let result=null;

  await store.updateState(state=>{
    const sourceIndex=(state.inbox||[]).findIndex(item=>item.id===itemId);
    if(sourceIndex<0)throw badRequest('待解析的飞书日记记录不存在。',409);
    const source=state.inbox[sourceIndex];
    if(source.source!=='feishu_doc'||source.feishuMode!=='mixed_diary')throw badRequest('只有尚未解析的飞书混合日记记录可以执行待办提取。',409);

    const activeProjects=new Map((state.projects||[]).filter(project=>!project.archived).map(project=>[project.id,project]));
    const existingKeys=new Set();
    for(const item of state.inbox||[]){if(item.id!==itemId)existingKeys.add(textKey(item.text));}
    for(const todo of state.todos||[]){existingKeys.add(textKey(todo.title));existingKeys.add(textKey(todo.context));}

    const accepted=[];
    let deduped=0;
    for(const candidate of normalized){
      const key=textKey(candidate.text);
      if(!key||existingKeys.has(key)){deduped+=1;continue;}
      existingKeys.add(key);
      const project=candidate.targetProjectId?activeProjects.get(candidate.targetProjectId)||null:null;
      accepted.push({
        id:newId('in'),
        text:candidate.text,
        source:'feishu_todo_candidate',
        feishuSourceBlockId:source.feishuBlockId||null,
        feishuHeadingPath:Array.isArray(source.feishuHeadingPath)?source.feishuHeadingPath.slice(0,3):[],
        feishuExplicitInbox:Boolean(source.feishuExplicitInbox),
        suggestedDueDate:candidate.dueDate,
        suggestedProjectId:project?.id||null,
        extractionConfidence:candidate.confidence,
        extractionReason:candidate.reason,
        createdAt:source.createdAt||nowIso(),
        extractedAt:nowIso()
      });
    }

    state.inbox.splice(sourceIndex,1,...accepted);
    state.confirmations=(state.confirmations||[]).filter(entry=>entry.inboxId!==itemId);
    addActivity(state,{
      type:'feishu_diary_todo_extracted',
      text:accepted.length
        ?`飞书日记解析完成：提取 ${accepted.length} 个待办候选${deduped?`，去重 ${deduped} 个`:''}。`
        :`飞书日记解析完成：没有提取到待办${deduped?`，去重 ${deduped} 个`:''}。`
    });
    result={
      sourceItemId:itemId,
      extracted:accepted.length,
      deduped,
      filtered:accepted.length===0,
      candidateIds:accepted.map(item=>item.id),
      candidates:accepted.map(item=>({id:item.id,text:item.text,dueDate:item.suggestedDueDate,targetProjectId:item.suggestedProjectId}))
    };
  });

  return result;
}
