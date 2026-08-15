import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHarnessWebUrl, HarnessNavigatorRuntime } from '../src/harness-navigator.mjs';
import { securityHeaders } from '../src/http.mjs';

test('resolveHarnessWebUrl 只接受 loopback http(s) URL',()=>{
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://127.0.0.1:3080/'}),'http://127.0.0.1:3080/');
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://localhost:3080/'}),'http://localhost:3080/');
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'https://evil.example.com/'}),null);
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'http://192.168.1.5:3080/'}),null);
  assert.equal(resolveHarnessWebUrl({HARNESS_WEB_URL:'not-a-url'}),null);
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
  assert.match(withFrame['Content-Security-Policy'],/frame-src http:\/\/127\.0\.0\.1:3080/);
});
