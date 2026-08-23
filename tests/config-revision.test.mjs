import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_REVISION_SCHEMA_VERSION,
  prepareConfigRevision,
  readVerifiedConfigRevision
} from '../src/config-revision.mjs';

const REVISION_ID='cfg_20260820_primary';
const SOURCE='PORT=4173\nSESSION_SECRET=revision-secret-canary\n';
const ENV_NAME='workbench.env';
const MANIFEST_NAME='revision.json';

async function fixture(t,prefix='workbench-config-revision-'){
  const runtimeRoot=await fsp.mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(()=>fsp.rm(runtimeRoot,{recursive:true,force:true}));
  return runtimeRoot;
}

async function mode(target){
  return (await fsp.lstat(target)).mode&0o777;
}

async function exists(target){
  try{await fsp.lstat(target);return true;}
  catch(error){if(error?.code==='ENOENT')return false;throw error;}
}

function expectedHash(source=SOURCE){
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(source,'utf8')).digest('hex')}`;
}

function assertSafeError(error,{code,runtimeRoot,secrets=[]}){
  assert.equal(error.code,code);
  const rendered=`${error.name}: ${error.message}\n${error.stack??''}`;
  assert.equal(rendered.includes(runtimeRoot),false);
  for(const secret of secrets)assert.equal(rendered.includes(secret),false);
  return true;
}

test('prepare creates one private immutable revision without mutating root .env, current, or process.env',async t=>{
  const runtimeRoot=await fixture(t);
  const portBefore=process.env.PORT;
  const secretBefore=process.env.SESSION_SECRET;

  const descriptor=await prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE});
  const revisionDirectory=path.join(runtimeRoot,'config-revisions',REVISION_ID);
  const envFile=path.join(revisionDirectory,ENV_NAME);
  const manifestFile=path.join(revisionDirectory,MANIFEST_NAME);

  assert.deepEqual(Object.keys(descriptor),[
    'schemaVersion','revisionId','envFile','manifestFile','envSha256','bytes','created'
  ]);
  assert.equal(Object.isFrozen(descriptor),true);
  assert.deepEqual(descriptor,{
    schemaVersion:CONFIG_REVISION_SCHEMA_VERSION,
    revisionId:REVISION_ID,
    envFile,
    manifestFile,
    envSha256:expectedHash(),
    bytes:Buffer.byteLength(SOURCE,'utf8'),
    created:true
  });

  assert.equal(await fsp.readFile(envFile,'utf8'),SOURCE);
  assert.deepEqual(JSON.parse(await fsp.readFile(manifestFile,'utf8')),{
    schemaVersion:CONFIG_REVISION_SCHEMA_VERSION,
    revisionId:REVISION_ID,
    envFile:ENV_NAME,
    envSha256:expectedHash(),
    bytes:Buffer.byteLength(SOURCE,'utf8')
  });
  assert.equal((await fsp.readFile(manifestFile,'utf8')).includes(runtimeRoot),false);
  assert.equal((await fsp.readFile(manifestFile,'utf8')).includes('revision-secret-canary'),false);
  assert.equal(JSON.stringify(descriptor).includes('revision-secret-canary'),false);

  assert.equal(await mode(runtimeRoot),0o700);
  assert.equal(await mode(path.join(runtimeRoot,'config-revisions')),0o700);
  assert.equal(await mode(revisionDirectory),0o700);
  assert.equal(await mode(envFile),0o600);
  assert.equal(await mode(manifestFile),0o600);
  assert.deepEqual((await fsp.readdir(path.join(runtimeRoot,'config-revisions'))).sort(),[REVISION_ID]);
  assert.deepEqual((await fsp.readdir(revisionDirectory)).sort(),[ENV_NAME,MANIFEST_NAME].sort());

  assert.equal(await exists(path.join(runtimeRoot,'.env')),false);
  assert.equal(await exists(path.join(runtimeRoot,'current')),false);
  assert.equal(process.env.PORT,portBefore);
  assert.equal(process.env.SESSION_SECRET,secretBefore);
});

test('same id and exact bytes are idempotently reused while different bytes collide without changing old files',async t=>{
  const runtimeRoot=await fixture(t);
  const first=await prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE});
  const envBefore=await fsp.readFile(first.envFile);
  const manifestBefore=await fsp.readFile(first.manifestFile);
  const envStatBefore=await fsp.stat(first.envFile,{bigint:true});
  const manifestStatBefore=await fsp.stat(first.manifestFile,{bigint:true});

  const replay=await prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE});
  assert.deepEqual(replay,{...first,created:false});
  assert.deepEqual(await fsp.readFile(first.envFile),envBefore);
  assert.deepEqual(await fsp.readFile(first.manifestFile),manifestBefore);
  assert.equal((await fsp.stat(first.envFile,{bigint:true})).mtimeNs,envStatBefore.mtimeNs);
  assert.equal((await fsp.stat(first.manifestFile,{bigint:true})).mtimeNs,manifestStatBefore.mtimeNs);

  const conflicting='PORT=9999\nSESSION_SECRET=new-secret-canary\n';
  await assert.rejects(
    prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:conflicting}),
    error=>assertSafeError(error,{
      code:'CONFIG_REVISION_COLLISION',runtimeRoot,
      secrets:['revision-secret-canary','new-secret-canary']
    })
  );
  assert.deepEqual(await fsp.readFile(first.envFile),envBefore);
  assert.deepEqual(await fsp.readFile(first.manifestFile),manifestBefore);
});

test('verified read strictly checks the manifest and returns a frozen secret-free descriptor',async t=>{
  const runtimeRoot=await fixture(t);
  const created=await prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE});
  const read=await readVerifiedConfigRevision({runtimeRoot,revisionId:REVISION_ID});
  assert.deepEqual(read,{...created,created:false});
  assert.equal(Object.isFrozen(read),true);
  assert.equal(JSON.stringify(read).includes('revision-secret-canary'),false);
});

test('revision id, source type, and every ignored env line fail before filesystem mutation with safe stable errors',async t=>{
  const runtimeRoot=await fixture(t,'workbench-config-secret-root-');
  for(const revisionId of [
    '../cfg_escape','/tmp/cfg_escape','cfg_','cfg_has/slash','cfg_has.dot','cfg_has space',
    `cfg_${'a'.repeat(65)}`,null,42
  ]){
    await assert.rejects(
      prepareConfigRevision({runtimeRoot,revisionId,source:SOURCE}),
      error=>assertSafeError(error,{code:'CONFIG_REVISION_INVALID_ID',runtimeRoot,secrets:['revision-secret-canary']})
    );
  }
  await assert.rejects(
    prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:Buffer.from(SOURCE)}),
    error=>assertSafeError(error,{code:'CONFIG_REVISION_INVALID_SOURCE',runtimeRoot,secrets:['revision-secret-canary']})
  );
  for(const source of [
    'UNKNOWN_KEY=ignored-secret-canary\n',
    'PORT=$(cat ignored-secret-canary)\n',
    'not-an-assignment ignored-secret-canary\n'
  ]){
    await assert.rejects(
      prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source}),
      error=>assertSafeError(error,{
        code:'CONFIG_REVISION_INVALID_ENV',runtimeRoot,
        secrets:['ignored-secret-canary']
      })
    );
  }
  assert.equal(await exists(path.join(runtimeRoot,'config-revisions')),false);
});

test('runtime root, config-revisions, and revision target reject symlinks and non-directories',async t=>{
  const parent=await fixture(t);
  const realRoot=path.join(parent,'real-root');
  const linkedRoot=path.join(parent,'linked-secret-root');
  await fsp.mkdir(realRoot,{mode:0o700});
  await fsp.symlink(realRoot,linkedRoot);
  await assert.rejects(
    prepareConfigRevision({runtimeRoot:linkedRoot,revisionId:REVISION_ID,source:SOURCE}),
    error=>assertSafeError(error,{code:'CONFIG_REVISION_ROOT_SYMLINK',runtimeRoot:linkedRoot,secrets:['revision-secret-canary']})
  );

  const fileRoot=path.join(parent,'file-secret-root');
  await fsp.writeFile(fileRoot,'sentinel');
  await assert.rejects(
    prepareConfigRevision({runtimeRoot:fileRoot,revisionId:REVISION_ID,source:SOURCE}),
    error=>assertSafeError(error,{code:'CONFIG_REVISION_ROOT_NOT_DIRECTORY',runtimeRoot:fileRoot,secrets:['revision-secret-canary']})
  );

  for(const kind of ['symlink','file']){
    const runtimeRoot=path.join(parent,`root-for-revisions-${kind}`);
    const outside=path.join(parent,`outside-${kind}`);
    await fsp.mkdir(runtimeRoot,{mode:0o700});
    if(kind==='symlink'){
      await fsp.mkdir(outside,{mode:0o700});
      await fsp.symlink(outside,path.join(runtimeRoot,'config-revisions'));
    }else await fsp.writeFile(path.join(runtimeRoot,'config-revisions'),'sentinel');
    await assert.rejects(
      prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE}),
      error=>assertSafeError(error,{
        code:kind==='symlink'?'CONFIG_REVISIONS_SYMLINK':'CONFIG_REVISIONS_NOT_DIRECTORY',
        runtimeRoot,secrets:['revision-secret-canary']
      })
    );
  }

  for(const kind of ['symlink','file']){
    const runtimeRoot=path.join(parent,`root-for-target-${kind}`);
    const revisions=path.join(runtimeRoot,'config-revisions');
    const outside=path.join(parent,`outside-target-${kind}`);
    await fsp.mkdir(revisions,{recursive:true,mode:0o700});
    await fsp.chmod(runtimeRoot,0o700);
    if(kind==='symlink'){
      await fsp.mkdir(outside,{mode:0o700});
      await fsp.symlink(outside,path.join(revisions,REVISION_ID));
    }else await fsp.writeFile(path.join(revisions,REVISION_ID),'sentinel');
    await assert.rejects(
      prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE}),
      error=>assertSafeError(error,{
        code:kind==='symlink'?'CONFIG_REVISION_TARGET_SYMLINK':'CONFIG_REVISION_TARGET_NOT_DIRECTORY',
        runtimeRoot,secrets:['revision-secret-canary']
      })
    );
  }
});

test('verified read rejects env or manifest symlinks, non-regular files, extras, and wrong modes',async t=>{
  const cases=[
    {name:'env symlink',mutate:async({envFile,outside})=>{await fsp.unlink(envFile);await fsp.symlink(outside,envFile);},code:'CONFIG_REVISION_ENV_SYMLINK'},
    {name:'manifest symlink',mutate:async({manifestFile,outside})=>{await fsp.unlink(manifestFile);await fsp.symlink(outside,manifestFile);},code:'CONFIG_REVISION_MANIFEST_SYMLINK'},
    {name:'env directory',mutate:async({envFile})=>{await fsp.unlink(envFile);await fsp.mkdir(envFile);},code:'CONFIG_REVISION_ENV_NOT_REGULAR'},
    {name:'manifest directory',mutate:async({manifestFile})=>{await fsp.unlink(manifestFile);await fsp.mkdir(manifestFile);},code:'CONFIG_REVISION_MANIFEST_NOT_REGULAR'},
    {name:'extra entry',mutate:async({revisionDirectory})=>fsp.writeFile(path.join(revisionDirectory,'extra-secret-file'),'x'),code:'CONFIG_REVISION_EXTRA_ENTRY'},
    {name:'env hardlink',mutate:async({envFile,runtimeRoot})=>fsp.link(envFile,path.join(runtimeRoot,'env-hardlink')),code:'CONFIG_REVISION_ENV_LINK_COUNT'},
    {name:'manifest hardlink',mutate:async({manifestFile,runtimeRoot})=>fsp.link(manifestFile,path.join(runtimeRoot,'manifest-hardlink')),code:'CONFIG_REVISION_MANIFEST_LINK_COUNT'},
    {name:'env mode',mutate:async({envFile})=>fsp.chmod(envFile,0o644),code:'CONFIG_REVISION_ENV_MODE'},
    {name:'manifest mode',mutate:async({manifestFile})=>fsp.chmod(manifestFile,0o644),code:'CONFIG_REVISION_MANIFEST_MODE'},
    {name:'target mode',mutate:async({revisionDirectory})=>fsp.chmod(revisionDirectory,0o755),code:'CONFIG_REVISION_TARGET_MODE'},
    {name:'revisions mode',mutate:async({runtimeRoot})=>fsp.chmod(path.join(runtimeRoot,'config-revisions'),0o755),code:'CONFIG_REVISIONS_MODE'},
    {name:'root mode',mutate:async({runtimeRoot})=>fsp.chmod(runtimeRoot,0o755),code:'CONFIG_REVISION_ROOT_MODE'}
  ];

  for(const item of cases){
    await t.test(item.name,async t=>{
      const runtimeRoot=await fixture(t);
      const descriptor=await prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE});
      const revisionDirectory=path.dirname(descriptor.envFile);
      const outside=path.join(runtimeRoot,'outside-secret-file');
      await fsp.writeFile(outside,'outside-secret-canary',{mode:0o600});
      await item.mutate({...descriptor,revisionDirectory,outside,runtimeRoot});
      await assert.rejects(
        readVerifiedConfigRevision({runtimeRoot,revisionId:REVISION_ID}),
        error=>assertSafeError(error,{
          code:item.code,runtimeRoot,
          secrets:['revision-secret-canary','outside-secret-canary']
        })
      );
    });
  }
});

test('verified read rejects every manifest or byte tamper and never rewrites the damaged revision',async t=>{
  const cases=[
    {name:'unknown manifest field',mutate:manifest=>({...manifest,secretValue:'manifest-secret-canary'}),code:'CONFIG_REVISION_MANIFEST_INVALID'},
    {name:'wrong schema',mutate:manifest=>({...manifest,schemaVersion:2}),code:'CONFIG_REVISION_MANIFEST_INVALID'},
    {name:'wrong revision',mutate:manifest=>({...manifest,revisionId:'cfg_other'}),code:'CONFIG_REVISION_MANIFEST_INVALID'},
    {name:'traversing envFile',mutate:manifest=>({...manifest,envFile:'../workbench.env'}),code:'CONFIG_REVISION_MANIFEST_INVALID'},
    {name:'wrong digest',mutate:manifest=>({...manifest,envSha256:`sha256:${'0'.repeat(64)}`}),code:'CONFIG_REVISION_ENV_MISMATCH'},
    {name:'wrong bytes',mutate:manifest=>({...manifest,bytes:manifest.bytes+1}),code:'CONFIG_REVISION_ENV_MISMATCH'}
  ];

  for(const item of cases){
    await t.test(item.name,async t=>{
      const runtimeRoot=await fixture(t);
      const descriptor=await prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE});
      const manifest=JSON.parse(await fsp.readFile(descriptor.manifestFile,'utf8'));
      const changed=JSON.stringify(item.mutate(manifest),null,2)+'\n';
      await fsp.writeFile(descriptor.manifestFile,changed,{mode:0o600});
      const before=await fsp.readFile(descriptor.manifestFile);
      await assert.rejects(
        readVerifiedConfigRevision({runtimeRoot,revisionId:REVISION_ID}),
        error=>assertSafeError(error,{
          code:item.code,runtimeRoot,
          secrets:['revision-secret-canary','manifest-secret-canary']
        })
      );
      assert.deepEqual(await fsp.readFile(descriptor.manifestFile),before);
    });
  }

  await t.test('env bytes changed with internally valid syntax',async t=>{
    const runtimeRoot=await fixture(t);
    const descriptor=await prepareConfigRevision({runtimeRoot,revisionId:REVISION_ID,source:SOURCE});
    await fsp.writeFile(descriptor.envFile,'PORT=9999\nSESSION_SECRET=byte-tamper-secret\n',{mode:0o600});
    const before=await fsp.readFile(descriptor.envFile);
    await assert.rejects(
      readVerifiedConfigRevision({runtimeRoot,revisionId:REVISION_ID}),
      error=>assertSafeError(error,{
        code:'CONFIG_REVISION_ENV_MISMATCH',runtimeRoot,
        secrets:['byte-tamper-secret']
      })
    );
    assert.deepEqual(await fsp.readFile(descriptor.envFile),before);
  });
});

test('verified read rejects missing revisions and incomplete directories with stable non-leaking errors',async t=>{
  const runtimeRoot=await fixture(t);
  await fsp.mkdir(path.join(runtimeRoot,'config-revisions'),{mode:0o700});
  await assert.rejects(
    readVerifiedConfigRevision({runtimeRoot,revisionId:REVISION_ID}),
    error=>assertSafeError(error,{code:'CONFIG_REVISION_NOT_FOUND',runtimeRoot})
  );

  const target=path.join(runtimeRoot,'config-revisions',REVISION_ID);
  await fsp.mkdir(target,{mode:0o700});
  await fsp.writeFile(path.join(target,ENV_NAME),SOURCE,{mode:0o600});
  await assert.rejects(
    readVerifiedConfigRevision({runtimeRoot,revisionId:REVISION_ID}),
    error=>assertSafeError(error,{
      code:'CONFIG_REVISION_INCOMPLETE',runtimeRoot,
      secrets:['revision-secret-canary']
    })
  );
});
