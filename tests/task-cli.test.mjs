import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCliClient, parseNotesPage, parseMeetingTodos, parseTodoSchedule, getnoteDateOnlyInTimeZone } from '../src/task-cli.mjs';

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

test('meeting todos use text fingerprints, anchor relative dates to note creation, and carry timezone',()=>{
  const note={noteId:'note-1',title:'产品周会',createdAt:'2026-08-10T02:00:00Z',updatedAt:'2026-08-14T02:00:00Z',noteUrl:'https://www.biji.com/note/note-1'};
  const payload={success:true,data:{note_id:'note-1',title:'产品周会',meeting_todos:{source:'summary_section',items:[
    {text:'8月20日下午3点前提交周报',completed:false},
    {text:'确认下一版预算',completed:false},
    {text:'今天 18:30 回复客户',completed:true}
  ]}}};
  const first=parseMeetingTodos(payload,note,{timeZone:'Asia/Shanghai'});
  const repeated=parseMeetingTodos(payload,note,{timeZone:'Asia/Shanghai'});
  const renamed=parseMeetingTodos({success:true,data:{note_id:'note-1',meeting_todos:{items:[{text:'8月20日下午3点前提交最终周报',completed:false}]}}},note,{timeZone:'Asia/Shanghai'});
  assert.equal(first[0].externalId,repeated[0].externalId,'same note + same text keeps the fingerprint stable');
  assert.notEqual(first[0].externalId,renamed[0].externalId,'current GetNote schema has no per-todo id, so a text edit changes the raw fingerprint');
  assert.equal(first[0].externalIdentityKind,'text_fingerprint');
  assert.equal(first[0].dueDate,'2026-08-20');
  assert.equal(first[0].dueAt,'2026-08-20T15:00:00');
  assert.equal(first[0].timeZone,'Asia/Shanghai');
  assert.equal(first[0].sourceNoteCreatedAt,'2026-08-10T02:00:00Z');
  assert.equal(first[1].dueDate,null);
  assert.equal(first[1].externalIdentityKind,'text_fingerprint');
  assert.equal(first[2].dueDate,'2026-08-10','relative 今天 uses meeting creation rather than later edit time');
  assert.equal(first[2].done,true);
  assert.equal(parseTodoSchedule('1月2日复盘',{referenceDate:'2026-08-14',timeZone:'Asia/Shanghai'}).dueDate,'2026-01-02');
  assert.deepEqual(parseTodoSchedule('下周找他确认',{referenceDate:'2026-08-14',timeZone:'Asia/Shanghai'}),{dueDate:null,dueAt:null,startAt:null,allDay:true,timeZone:'Asia/Shanghai'});
});

test('GetNote day boundary follows configured IANA timezone instead of host timezone',()=>{
  const instant=new Date('2026-08-15T16:30:00.000Z');
  assert.equal(getnoteDateOnlyInTimeZone(instant,'Asia/Shanghai'),'2026-08-16');
  assert.equal(getnoteDateOnlyInTimeZone(instant,'America/Los_Angeles'),'2026-08-15');
});

test('unknown future item metadata does not silently replace the documented text fingerprint contract',()=>{
  const note={noteId:'note-future',title:'会议',createdAt:'2026-08-10T00:00:00Z'};
  const a=parseMeetingTodos({success:true,data:{note_id:'note-future',meeting_todos:{items:[{id:'one',text:'确认预算',completed:false}]}}},note);
  const b=parseMeetingTodos({success:true,data:{note_id:'note-future',meeting_todos:{items:[{id:'two',text:'确认预算',completed:false}]}}},note);
  assert.equal(a[0].externalId,b[0].externalId,'an undocumented id field must not silently change identity semantics');
});

test('duplicate same-text todos use occurrence order to remain distinct',()=>{
  const note={noteId:'note-duplicate',title:'会议',createdAt:'2026-08-10T00:00:00Z'};
  const tasks=parseMeetingTodos({success:true,data:{note_id:'note-duplicate',meeting_todos:{items:[
    {text:'确认预算',completed:false},{text:'确认预算',completed:false}
  ]}}},note);
  assert.equal(tasks.length,2);
  assert.notEqual(tasks[0].externalId,tasks[1].externalId);
});

test('GetNote client reads recent notes plus unresolved tracked old notes with fixed read commands',async()=>{
  const calls=[];
  const exec=async(command,args)=>{
    calls.push([command,...args]);
    if(args[0]==='notes')return{stdout:JSON.stringify({success:true,data:{notes:[{note_id:'n1',title:'最近周会',created_at:'2026-08-14T00:00:00Z',updated_at:'2026-08-14T00:00:00Z'}],has_more:false}})};
    if(args[0]==='note'&&args[2]==='n1')return{stdout:JSON.stringify({success:true,data:{note_id:'n1',title:'最近周会',meeting_todos:{source:'summary',items:[{text:'2026-08-20 提交方案',completed:false}]}}})};
    if(args[0]==='note'&&args[2]==='old-note')return{stdout:JSON.stringify({success:true,data:{note_id:'old-note',title:'旧会议',meeting_todos:{source:'summary',items:[{text:'今天 完成旧事项',completed:true}]}}})};
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
