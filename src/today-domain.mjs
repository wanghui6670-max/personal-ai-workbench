import { addActivity } from './store.mjs';
import { todayIso } from './utils.mjs';

function domainError(message,{statusCode=400,code='INVALID_REQUEST'}={}){
  return Object.assign(new Error(message),{statusCode,code});
}

/**
 * Human-owned today planning boundary.
 *
 * A completed todo may be inspected or restored, but it cannot be added to the
 * current day. Keeping this guard in the domain layer protects REST, browser AI
 * and MCP callers even when a planner proposes an invalid operation.
 */
export async function setToday({store,todoId,add}){
  if(typeof todoId!=='string'||!todoId.trim()){
    throw domainError('todoId 必须是非空字符串。');
  }
  if(typeof add!=='boolean'){
    throw domainError('add 必须是布尔值。');
  }

  return store.updateState(state=>{
    const todo=state.todos.find(candidate=>candidate.id===todoId);
    if(!todo){
      throw domainError('待办不存在。',{statusCode:404,code:'TODO_NOT_FOUND'});
    }
    if(add&&todo.done){
      throw domainError('已完成待办不能加入今日工作台。请先恢复为未完成，再由你决定是否加入今日。',{statusCode:409,code:'TODO_ALREADY_COMPLETED'});
    }

    const date=todayIso();
    if(state.todayPlanDate!==date){
      state.todayPlan=[];
      state.todayPlanDate=date;
    }

    const existed=state.todayPlan.includes(todoId);
    if(add&&!existed)state.todayPlan.push(todoId);
    if(!add&&existed)state.todayPlan=state.todayPlan.filter(id=>id!==todoId);

    if(existed!==add){
      addActivity(state,{
        type:add?'today_added':'today_removed',
        todoId,
        text:`${add?'加入':'移出'}今日工作台：「${todo.title}」`
      });
    }
    return state.todayPlan;
  });
}
