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
  assert.equal(pkg.engines.npm,'>=11.17.0 <12');
  assert.equal(pkg.packageManager,'npm@11.17.0');
  assert.equal(nodeVersion.trim(),'24.19.0');
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

test('Node workflows consume the pinned toolchain and root lockfile',async()=>{
  const workflowFiles=[
    '.github/workflows/ci.yml',
    '.github/workflows/browser-boot-smoke.yml',
    '.github/workflows/macos-host-contract.yml',
    '.github/workflows/p0-deployment-acceptance.yml'
  ];
  for(const workflowFile of workflowFiles){
    const workflow=await read(workflowFile);
    assert.match(workflow,/node-version-file:\s*['"]?\.node-version['"]?/);
    assert.match(workflow,/npm ci --ignore-scripts --no-audit --no-fund/);
    assert.doesNotMatch(workflow,/node-version:\s*['"]?24['"]?/);
    assert.doesNotMatch(workflow,/npm install --no-save/);
  }
});
