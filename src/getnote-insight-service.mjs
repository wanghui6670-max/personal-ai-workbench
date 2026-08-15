import {createGetnoteNoteClient} from './getnote-note-client.mjs';
import {analyzeGetnoteNote} from './getnote-insight-parser.mjs';

export async function analyzeGetnoteNoteById({noteId,store,noteClient=createGetnoteNoteClient(),...parserOptions}={}){
  if(!noteClient||typeof noteClient.fetch!=='function')throw new TypeError('GetNote note client 不可用。');
  const note=await noteClient.fetch(noteId);
  return analyzeGetnoteNote({note,store,...parserOptions});
}
