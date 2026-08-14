import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLocalCalendar, writeLocalCalendar } from '../src/local-calendar.mjs';

const tasks=[
  {externalId:'a',title:'全天截止任务',dueDate:'2026-08-20',dueAt:'2026-08-20',done:false,content:''},
  {externalId:'b',title:'明确时段任务',dueDate:'2026-08-21',startAt:'2026-08-21T09:00:00+08:00',dueAt:'2026-08-21T10:30:00+08:00',done:false,content:'会议'},
  {externalId:'c',title:'已完成任务',dueDate:'2026-08-22',done:true},
  {externalId:'d',title:'无截止任务',dueDate:null,done:false}
];

test('local calendar mirrors only explicit source dates and never invents a timed duration',()=>{
  const ics=buildLocalCalendar(tasks,{calendarName:'测试日历',generatedAt:new Date('2026-08-14T00:00:00Z')});
  assert.match(ics,/X-WR-CALNAME:测试日历/);
  assert.match(ics,/DTSTART;VALUE=DATE:20260820/);
  assert.match(ics,/DTEND;VALUE=DATE:20260821/);
  assert.match(ics,/DTSTART:20260821T010000Z/);
  assert.match(ics,/DTEND:20260821T023000Z/);
  assert.doesNotMatch(ics,/已完成任务|无截止任务/);
  assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,2);
});

test('local calendar writes one fixed private ICS file under the workbench data directory',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'paw-calendar-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const result=await writeLocalCalendar({store:{dataDir:root},tasks,calendarName:'测试日历'});
  assert.equal(result.eventCount,2);
  assert.equal(result.path,path.join(root,'calendar','personal-ai-workbench.ics'));
  const stat=await fsp.stat(result.path);
  assert.equal(stat.mode&0o777,0o600);
});
