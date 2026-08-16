import { processInbox as baseProcessInbox } from './external-task-routing.mjs';
import { addActivity } from './store.mjs';
import { compactText } from './utils.mjs';

function localIgnoreCommand(value){
  const command=String(value||'').trim();
  if(!command)return false;
  if(/^(?:不要|别|不想|不可|不能|禁止).{0,8}(?:忽略|无需处理|不进入工作台)/.test(command))return false;
  return /^(?:忽略(?:这条|此条)?|无需处理|不进入工作台)(?:[，。；;！!\s]|$)/.test(command);
}

export async function processInbox({store,itemId,command,targetProjectId=null}){
  const snapshot=await store.readState();
  const item=snapshot.inbox.find(candidate=>candidate.id===itemId);
  if(item?.source==='feishu_doc'&&localIgnoreCommand(command)){
    return store.updateState(state=>{
      const current=state.inbox.find(candidate=>candidate.id===itemId);
      if(!current)throw new Error('收件箱事项不存在');
      if(current.source!=='feishu_doc')throw Object.assign(new Error('事项来源已变化，请刷新后重试。'),{statusCode:409});
      state.inbox=state.inbox.filter(candidate=>candidate.id!==itemId);
      state.confirmations=state.confirmations.filter(candidate=>candidate.inboxId!==itemId);
      addActivity(state,{
        type:'feishu_diary_ignored',
        inboxId:itemId,
        text:`忽略飞书日记内容（飞书原文不变）：${compactText(current.text,80)}`
      });
      return{message:'已从工作台忽略这条内容；飞书原文保持不变。'};
    });
  }
  return baseProcessInbox({store,itemId,command,targetProjectId});
}

export { localIgnoreCommand };
