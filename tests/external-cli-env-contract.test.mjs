import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('all GetNote and Lark child-process paths apply the shared environment isolation policy',async()=>{
  const [runtime,dailyJournal,legacyFeishu,doctor]=await Promise.all([
    read('src/getnote-runtime.mjs'),
    read('src/feishu-daily-journal.mjs'),
    read('src/feishu.mjs'),
    read('scripts/doctor.mjs')
  ]);
  assert.match(runtime,/getnoteCliEnv\(processEnv\)/);
  assert.doesNotMatch(runtime,/env:\s*\{\s*\.\.\.processEnv\s*\}/);

  assert.match(dailyJournal,/larkCliEnv\(processEnv\)/);
  assert.match(legacyFeishu,/larkCliEnv\(process\.env\)/);

  assert.match(doctor,/env:getnoteCliEnv\(process\.env\)/);
  assert.match(doctor,/env:larkCliEnv\(process\.env\)/);
  assert.doesNotMatch(doctor,/getnote[^\n]{0,200}env:\s*\{\s*\.\.\.process\.env\s*\}/s);
});
