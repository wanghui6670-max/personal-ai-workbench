import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_VERSION,
  HARNESS_UI_MODE_EMBEDDED_EXPERIMENTAL,
  HarnessNavigatorRuntime,
  resolveHarnessWebConfig,
  resolveHarnessWebUrl
} from '../src/harness-navigator.mjs';
import {
  HARNESS_COMPOSITION_ID,
  HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256
} from '../src/harness-policy.mjs';
import { securityHeaders } from '../src/http.mjs';

test('Workbench 受控面板是默认 Harness UI，普通 webUrl 不会自动接管',()=>{
  assert.equal(resolveHarnessWebUrl({HARNESS_ENABLED:'1',HARNESS_WEB_URL:'http://127.0.0.1:3080/'}),null);
  assert.equal(resolveHarnessWebConfig({HARNESS_ENABLED:'1'}).uiMode,'workbench');
});

test('实验嵌入只接受显式配置、同源 loopback URL 和 attestation URL',()=>{
  const base={
    HARNESS_ENABLED:'1',
    HARNESS_UI_MODE:HARNESS_UI_MODE_EMBEDDED_EXPERIMENTAL,
    HARNESS_WEB_URL:'http://127.0.0.1:3080/',
    HARNESS_WEB_ATTESTATION_URL:'http://127.0.0.1:3080/.well-known/workbench-harness.json'
  };
  assert.equal(resolveHarnessWebUrl(base),'http://127.0.0.1:3080/');
  assert.equal(resolveHarnessWebUrl({...base,HARNESS_WEB_URL:'https://evil.example.com/'}),null);
  assert.equal(resolveHarnessWebUrl({...base,HARNESS_WEB_URL:'http://192.168.1.5:3080/'}),null);
  assert.equal(resolveHarnessWebUrl({...base,HARNESS_WEB_URL:'http://user:pass@127.0.0.1:3080/'}),null);
  assert.equal(resolveHarnessWebUrl({...base,HARNESS_WEB_ATTESTATION_URL:'http://localhost:3080/health'}),null);
  assert.equal(resolveHarnessWebUrl({...base,HARNESS_WEB_URL:'http://127.0.0.1:3080/?x=1'}),null);
});

test('status 只在 Composition、工具目录和 Harness 版本 attestation 全部匹配后下发 webUrl',async()=>{
  const env={
    HARNESS_ENABLED:'1',
    HARNESS_UI_MODE:HARNESS_UI_MODE_EMBEDDED_EXPERIMENTAL,
    HARNESS_WEB_URL:'http://127.0.0.1:3080/',
    HARNESS_WEB_ATTESTATION_URL:'http://127.0.0.1:3080/.well-known/workbench-harness.json'
  };
  const runtime=new HarnessNavigatorRuntime({
    appRoot:process.cwd(),
    bridgeUrl:'http://127.0.0.1:8080',
    env,
    fetchImpl:async()=>new Response(JSON.stringify({
      ok:true,
      compositionId:HARNESS_COMPOSITION_ID,
      toolCatalogHash:HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256,
      harnessVersion:HARNESS_VERSION
    }),{status:200,headers:{'content-type':'application/json'}})
  });
  const before=runtime.status();
  assert.equal(before.webUrl,null);
  assert.equal(before.embeddedWeb.verified,false);
  const checked=await runtime.checkedStatus();
  assert.equal(checked.uiMode,HARNESS_UI_MODE_EMBEDDED_EXPERIMENTAL);
  assert.equal(checked.embeddedWeb.verified,true);
  assert.equal(checked.webUrl,'http://127.0.0.1:3080/');
  await runtime.close();
});

test('attestation 不匹配时安全回退到 Workbench 面板',async()=>{
  const runtime=new HarnessNavigatorRuntime({
    appRoot:process.cwd(),
    bridgeUrl:'http://127.0.0.1:8080',
    env:{
      HARNESS_ENABLED:'1',
      HARNESS_UI_MODE:HARNESS_UI_MODE_EMBEDDED_EXPERIMENTAL,
      HARNESS_WEB_URL:'http://127.0.0.1:3080/',
      HARNESS_WEB_ATTESTATION_URL:'http://127.0.0.1:3080/attestation'
    },
    fetchImpl:async()=>new Response(JSON.stringify({
      ok:true,
      compositionId:'unreviewed-composition',
      toolCatalogHash:HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256,
      harnessVersion:HARNESS_VERSION
    }),{status:200})
  });
  const checked=await runtime.checkedStatus();
  assert.equal(checked.webUrl,null);
  assert.equal(checked.embeddedWeb.verified,false);
  assert.equal(checked.embeddedWeb.reason,'composition_mismatch');
  await runtime.close();
});

test('CSP 只允许加载已配置 iframe，Workbench 本身始终拒绝任意站点嵌入',()=>{
  const base=securityHeaders({});
  assert.match(base['Content-Security-Policy'],/frame-src 'self'/);
  assert.match(base['Content-Security-Policy'],/frame-ancestors 'none'/);
  assert.equal(base['X-Frame-Options'],'DENY');
  const withFrame=securityHeaders({frameSrc:'http://127.0.0.1:3080'});
  assert.match(withFrame['Content-Security-Policy'],/frame-src 'self' http:\/\/127\.0\.0\.1:3080/);
  const ignoredOverride=securityHeaders({allowAnyFrame:true});
  assert.doesNotMatch(ignoredOverride['Content-Security-Policy'],/frame-ancestors \*/);
  assert.equal(ignoredOverride['X-Frame-Options'],'DENY');
});
