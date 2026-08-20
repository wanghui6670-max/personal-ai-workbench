import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readGitAuthority, sanitizeGitRemote } from '../src/projects.mjs';

const execFileAsync=promisify(execFile);

test('sanitizeGitRemote strips credentials from URL and scp-like remotes',()=>{
  assert.equal(
    sanitizeGitRemote('ssh://alice:secret@example.invalid/group/repo.git?token=secret#fragment'),
    'ssh://example.invalid/group/repo.git'
  );
  assert.equal(
    sanitizeGitRemote('oauth-token@example.invalid:group/repo.git'),
    'example.invalid:group/repo.git'
  );
  assert.equal(sanitizeGitRemote('git@example.invalid:group/repo.git'),'example.invalid:group/repo.git');
  assert.equal(sanitizeGitRemote('token@example.invalid?credential=secret:group/repo.git'),'');
});

test('readGitAuthority returns live head and remote without copying repo contents',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wb-git-auth-'));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
  await execFileAsync('git',['-c','init.defaultBranch=main','init'],{cwd:dir,env});
  await execFileAsync('git',['config','user.email','dev@example.test'],{cwd:dir,env});
  await execFileAsync('git',['config','user.name','dev'],{cwd:dir,env});
  await writeFile(path.join(dir,'README.md'),'ok\n');
  await execFileAsync('git',['add','README.md'],{cwd:dir,env});
  await execFileAsync('git',['commit','-m','init'],{cwd:dir,env});
  await execFileAsync('git',['remote','add','origin','https://user:demo-token@example.test/repo.git?token=secret#fragment'],{cwd:dir,env});
  const {stdout}=await execFileAsync('git',['rev-parse','--short','HEAD'],{cwd:dir,env});
  const expected=String(stdout).trim();
  const authority=await readGitAuthority(dir);
  assert.equal(authority.head,expected);
  assert.equal(authority.remote,'https://example.test/repo.git');
  assert.equal(authority.dirty,false);
  assert.equal(JSON.stringify(authority).includes('ok'),false);
  assert.equal(JSON.stringify(authority).includes('demo-token'),false);
  assert.equal(JSON.stringify(authority).includes('token=secret'),false);
});

test('readGitAuthority is empty when the directory is not a repo',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wb-git-empty-'));
  await mkdir(path.join(dir,'src'),{recursive:true});
  const authority=await readGitAuthority(dir);
  assert.deepEqual(authority,{head:null,remote:'',dirty:false});
});

test('readGitAuthority does not inherit a parent repository',async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'wb-git-parent-'));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
  await execFileAsync('git',['-c','init.defaultBranch=main','init'],{cwd:parent,env});
  await execFileAsync('git',['config','user.email','dev@example.test'],{cwd:parent,env});
  await execFileAsync('git',['config','user.name','dev'],{cwd:parent,env});
  await writeFile(path.join(parent,'README.md'),'parent\n');
  await execFileAsync('git',['add','README.md'],{cwd:parent,env});
  await execFileAsync('git',['commit','-m','parent'],{cwd:parent,env});
  const child=path.join(parent,'nested-project');
  await mkdir(child,{recursive:true});
  const authority=await readGitAuthority(child);
  assert.deepEqual(authority,{head:null,remote:'',dirty:false});
});
