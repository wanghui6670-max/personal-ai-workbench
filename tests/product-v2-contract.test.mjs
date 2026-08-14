import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';

const read=file=>fsp.readFile(new URL(`../${file}`,import.meta.url),'utf8');

test('product metadata, package, PWA and health source agree on v2',async()=>{
  const [pkgText,manifestText,server]=await Promise.all([read('package.json'),read('public/manifest.webmanifest'),read('src/server.mjs')]);
  const pkg=JSON.parse(pkgText);const manifest=JSON.parse(manifestText);
  assert.equal(PRODUCT_VERSION,'2.0.0');
  assert.equal(PRODUCT_DISPLAY_NAME,'动觉 AI 工作台');
  assert.equal(pkg.version,PRODUCT_VERSION);
  assert.equal(pkg.engines.node,'>=24');
  assert.equal(manifest.name,PRODUCT_DISPLAY_NAME);
  assert.match(server,/version:PRODUCT_VERSION/);
});
