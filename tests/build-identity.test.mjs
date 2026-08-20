import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ASSET_HASH_ALGORITHM,
  computeCanonicalAssetsHash,
  createStaticAssetManifest,
  enumerateStaticAssetFiles,
  hashFile,
  loadVerifiedStaticAssets,
  validateBuildIdentity,
  validateStaticAssetManifest
} from '../src/build-identity.mjs';

const BUILD={
  schemaVersion:1,
  productVersion:'3.0.0',
  commit:'0123456789abcdef0123456789abcdef01234567',
  builtAt:'2026-08-20T08:09:10.123Z'
};

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-build-identity-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const publicRoot=path.join(root,'public');
  await fsp.mkdir(path.join(publicRoot,'nested'),{recursive:true});
  await fsp.writeFile(path.join(publicRoot,'z.txt'),'z\n');
  await fsp.writeFile(path.join(publicRoot,'index.html'),'<h1>ready</h1>\n');
  await fsp.writeFile(path.join(publicRoot,'nested','app.js'),'console.log("ok")\n');
  return{root,publicRoot};
}

function clone(value){return structuredClone(value);}

test('build identity requires an exact lowercase commit SHA, ISO builtAt, and SemVer productVersion',()=>{
  assert.deepEqual(validateBuildIdentity(BUILD),BUILD);
  for(const commit of [
    '0123456789abcdef0123456789abcdef0123456',
    '0123456789abcdef0123456789abcdef012345678',
    '0123456789ABCDEF0123456789ABCDEF01234567',
    'g123456789abcdef0123456789abcdef01234567'
  ])assert.throws(()=>validateBuildIdentity({...BUILD,commit}),/commit/i);
  for(const builtAt of ['not-a-date','2026-08-20','2026-08-20T08:09:10+08:00']){
    assert.throws(()=>validateBuildIdentity({...BUILD,builtAt}),/builtAt/i);
  }
  for(const productVersion of ['', 'v3.0.0', '3.0', '03.0.0']){
    assert.throws(()=>validateBuildIdentity({...BUILD,productVersion}),/productVersion/i);
  }
});

test('public assets are recursively enumerated as sorted POSIX paths and symlinks are rejected',async t=>{
  const {publicRoot}=await fixture(t);
  assert.deepEqual(await enumerateStaticAssetFiles(publicRoot),[
    'index.html',
    'nested/app.js',
    'z.txt'
  ]);

  await fsp.symlink(path.join(publicRoot,'index.html'),path.join(publicRoot,'linked.html'));
  await assert.rejects(enumerateStaticAssetFiles(publicRoot),/symlink|symbolic link/i);
});

test('single-file hashing returns exact bytes and sha256 and refuses a symlink',async t=>{
  const {publicRoot}=await fixture(t);
  assert.deepEqual(await hashFile(path.join(publicRoot,'z.txt')),{
    bytes:2,
    sha256:'sha256:c865f6c5ab8d1b0bcd383a5e1e3879d22681c96bf462c269b7581d523fbe70ab'
  });
  const linked=path.join(publicRoot,'z-link.txt');
  await fsp.symlink(path.join(publicRoot,'z.txt'),linked);
  await assert.rejects(hashFile(linked),/symlink|symbolic link/i);
});

test('canonical aggregate is order-independent and changes when one asset byte changes',()=>{
  const assets=[
    {path:'nested/app.js',bytes:1,sha256:`sha256:${'a'.repeat(64)}`},
    {path:'index.html',bytes:2,sha256:`sha256:${'b'.repeat(64)}`}
  ];
  const forward=computeCanonicalAssetsHash(assets);
  assert.match(forward,/^sha256:[a-f0-9]{64}$/);
  assert.equal(computeCanonicalAssetsHash([...assets].reverse()),forward);
  assert.notEqual(
    computeCanonicalAssetsHash([
      {...assets[0],sha256:`sha256:${'c'.repeat(64)}`},
      assets[1]
    ]),
    forward
  );
});

test('manifest is deterministic, sorted, portable, and contains no filesystem metadata',async t=>{
  const {root,publicRoot}=await fixture(t);
  const manifest=await createStaticAssetManifest(publicRoot,BUILD);
  assert.deepEqual(Object.keys(manifest),[
    'schemaVersion','productVersion','commit','builtAt','staticAssets'
  ]);
  assert.equal(manifest.staticAssets.algorithm,ASSET_HASH_ALGORITHM);
  assert.equal(manifest.staticAssets.assetCount,3);
  assert.deepEqual(manifest.staticAssets.assets.map(asset=>asset.path),[
    'index.html','nested/app.js','z.txt'
  ]);
  assert.match(manifest.staticAssets.manifestSha256,/^sha256:[a-f0-9]{64}$/);
  for(const asset of manifest.staticAssets.assets){
    assert.deepEqual(Object.keys(asset),['path','bytes','sha256']);
    assert.equal(path.posix.isAbsolute(asset.path),false);
    assert.match(asset.sha256,/^sha256:[a-f0-9]{64}$/);
  }
  const serialized=JSON.stringify(manifest);
  assert.equal(serialized.includes(root),false);
  assert.doesNotMatch(serialized,/mtime|mode|permission|secret/i);
  assert.deepEqual(validateStaticAssetManifest(clone(manifest)),manifest);
  assert.deepEqual(await createStaticAssetManifest(publicRoot,BUILD),manifest);

  await fsp.writeFile(path.join(publicRoot,'z.txt'),'y\n');
  const changed=await createStaticAssetManifest(publicRoot,BUILD);
  assert.notEqual(changed.staticAssets.manifestSha256,manifest.staticAssets.manifestSha256);
});

