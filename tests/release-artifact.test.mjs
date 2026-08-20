import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {
  inspectReleaseCandidate,
  SOURCE_TREE_ALGORITHM,
  validateReleaseCandidate
} from '../src/release-artifact.mjs';

const execFileAsync=promisify(execFile);
const FAKE_COMMIT='0123456789abcdef0123456789abcdef01234567';
const FAKE_TREE='89abcdef0123456789abcdef0123456789abcdef';
const FAKE_BLOB='fedcba9876543210fedcba9876543210fedcba98';

async function git(root,args){
  const result=await execFileAsync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,LC_ALL:'C'}});
  return result.stdout.trim();
}

async function repository(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-release-artifact-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  await git(root,['init','-q']);
  await git(root,['config','user.name','Release Fixture']);
  await git(root,['config','user.email','release-fixture@example.invalid']);
  await fsp.mkdir(path.join(root,'public'),{recursive:true});
  await fsp.mkdir(path.join(root,'harness'),{recursive:true});
  await fsp.writeFile(path.join(root,'.node-version'),'24.19.0\n');
  await fsp.writeFile(path.join(root,'.env.example'),'HOST=127.0.0.1\n');
  await fsp.writeFile(path.join(root,'package.json'),'committed package\n');
  await fsp.writeFile(path.join(root,'package-lock.json'),'committed lock\n');
  await fsp.writeFile(path.join(root,'harness','package-lock.json'),'committed harness lock\n');
  await fsp.writeFile(path.join(root,'public','index.html'),'<h1>committed</h1>\n');
  await fsp.writeFile(path.join(root,'run.command'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await git(root,['add','.']);
  await git(root,['commit','-qm','fixture']);
  const commit=await git(root,['rev-parse','HEAD']);
  return{root,commit};
}

function fakeGitOps({record=`100644 blob ${FAKE_BLOB} 5\tpublic/app.js\0`,blob='hello'}={}){
  return{
    objectType:async()=> 'commit',
    treeId:async()=>FAKE_TREE,
    listTree:async()=>Buffer.from(record),
    readBlob:async()=>Buffer.from(blob)
  };
}

test('candidate provenance reads the fixed commit tree and ignores later dirty or untracked checkout files',async t=>{
  const {root,commit}=await repository(t);
  await fsp.writeFile(path.join(root,'package-lock.json'),'dirty worktree lock\n');
  await fsp.writeFile(path.join(root,'public','index.html'),'<h1>dirty</h1>\n');
  await fsp.writeFile(path.join(root,'public','preview.html'),'<h1>untracked</h1>\n');

  const result=await inspectReleaseCandidate({repositoryRoot:root,candidateCommit:commit});

  assert.equal(result.candidateCommit,commit);
  assert.equal(result.sourceTree.algorithm,SOURCE_TREE_ALGORITHM);
  assert.match(result.sourceTree.gitTree,/^[a-f0-9]{40}$/);
  assert.match(result.sourceTree.manifestSha256,/^sha256:[a-f0-9]{64}$/);
  assert.equal(result.sourceTree.files.some(file=>file.path==='public/preview.html'),false);
  assert.equal(result.trackedPublicPaths.includes('preview.html'),false);
  assert.deepEqual(result.trackedPublicPaths,['index.html']);
  assert.equal(result.sourceTree.files.find(file=>file.path==='package-lock.json')?.bytes,15);
  assert.equal(result.sourceTree.files.find(file=>file.path==='public/index.html')?.bytes,19);
  assert.equal(result.sourceTree.files.find(file=>file.path==='run.command')?.gitMode,'100755');
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.sourceTree),true);
  assert.equal(Object.isFrozen(result.sourceTree.files),true);
  assert.equal(Object.isFrozen(result.sourceTree.files[0]),true);
  assert.equal(Object.isFrozen(result.trackedPublicPaths),true);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('candidate provenance is deterministic across repeated reads of the same commit',async t=>{
  const {root,commit}=await repository(t);
  const first=await inspectReleaseCandidate({repositoryRoot:root,candidateCommit:commit});
  const second=await inspectReleaseCandidate({repositoryRoot:root,candidateCommit:commit});
  assert.deepEqual(second,first);
  assert.deepEqual([...first.sourceTree.files].map(file=>file.path),[...first.sourceTree.files].map(file=>file.path).sort());
  assert.equal(first.sourceTree.fileCount,first.sourceTree.files.length);
  assert.equal(first.sourceTree.totalBytes,first.sourceTree.files.reduce((total,file)=>total+file.bytes,0));
});

test('candidate provenance rejects missing, blob, and tree object ids without leaking Git stderr',async t=>{
  const {root,commit}=await repository(t);
  const missing='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await assert.rejects(inspectReleaseCandidate({repositoryRoot:root,candidateCommit:missing}),error=>{
    assert.equal(error.code,'RELEASE_CANDIDATE_NOT_FOUND');
    assert.equal(error.message.includes(root),false);
    assert.equal(error.message.includes(missing),false);
    return true;
  });

  const blob=await git(root,['rev-parse',`${commit}:package-lock.json`]);
  const tree=await git(root,['rev-parse',`${commit}^{tree}`]);
  for(const objectId of [blob,tree]){
    await assert.rejects(inspectReleaseCandidate({repositoryRoot:root,candidateCommit:objectId}),error=>{
      assert.equal(error.code,'RELEASE_CANDIDATE_NOT_COMMIT');
      assert.equal(error.message.includes(root),false);
      assert.equal(error.message.includes(objectId),false);
      return true;
    });
  }
});

