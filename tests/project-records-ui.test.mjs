import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.');

test('project page loads Feishu records through the bounded MCP read tool without browser persistence',async()=>{
  const [html,script]=await Promise.all([
    fsp.readFile(path.join(root,'public','index.html'),'utf8'),
    fsp.readFile(path.join(root,'public','project-records.js'),'utf8')
  ]);
  assert.match(html,/project-records\.css/);
  assert.match(html,/project-records\.js/);
  assert.match(script,/name:'project_records_read'/);
  assert.match(script,/limit:PAGE_SIZE/);
  assert.match(script,/beforeBlockId/);
  assert.match(script,/\/api\/mcp/);
  assert.match(script,/textContent/);
  assert.match(script,/if\(document\.getElementById\(PANEL_ID\)\)return;/);
  assert.doesNotMatch(script,/if\(existing\)\{renderRecords\(\);return;\}/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(script,/innerHTML\s*=/);
});

test('project record browser link is restricted to official HTTPS Feishu or Lark document hosts',async()=>{
  const script=await fsp.readFile(path.join(root,'public','project-records.js'),'utf8');
  assert.match(script,/url\.protocol==='https:'/);
  assert.match(script,/feishu\.cn/);
  assert.match(script,/larksuite\.com/);
  assert.match(script,/larkoffice\.com/);
  assert.match(script,/noopener noreferrer/);
});
