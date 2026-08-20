import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.');

test('project route overlays a five-chapter knowledge index without rewriting the v3 kernel',async()=>{
  const [html,script]=await Promise.all([
    fsp.readFile(path.join(root,'public','index.html'),'utf8'),
    fsp.readFile(path.join(root,'public','project-knowledge.js'),'utf8')
  ]);
  assert.match(html,/project-knowledge\.css/);
  assert.match(html,/project-knowledge\.js/);
  assert.ok(html.indexOf('/project-knowledge.js')>html.indexOf('/project-records.js'));
  assert.match(script,/资产盘点/);
  assert.match(script,/飞书记录/);
  assert.match(script,/待办与卡点/);
  assert.match(script,/本地 Git/);
  assert.match(script,/约束/);
  assert.match(script,/返回工作台/);
  assert.match(script,/data-pk-chapter/);
  assert.match(script,/#project\/([^/]+)/);
  assert.match(script,/href="#today"/);
  assert.match(script,/closest\(['"]\.sidebar['"]\)/);
  assert.match(script,/insertBefore/);
  assert.doesNotMatch(script,/nav\.prepend/);
  assert.doesNotMatch(script,/await resolveProject[\s\S]{0,240}insertBefore/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(script,/innerHTML\s*=/);
  assert.doesNotMatch(script,/diary_extract_todos|planDiaryReviewAI/);
});

test('project knowledge overlay keeps official Feishu hosts and does not persist record bodies',async()=>{
  const script=await fsp.readFile(path.join(root,'public','project-knowledge.js'),'utf8');
  assert.doesNotMatch(script,/readProjectRecords|project_records_read|project_summary_append/);
  assert.doesNotMatch(script,/Evidence|chainOfThought|workingMemory/);
  assert.match(script,/\/api\/state/);
});

test('hydrate chips render pointer-only live facts on the project surface',async()=>{
  const [script,css]=await Promise.all([
    fsp.readFile(path.join(root,'public','project-knowledge.js'),'utf8'),
    fsp.readFile(path.join(root,'public','project-knowledge.css'),'utf8')
  ]);
  assert.match(script,/data-pk-chip="project"/);
  assert.match(script,/data-pk-chip="live"/);
  assert.match(script,/data-pk-chip="git"/);
  assert.match(script,/data-pk-chip="feishu"/);
  assert.match(script,/data-pk-chip="capability"/);
  assert.match(script,/\/api\/harness\/status/);
  assert.match(script,/capabilityMode/);
  assert.match(css,/pk-chip/);
  assert.doesNotMatch(script,/resultSummary|checkpoint\.facts|records\.text/);
});
