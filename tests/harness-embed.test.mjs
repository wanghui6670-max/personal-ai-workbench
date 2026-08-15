import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { resolveHarnessWebUrl, HarnessNavigatorRuntime } from '../src/harness-navigator.mjs';
import { securityHeaders } from '../src/http.mjs';

test('resolveHarnessWebUrl 只接受 loopback http(s) URL',()=>{
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://127.0.0.1:3080/'}),'http://127.0.0.1:3080/');
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://localhost:3080/'}),'http://localhost:3080/');
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'https://evil.example.com/'}),null);
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://192.168.1.5:3080/'}),null);
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'not-a-url'}),null);
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://127.0.0.1:3080/?x=1'}),'http://127.0.0.1:3080/');
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://user:pass@127.0.0.1:3080/'}),null);
});

test('启用时 status 下发 webUrl',()=>{
  const runtime=new HarnessNavigatorRuntime({appRoot:process.cwd(),bridgeUrl:'http://127.0.0.1:8080',env:{HARNESS_ENABLED:'1',HARNESS_WEB_URL:'http://127.0.0.1:3080/'}});
  const status=runtime.status();
  assert.equal(status.enabled,true);
  assert.equal(status.webUrl,'http://127.0.0.1:3080/');
});

test('CSP 按 frameSrc 注入 frame-src 白名单',()=>{
  const base=securityHeaders({});
  assert.match(base['Content-Security-Policy'],/frame-src 'self'/);
  const withFrame=securityHeaders({frameSrc:'http://127.0.0.1:3080'});
  assert.match(withFrame['Content-Security-Policy'],/frame-src 'self' http:\/\/127\.0\.0\.1:3080/);
});

test('preview.html 允许被任意站点嵌入（安全头契约）',async()=>{
  const headers=securityHeaders({allowAnyFrame:true});
  assert.match(headers['Content-Security-Policy'],/frame-ancestors \*/);
  assert.equal('X-Frame-Options' in headers,false);
  const serverSource=await fsp.readFile('src/server.mjs','utf8');
  assert.match(serverSource,/pathname==='\/preview\.html'/);
  assert.match(serverSource,/allowAnyFrame/);
});
