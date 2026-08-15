import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCliClient, parseNotesPage, parseMeetingTodos, parseTodoSchedule } from '../src/task-cli.mjs';

test('GetNote notes parser preserves string note IDs and pagination metadata',()=>{
  const page=parseNotesPage({success:true,data:{notes:[{
    id:'1896830231705320746',note_id:'1896830231705320746',title:'产品周会',note_type:'MEETING',
    created_at:'2026-08-14T01:00:00Z',updated_at:'2026-08-14T02:00:00Z',note_url:'https://www.biji.com/note/1896830231705320746'
  }],has_more:true,cursor:'1896830231705320746'}});
  assert.equal(page.notes[0].noteId,'1896830231705320746');
  assert.equal(page.notes[0].title,'产品周会');
  assert.equal(page.hasMore,true);
  assert.equal(page.cursor,'1896830231705320746');
});

test('meeting todos prefer source todo ids, anchor relative dates to note creation, and carry timezone',()=>{
  const note={noteId:'note-1',title:'产品周会',createdAt:'2026-08-10T02:00:00Z',updatedAt:'2026-08-14T02:00:00Z',noteUrl:'https://www.biji.com/note/note-1'};
  const payload={success:true,data:{note_id:'note-1',title:'产品周会',meeting_todos:{source:'summary_section',items:[
    {id:'todo-source-1',text:'8月20日下午3点前提交周报',completed:false},
    {text:'确认下一版预算',completed:false},
    {id:'todo-source-3',text:'今天 18:30 回复客户',completed:true}
  ]}}};
  const first=parseMeetingTodos(payload,note,{timeZone:'Asia/Shanghai'});
  const renamed=parseMeetingTodos({success:true,data:{note_id:'note-1',meeting_todos:{items:[{id:'todo-source-1',text:'8月20日下午3点前提交最终周报',completed:false}]}}},note,{timeZone:'Asia/Shanghai'});
  assert.equal(first[0].externalId,renamed[0].externalId,'official source id survives text edits');
  assert.equal(first[0].sourceTodoId,'todo-source-1');
  assert.equal(first[0].identityKind,'source_id');
  assert.equal(first[0].dueDate,'2026-08-20');
  assert.equal(first[0].dueAt,'2026-08-20T15:00:00');
  assert.equal(first[0].timeZone,'Asia/Shanghai');
  assert.equal(first[0].sourceNoteCreatedAt,'2026-08-10T02:00:00Z');
  assert.equal(first[1].dueDate,null);
  assert.equal(first[1].identityKind,'fallback_text');
  assert.equal(first[2].dueDate,'2026-08-10','relative 今天 uses meeting creation rather than later edit time');
  assert.equal(first[2].done,true);
  assert.equal(parseTodoSchedule('1月2日复盘',{referenceDate:'2026-08-14',timeZone:'Asia/Shanghai'}).dueDate,'2026-01-02');
  assert.deepEqual(parseTodoSchedule('下周找他确认',{referenceDate:'2026-08-14',timeZone:'Asia/Shanghai'}),{dueDate:null,dueAt:null,startAt:null,allDay:true,timeZone:'Asia/Shanghai'});
});

test('GetNote client reads recent notes plus unresolved tracked old notes with fixed read commands',async()=>{
  const calls=[];
  const exec=async(command,args)=>{
    calls.push([command,...args]);
    if(args[0]==='notes')return{stdout:JSON.stringify({success:true,data:{notes:[{note_id:'n1',title:'最近周会',created_at:'2026-08-14T00:00:00Z',updated_at:'2026-08-14T00:00:00Z'}],has_more:false}})};
    if(args[0]==='note'&&args[2]==='n1')return{stdout:JSON.stringify({success:true,data:{note_id:'n1',title:'最近周会',meeting_todos:{source:'summary',items:[{id:'todo-1',text:'2026-08-20 提交方案',completed:false}]}}})};
    if(args[0]==='note'&&args[2]==='old-note')return{stdout:JSON.stringify({success:true,data:{note_id:'old-note',title:'旧会议',meeting_todos:{source:'summary',items:[{id:'old-todo',text:'今天 完成旧事项',completed:true}]}}})};
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  const result=await createTaskCliClient({exec}).fetch({
    noteLimit:20,timeZone:'Asia/Shanghai',
    trackedNotes:[{noteId:'old-note',title:'旧会议',createdAt:'2026-05-01T00:00:00Z',updatedAt:'2026-05-02T00:00:00Z'}]
  });
  assert.deepEqual(calls,[
    ['getnote','notes','--limit','20','-o','json'],
    ['getnote','note','todos','n1','-o','json'],
    ['getnote','note','todos','old-note','-o','json']
  ]);
  assert.equal(result.provider,'getnote_cli');
  assert.equal(result.recentNoteCount,1);
  assert.equal(result.trackedNoteCount,1);
  assert.equal(result.noteCount,2);
  assert.equal(result.todoCount,2);
  assert.equal(result.active[0].sourceNoteTitle,'最近周会');
  assert.equal(result.completed[0].sourceNoteId,'old-note');
  assert.equal(result.completed[0].dueDate,'2026-05-01');
});
