import test from 'node:test';
import assert from 'node:assert/strict';
import {createGetnoteNoteClient,parseGetnoteNoteDetail,selectGetnoteRawContent} from '../src/getnote-note-client.mjs';

test('GetNote note detail selects the real raw field instead of AI summary content',()=>{
  const web=parseGetnoteNoteDetail({success:true,data:{note_id:'web-1',title:'网页',note_type:'LINK',content:'AI 摘要',web_content:'网页原文',created_at:'2026-08-15T01:00:00Z'}});
  assert.equal(web.noteId,'web-1');
  assert.equal(web.sourceField,'web_content');
  assert.equal(web.content,'网页原文');

  const audio=parseGetnoteNoteDetail({success:true,data:{note_id:'audio-1',title:'录音',note_type:'MEETING',content:'AI 总结',audio_original:'逐字转写原文'}});
  assert.equal(audio.sourceField,'audio_original');
  assert.equal(audio.content,'逐字转写原文');

  const text=parseGetnoteNoteDetail({success:true,data:{note_id:'text-1',title:'文字',note_type:'TEXT',content:'我自己记下来的原文'}});
  assert.equal(text.sourceField,'content');
  assert.equal(text.content,'我自己记下来的原文');
});

test('audio/link/blog-like notes fail closed when their real raw field is unavailable',()=>{
  assert.throws(()=>selectGetnoteRawContent({noteType:'MEETING',content:'只有总结'}),error=>error.code==='GETNOTE_RAW_CONTENT_UNAVAILABLE');
  assert.throws(()=>selectGetnoteRawContent({noteType:'LINK',content:'只有总结'}),error=>error.code==='GETNOTE_RAW_CONTENT_UNAVAILABLE');
  assert.throws(()=>selectGetnoteRawContent({noteType:'BLOGGER',content:'只有总结'}),error=>error.code==='GETNOTE_RAW_CONTENT_UNAVAILABLE');
});

test('GetNote note reader uses only the fixed read-only detail command and preserves string IDs',async()=>{
  const calls=[];
  const client=createGetnoteNoteClient({exec:async(command,args)=>{
    calls.push([command,...args]);
    return{stdout:JSON.stringify({success:true,data:{note_id:'1896830231705320746',title:'产品周会',note_type:'MEETING',audio_original:'这是会议逐字稿',content:'AI 总结'}})};
  }});
  const note=await client.fetch('1896830231705320746');
  assert.deepEqual(calls,[['getnote','note','1896830231705320746','-o','json']]);
  assert.equal(note.noteId,'1896830231705320746');
  assert.equal(note.sourceField,'audio_original');
});

test('GetNote note reader rejects empty, failed and oversized source content',async()=>{
  assert.throws(()=>parseGetnoteNoteDetail({success:false,message:'denied'}),/denied/);
  assert.throws(()=>parseGetnoteNoteDetail({success:true,data:{note_id:'n1',note_type:'TEXT',content:''}}),error=>error.code==='GETNOTE_RAW_CONTENT_UNAVAILABLE');
  assert.throws(()=>parseGetnoteNoteDetail({success:true,data:{note_id:'n1',note_type:'TEXT',content:'x'.repeat(120001)}}),error=>error.code==='GETNOTE_NOTE_TOO_LARGE');
});
