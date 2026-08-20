import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from '../src/product.mjs';

const read=file=>fsp.readFile(new URL(`../${file}`,import.meta.url),'utf8');

test('product metadata, package, PWA and health source agree on v3',async()=>{
  const [pkgText,manifestText,server,nodeVersion,readme,doctor,harnessSource,gitignore]=await Promise.all([
    read('package.json'),
    read('public/manifest.webmanifest'),
    read('src/server.mjs'),
    read('.node-version'),
    read('README.md'),
    read('scripts/doctor.mjs'),
    read('src/harness-navigator.mjs'),
    read('.gitignore')
  ]);
  const pkg=JSON.parse(pkgText);const manifest=JSON.parse(manifestText);
  assert.equal(PRODUCT_VERSION,'3.0.0');
  assert.equal(PRODUCT_DISPLAY_NAME,'动觉 AI 工作台');
  assert.equal(pkg.version,PRODUCT_VERSION);
  assert.equal(pkg.engines.node,'>=24');
  assert.equal(nodeVersion.trim(),'24.15.0');
  assert.match(readme,/Node\.js 24\+/);
  assert.match(doctor,/Node\.js >= 24/);
  assert.match(harnessSource,/Node 22\.19\.x 或 Node 24\+/);
  assert.match(gitignore,/^\/\.claude\/worktrees\/$/m);
  assert.match(gitignore,/^\/\.worktrees\/$/m);
  assert.doesNotMatch(gitignore,/^\.claude\/$/m);
  assert.doesNotMatch(gitignore,/^\.workbuddy\/$/m);
  assert.equal(manifest.name,PRODUCT_DISPLAY_NAME);
  assert.match(server,/version:PRODUCT_VERSION/);
});
