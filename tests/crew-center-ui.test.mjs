import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('crew center is wired as a read-only authenticated catalog surface',async()=>{
  const [html,source,server,catalog]=await Promise.all([
    fsp.readFile('public/index.html','utf8'),
    fsp.readFile('public/crew-center.js','utf8'),
    fsp.readFile('src/server.mjs','utf8'),
    fsp.readFile('src/crew-catalog.mjs','utf8')
  ]);
  assert.match(html,/crew-center\.css/);
  assert.match(html,/crew-center\.js/);
  assert.match(source,/json\(['"]\/api\/crew['"]\)/);
  assert.doesNotMatch(source,/method:\s*['"](?:POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(source,/document\.cookie|indexedDB/);
  assert.doesNotMatch(source,/process\.env|LARK_|FEISHU_|OPENAI_API_KEY/);
  const authGate=server.indexOf("if(pathname.startsWith('/api/')&&!isAuthenticated(req, storeAdapter))")>=0
    ?server.indexOf("if(pathname.startsWith('/api/')&&!isAuthenticated(req, storeAdapter))")
    :server.indexOf("if(pathname.startsWith('/api/')&&!isAuthenticated(req))");
  assert.ok(authGate>=0,'必须存在 API 登录门');
  const crewRoute=server.indexOf("if(pathname==='/api/crew'&&req.method==='GET')");
  assert.ok(crewRoute>authGate,'Crew API 必须位于现有登录门之后');
  assert.match(server.slice(crewRoute,crewRoute+240),/rateLimited\(req,res,'crew'\)/);
  assert.doesNotMatch(catalog,/registerCrewCatalogRoutes/);
});

test('crew center escapes catalog fields and does not hard-code a runtime version',async()=>{
  const [source,catalog]=await Promise.all([
    fsp.readFile('public/crew-center.js','utf8'),
    fsp.readFile('src/crew-catalog.mjs','utf8')
  ]);
  assert.match(source,/const esc=/);
  assert.match(source,/const attr=esc/);
  assert.match(source,/\$\{esc\(a\.name\)\}/);
  assert.match(source,/\$\{esc\(s\.name\)\}/);
  assert.match(source,/data-path="\$\{attr\(a\.path\)\}"/);
  assert.match(source,/data-path="\$\{attr\(s\.path\)\}"/);
  assert.match(source,/SAFE_AGENT_ID/);
  assert.match(source,/shellQuote/);
  assert.doesNotMatch(source,/0\.1\.0-rc\.6/);
  assert.doesNotMatch(catalog,/\/Users\/wanghui/);
});
