import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLocalCalendar, writeLocalCalendar } from '../src/local-calendar.mjs';

const tasks=[
  {externalId:'a',title:'全天截止任务',dueDate:'2026-08-20',dueAt:'2026-08-20',done:false,content:'',sourceNoteId:'n1',sourceNoteTitle:'产品周会'},
  {externalId:'b',title:'明确时段任务',dueDate:'2026-08-21',startAt:'2026-08-21T09:00:00+08:00',dueAt:'2026-08-21T10:30:00+08:00',allDay:false,done:false,content:'会议',sourceNoteId:'n2',sourceNoteTitle:'排期会'},
  {externalId:'instant',title:'只有截止时刻',dueDate:'2026-08-22',startAt:null,dueAt:'2026-08-22T18:30:00+08:00',allDay:false,done:false,content:'',sourceNoteId:'n3',sourceNoteTitle:'客户会'},
  {externalId:'e',title:'带时间戳的全天任务',dueDate:'2026-08-23',startAt:'2026-08-23T00:00:00+08:00',dueAt:'2026-08-23T23:59:00+08:00',allDay:true,done:false,content:''},
  {externalId:'c',title:'已完成任务',dueDate:'2026-08-24',done:true},
  {externalId:'d',title:'无截止任务',dueDate:null,done:false}
];

test('local calendar mirrors only explicit GetNote dates and never invents duration',()=>{
  const ics=buildLocalCalendar(tasks,{calendarName:'测试日历',generatedAt:new Date('2026-08-14T00:00:00Z')});
  assert.match(ics,/PRODID:-\/\/Personal AI Workbench\/\/GetNote CLI Calendar/);
  assert.match(ics,/X-WR-CALNAME:测试日历/);
  assert.match(ics,/DTSTART;VALUE=DATE:20260820/);
  assert.match(ics,/DTEND;VALUE=DATE:20260821/);
  assert.match(ics,/DTSTART:20260821T010000Z/);
  assert.match(ics,/DTEND:20260821T023000Z/);
  assert.match(ics,/DTSTART:20260822T103000Z/);
  assert.doesNotMatch(ics,/DTEND:20260822/);
  assert.match(ics,/来源：得到大脑 CLI/);
  assert.match(ics,/来源笔记：产品周会/);
  assert.match(ics,/DTSTART;VALUE=DATE:20260823/);
  assert.doesNotMatch(ics,/已完成任务|无截止任务/);
  assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,4);
});

test('local calendar writes one fixed private ICS file under the workbench data directory',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-calendar-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const result=await writeLocalCalendar({store:{dataDir:root},tasks,calendarName:'测试日历'});
  assert.equal(result.eventCount,4);
  assert.equal(result.path,path.join(root,'calendar','personal-ai-workbench.ics'));
  const stat=await fsp.stat(result.path);
  assert.equal(stat.mode&0o777,0o600);
});
