import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCliClient, parseCliTasks } from '../src/task-cli.mjs';

test('task CLI parser accepts normalized TickTick envelopes and preserves explicit schedule',()=>{
  const tasks=parseCliTasks({data:{tasks:[{
    id:'task-1',project_id:'project-1',title:'准备周报',content:'汇总本周进展',status:0,status_label:'normal',
    start_local:'2026-08-14T09:00:00+08:00',due_local:'2026-08-14T10:00:00+08:00',
    is_all_day:false,time_zone:'Asia/Shanghai',priority:3,tags:['工作']
  }]}});
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].externalId,'task-1');
  assert.equal(tasks[0].externalProjectId,'project-1');
  assert.equal(tasks[0].title,'准备周报');
  assert.equal(tasks[0].dueDate,'2026-08-14');
  assert.equal(tasks[0].startAt,'2026-08-14T09:00:00+08:00');
  assert.equal(tasks[0].dueAt,'2026-08-14T10:00:00+08:00');
  assert.equal(tasks[0].done,false);
});

test('task CLI client uses a fixed command allowlist and treats completed history as optional',async()=>{
  const calls=[];
  const exec=async(command,args)=>{
    calls.push([command,...args]);
    if(args[0]==='sync')return{stdout:'{"sync":{"ok":true}}'};
    if(args[1]==='list')return{stdout:'{"tasks":[{"id":"a","title":"有截止","due_date":"2026-08-20","status":0}]}'};
    const error=new Error('completed endpoint unavailable');error.code='EFAIL';throw error;
  };
  const result=await createTaskCliClient({exec}).fetch({cliFlavor:'ticktick'});
  assert.deepEqual(calls[0],['ticktick','sync','--json']);
  assert.deepEqual(calls[1],['ticktick','tasks','list','--json']);
  assert.deepEqual(calls[2],['ticktick','tasks','completed','--json']);
  assert.equal(result.active.length,1);
  assert.equal(result.completedAvailable,false);
  assert.match(result.completedWarning,/读取已完成待办失败/);
});
