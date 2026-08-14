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

test('meeting todos become stable tasks and only explicit dates are scheduled',()=>{
  const note={noteId:'note-1',title:'产品周会',updatedAt:'2026-08-14T02:00:00Z',noteUrl:'https://www.biji.com/note/note-1'};
  const payload={success:true,data:{note_id:'note-1',title:'产品周会',meeting_todos:{source:'summary_section',items:[
    {text:'8月20日下午3点前提交周报',completed:false},
    {text:'确认下一版预算',completed:false},
    {text:'今天 18:30 回复客户',completed:true}
  ]}}};
  const first=parseMeetingTodos(payload,note);
  const second=parseMeetingTodos(payload,note);
  assert.deepEqual(first.map(item=>item.externalId),second.map(item=>item.externalId));
  assert.equal(first[0].dueDate,'2026-08-20');
  assert.equal(first[0].dueAt,'2026-08-20T15:00:00');
  assert.equal(first[0].sourceNoteId,'note-1');
  assert.equal(first[1].dueDate,null);
  assert.equal(first[2].dueDate,'2026-08-14');
  assert.equal(first[2].done,true);
  assert.deepEqual(parseTodoSchedule('下周找他确认',{referenceDate:'2026-08-14'}),{dueDate:null,dueAt:null,startAt:null,allDay:true,timeZone:null});
});

test('GetNote client uses only fixed getnote read commands and paginates recent notes',async()=>{
  const calls=[];
  const exec=async(command,args)=>{
    calls.push([command,...args]);
    if(args[0]==='notes'&&!args.includes('--cursor'))return{stdout:JSON.stringify({success:true,data:{notes:[{note_id:'n1',title:'周会一',updated_at:'2026-08-14T00:00:00Z'}],has_more:true,cursor:'cursor-1'}})};
    if(args[0]==='notes')return{stdout:JSON.stringify({success:true,data:{notes:[{note_id:'n2',title:'周会二',updated_at:'2026-08-14T00:00:00Z'}],has_more:false}})};
    if(args[0]==='note'&&args[2]==='n1')return{stdout:JSON.stringify({success:true,data:{note_id:'n1',title:'周会一',meeting_todos:{source:'summary',items:[{text:'2026-08-20 提交方案',completed:false}]}}})};
    if(args[0]==='note'&&args[2]==='n2')return{stdout:JSON.stringify({success:true,data:{note_id:'n2',title:'周会二',meeting_todos:{source:'summary',items:[]}}})};
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  const result=await createTaskCliClient({exec}).fetch({noteLimit:20});
  assert.deepEqual(calls,[
    ['getnote','notes','--limit','20','-o','json'],
    ['getnote','notes','--limit','19','--cursor','cursor-1','-o','json'],
    ['getnote','note','todos','n1','-o','json'],
    ['getnote','note','todos','n2','-o','json']
  ]);
  assert.equal(result.provider,'getnote_cli');
  assert.equal(result.noteCount,2);
  assert.equal(result.todoCount,1);
  assert.equal(result.active[0].sourceNoteTitle,'周会一');
});
