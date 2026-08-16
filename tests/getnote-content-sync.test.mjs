import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/store.mjs';
import {readGetnoteContentStatus,syncGetnoteContent} from '../src/getnote-content-sync.mjs';

function fakeReader(records){
  return{
    status(){return{mode:'test',readOnly:true};},
    async listNotes(){return{data:{notes:[...records.values()].map(note=>({note_id:note.note_id,title:note.title,note_type:note.note_type,created_at:note.created_at,updated_at:note.updated_at})),has_more:false,cursor:null}};},
    async fetchNote(noteId){return{data:{note:{...records.get(noteId)}}};}
  };
}

test('GetNote content sync creates self-media business and local markdown without touching tasks',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-getnote-content-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));await store.ensure();
  const before=await store.readState();
  const records=new Map([
    ['n1',{note_id:'n1',title:'品牌选题灵感',note_type:'TEXT',created_at:'2026-08-15T08:00:00+08:00',updated_at:'2026-08-15T09:00:00+08:00',content:'第一版内容'}],
    ['n2',{note_id:'n2',title:'门店 Vlog 素材',note_type:'TEXT',created_at:'2026-08-16T08:00:00+08:00',updated_at:'2026-08-16T09:00:00+08:00',content:'第二条内容'}]
  ]);
  const reader=fakeReader(records);
  const first=await syncGetnoteContent({appRoot:root,store,limit:20,reader});
  assert.equal(first.created,2);assert.equal(first.updated,0);assert.equal(first.failed,0);
  assert.match(first.directory,/自媒体/);assert.match(first.directory,/得到大脑内容/);
  const config=await store.readConfig();const media=config.businesses.find(item=>item.name==='自媒体');assert.ok(media);assert.equal(media.id,'biz_media');
  const files=(await fsp.readdir(first.directory)).filter(name=>name.endsWith('.md'));assert.equal(files.length,2);
  const content=await fsp.readFile(path.join(first.directory,files[0]),'utf8');assert.match(content,/source: "getnote"/);assert.match(content,/source_note_id:/);
  const after=await store.readState();assert.deepEqual(after.todos,before.todos);assert.deepEqual(after.inbox,before.inbox);

  const originalNames=[...files].sort();records.get('n1').content='第一版内容（已更新）';records.get('n1').updated_at='2026-08-16T10:00:00+08:00';
  const second=await syncGetnoteContent({appRoot:root,store,limit:20,reader});assert.equal(second.created,0);assert.equal(second.updated,1);assert.equal(second.skipped,1);
  const secondNames=(await fsp.readdir(second.directory)).filter(name=>name.endsWith('.md')).sort();assert.deepEqual(secondNames,originalNames,'updated notes keep stable filenames');
  const status=await readGetnoteContentStatus({appRoot:root,store});assert.equal(status.configured,true);assert.equal(status.noteCount,2);assert.equal(status.business.name,'自媒体');
});

test('GetNote content sync fails closed per note when true raw content is unavailable',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-getnote-content-raw-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(path.join(root,'data'));await store.ensure();
  const records=new Map([['meeting-1',{note_id:'meeting-1',title:'会议摘要',note_type:'MEETING',created_at:'2026-08-16T08:00:00+08:00',updated_at:'2026-08-16T09:00:00+08:00',content:'这是 AI 摘要，不是真实录音原文'}]]);
  const result=await syncGetnoteContent({appRoot:root,store,limit:10,reader:fakeReader(records)});
  assert.equal(result.created,0);assert.equal(result.failed,1);assert.match(result.errors[0].message,/audio_original|原文/);
  const state=await store.readState();assert.equal(state.todos.length,0);assert.equal(state.inbox.length,0);
});