test('tracked asset allowlist excludes untracked files from a formal manifest',async t=>{
  const {publicRoot}=await fixture(t);
  await fsp.writeFile(path.join(publicRoot,'preview.html'),'<h1>untracked</h1>\n');

  const manifest=await createStaticAssetManifest(publicRoot,BUILD,{
    assetPaths:['z.txt','index.html','nested/app.js']
  });

  assert.deepEqual(manifest.staticAssets.assets.map(asset=>asset.path),[
    'index.html','nested/app.js','z.txt'
  ]);
  assert.equal(manifest.staticAssets.assetCount,3);

  await assert.rejects(loadVerifiedStaticAssets(publicRoot,manifest),error=>{
    assert.equal(error.code,'ASSET_EXTRA');
    assert.match(error.message,/preview\.html/);
    return true;
  });
  await fsp.unlink(path.join(publicRoot,'preview.html'));
  assert.equal((await loadVerifiedStaticAssets(publicRoot,manifest)).size,3);
});

test('formal manifest reports a missing allowlisted asset without leaking its absolute root',async t=>{
  const {publicRoot}=await fixture(t);
  await fsp.unlink(path.join(publicRoot,'z.txt'));

  await assert.rejects(
    createStaticAssetManifest(publicRoot,BUILD,{assetPaths:['index.html','nested/app.js','z.txt']}),
    error=>{
      assert.equal(error.code,'ASSET_MISSING');
      assert.equal(error.message.includes(publicRoot),false);
      assert.match(error.message,/z\.txt|missing/i);
      return true;
    }
  );
});

test('manifest validation rejects traversal, absolute paths, backslashes, duplicates, and invalid totals',async t=>{
  const {publicRoot}=await fixture(t);
  const manifest=await createStaticAssetManifest(publicRoot,BUILD);
  const first=manifest.staticAssets.assets[0];

  for(const invalidPath of ['../index.html','/index.html','nested\\app.js','./index.html','C:/index.html']){
    const candidate=clone(manifest);
    candidate.staticAssets.assets[0]={...first,path:invalidPath};
    assert.throws(()=>validateStaticAssetManifest(candidate),/path/i);
  }

  const duplicate=clone(manifest);
  duplicate.staticAssets.assets[1]={...duplicate.staticAssets.assets[1],path:first.path};
  assert.throws(()=>validateStaticAssetManifest(duplicate),/duplicate/i);

  const wrongCount=clone(manifest);
  wrongCount.staticAssets.assetCount+=1;
  assert.throws(()=>validateStaticAssetManifest(wrongCount),/assetCount/i);

  const wrongAggregate=clone(manifest);
  wrongAggregate.staticAssets.manifestSha256=`sha256:${'0'.repeat(64)}`;
  assert.throws(()=>validateStaticAssetManifest(wrongAggregate),/manifestSha256/i);

  const leakedRoot=clone(manifest);
  leakedRoot.publicRoot=publicRoot;
  assert.throws(()=>validateStaticAssetManifest(leakedRoot),/unsupported fields/i);

  const leakedMetadata=clone(manifest);
  leakedMetadata.staticAssets.assets[0].mtimeMs=123;
  assert.throws(()=>validateStaticAssetManifest(leakedMetadata),/unsupported fields/i);
});

test('verified loading rejects missing, extra, and changed files without returning a partial map',async t=>{
  const {publicRoot}=await fixture(t);
  const manifest=await createStaticAssetManifest(publicRoot,BUILD);
  const loaded=await loadVerifiedStaticAssets(publicRoot,manifest);
  assert.equal(loaded instanceof Map,true);
  assert.deepEqual([...loaded.keys()],['index.html','nested/app.js','z.txt']);
  assert.equal(loaded.get('index.html').toString('utf8'),'<h1>ready</h1>\n');

  await fsp.unlink(path.join(publicRoot,'z.txt'));
  await assert.rejects(loadVerifiedStaticAssets(publicRoot,manifest),error=>{
    assert.equal(error.code,'ASSET_MISSING');
    assert.equal(error.message.includes(publicRoot),false);
    assert.match(error.message,/z\.txt|missing/i);
    return true;
  });
  await fsp.writeFile(path.join(publicRoot,'z.txt'),'z\n');

  await fsp.writeFile(path.join(publicRoot,'extra.txt'),'extra');
  await assert.rejects(loadVerifiedStaticAssets(publicRoot,manifest),/extra/i);
  await fsp.unlink(path.join(publicRoot,'extra.txt'));

  await fsp.writeFile(path.join(publicRoot,'index.html'),'<h1>tampered</h1>\n');
  await assert.rejects(loadVerifiedStaticAssets(publicRoot,manifest),/sha256|bytes|changed/i);
});

test('loaded buffers are detached from later filesystem mutations',async t=>{
  const {publicRoot}=await fixture(t);
  const manifest=await createStaticAssetManifest(publicRoot,BUILD);
  const loaded=await loadVerifiedStaticAssets(publicRoot,manifest);
  await fsp.writeFile(path.join(publicRoot,'index.html'),'<h1>later</h1>\n');
  assert.equal(loaded.get('index.html').toString('utf8'),'<h1>ready</h1>\n');
});