test('candidate provenance rejects non-complete and uppercase commit ids before Git access',async t=>{
  const {root,commit}=await repository(t);
  let calls=0;
  const gitOps={
    objectType:async()=>{calls+=1;return'commit';},
    treeId:async()=>FAKE_TREE,
    listTree:async()=>Buffer.alloc(0),
    readBlob:async()=>Buffer.alloc(0)
  };
  for(const candidateCommit of [commit.slice(0,-1),commit.toUpperCase(),'main','']){
    await assert.rejects(inspectReleaseCandidate({repositoryRoot:root,candidateCommit},{gitOps}),error=>error.code==='RELEASE_CANDIDATE_INVALID');
  }
  assert.equal(calls,0);
});

test('candidate provenance rejects symlinks, gitlinks, sensitive files, and unsafe paths from injected Git evidence',async t=>{
  const {root}=await repository(t);
  const cases=[
    [`120000 blob ${FAKE_BLOB} 5\tpublic/link.js\0`,'RELEASE_SOURCE_MODE_FORBIDDEN'],
    [`160000 commit ${FAKE_BLOB} -\tvendor/submodule\0`,'RELEASE_SOURCE_MODE_FORBIDDEN'],
    [`100644 blob ${FAKE_BLOB} 5\t../escape.js\0`,'RELEASE_SOURCE_PATH_INVALID'],
    [`100644 blob ${FAKE_BLOB} 5\tpublic\\escape.js\0`,'RELEASE_SOURCE_PATH_INVALID'],
    [`100644 blob ${FAKE_BLOB} 5\t.env\0`,'RELEASE_SOURCE_SENSITIVE_PATH'],
    [`100644 blob ${FAKE_BLOB} 5\tconfig/private-key.pem\0`,'RELEASE_SOURCE_SENSITIVE_PATH']
  ];
  for(const [record,code] of cases){
    await assert.rejects(inspectReleaseCandidate({repositoryRoot:root,candidateCommit:FAKE_COMMIT},{gitOps:fakeGitOps({record})}),error=>{
      assert.equal(error.code,code);
      assert.equal(error.message.includes(root),false);
      return true;
    });
  }
});

test('candidate provenance rejects case-folded and Unicode-normalization path collisions',async t=>{
  const {root}=await repository(t);
  const caseCollision=[
    `100644 blob ${FAKE_BLOB} 5\tpublic/App.js`,
    `100644 blob ${FAKE_BLOB} 5\tpublic/app.js`
  ].join('\0')+'\0';
  await assert.rejects(inspectReleaseCandidate({repositoryRoot:root,candidateCommit:FAKE_COMMIT},{gitOps:fakeGitOps({record:caseCollision})}),error=>error.code==='RELEASE_SOURCE_PATH_COLLISION');

  const nfd='public/cafe\u0301.js';
  await assert.rejects(inspectReleaseCandidate({repositoryRoot:root,candidateCommit:FAKE_COMMIT},{gitOps:fakeGitOps({record:`100644 blob ${FAKE_BLOB} 5\t${nfd}\0`})}),error=>error.code==='RELEASE_SOURCE_PATH_COLLISION');
});

test('candidate provenance rejects a blob whose bytes disagree with ls-tree evidence',async t=>{
  const {root}=await repository(t);
  await assert.rejects(
    inspectReleaseCandidate({repositoryRoot:root,candidateCommit:FAKE_COMMIT},{gitOps:fakeGitOps({record:`100644 blob ${FAKE_BLOB} 6\tpublic/app.js\0`})}),
    error=>error.code==='RELEASE_SOURCE_BLOB_MISMATCH'
  );
});

test('source manifest validator rejects tampering, extra fields, and mismatched public allowlists',async t=>{
  const {root,commit}=await repository(t);
  const valid=await inspectReleaseCandidate({repositoryRoot:root,candidateCommit:commit});
  assert.deepEqual(validateReleaseCandidate(valid),valid);

  const changedDigest={...valid,sourceTree:{...valid.sourceTree,manifestSha256:`sha256:${'0'.repeat(64)}`}};
  assert.throws(()=>validateReleaseCandidate(changedDigest),error=>error.code==='RELEASE_SOURCE_MANIFEST_INVALID');
  assert.throws(()=>validateReleaseCandidate({...valid,absoluteRoot:root}),error=>error.code==='RELEASE_SOURCE_MANIFEST_INVALID');
  assert.throws(()=>validateReleaseCandidate({...valid,trackedPublicPaths:[...valid.trackedPublicPaths,'preview.html']}),error=>error.code==='RELEASE_SOURCE_MANIFEST_INVALID');

  const fileWithExtra={...valid.sourceTree.files[0],mtime:Date.now()};
  const extraFileField={...valid,sourceTree:{...valid.sourceTree,files:[fileWithExtra,...valid.sourceTree.files.slice(1)]}};
  assert.throws(()=>validateReleaseCandidate(extraFileField),error=>error.code==='RELEASE_SOURCE_MANIFEST_INVALID');
});
