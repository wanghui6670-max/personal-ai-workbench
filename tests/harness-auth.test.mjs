import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessBridgeAuthorized,harnessBridgeBaseUrl,isLocalHarnessTransport,isLoopbackAddress } from '../src/harness-auth.mjs';

function request({remote='127.0.0.1',local='127.0.0.1',authorization='' }={}){
  return{socket:{remoteAddress:remote,localAddress:local},headers:{authorization}};
}

test('Harness bridge requires a strong token and a local transport',()=>{
  const token='x'.repeat(43);
  assert.equal(harnessBridgeAuthorized(request({authorization:`Bearer ${token}`}),token),true);
  assert.equal(harnessBridgeAuthorized(request({authorization:'Bearer wrong'}),token),false);
  assert.equal(harnessBridgeAuthorized(request({remote:'203.0.113.10',local:'10.0.0.2',authorization:`Bearer ${token}`}),token),false);
  assert.equal(harnessBridgeAuthorized(request({remote:'10.0.0.2',local:'10.0.0.2',authorization:`Bearer ${token}`}),token),true,'same-host concrete bind remains usable');
  assert.equal(harnessBridgeAuthorized(request({authorization:`Bearer ${'x'.repeat(20)}`}), 'x'.repeat(20)),false,'weak bridge tokens fail closed');
});

test('address helpers cover IPv4 and IPv6 loopback without opening remote access',()=>{
  assert.equal(isLoopbackAddress('127.0.0.9'),true);
  assert.equal(isLoopbackAddress('::1'),true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'),true);
  assert.equal(isLoopbackAddress('10.0.0.2'),false);
  assert.equal(isLocalHarnessTransport(request({remote:'::ffff:127.0.0.1',local:'::ffff:127.0.0.1'})),true);
  assert.equal(harnessBridgeBaseUrl('0.0.0.0',4173),'http://127.0.0.1:4173');
  assert.equal(harnessBridgeBaseUrl('::',4173),'http://[::1]:4173');
});
