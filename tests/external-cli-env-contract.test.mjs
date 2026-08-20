import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('all active GetNote and Lark child-process paths apply the shared environment isolation policy',async()=>{
  const [runtime,dailyJournal,legacyFeishu,doctor,envModule]=await Promise.all([
    read('src/getnote-runtime.mjs'),
    read('src/feishu-daily-journal.mjs'),
    read('src/feishu.mjs'),
    read('scripts/doctor.mjs'),
    read('src/env.mjs')
  ]);
  assert.match(runtime,/getnoteCliEnv\(processEnv\)/);
  assert.doesNotMatch(runtime,/env:\s*\{\s*\.\.\.processEnv\s*\}/);

  assert.match(dailyJournal,/larkCliEnv\(processEnv\)/);
  assert.match(legacyFeishu,/larkCliEnv\(process\.env\)/);

  assert.match(doctor,/env:larkCliEnv\(process\.env\)/);

  assert.doesNotMatch(envModule,/FEISHU_CLI_PATH/,'Workbench env must not expose an arbitrary Feishu binary path');
});
