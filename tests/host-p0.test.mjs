import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildMacosLaunchAgentPlist,
  compareSnapshots,
  pathFingerprint,
  snapshotTree,
  validateHostBinding,
  validateHostReadinessReport
} from '../src/host-p0.mjs';

async function temp(t){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'host-p0-test-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return root;}

test('real-host binding requires explicit separate paths, localhost, and Joycrew disabled',()=>{
  assert.throws(()=>validateHostBinding({appRoot:'/app',dataDir:'data',workspaceRoot:'/work'}),/绝对 DATA_DIR/);
  assert.throws(()=>validateHostBinding({appRoot:'/app',dataDir:'/same',workspaceRoot:'/same'}),/彼此独立/);
  assert.throws(()=>validateHostBinding({appRoot:'/app',dataDir:'/data',workspaceRoot:'/data/work'}),/彼此独立/);
  assert.throws(()=>validateHostBinding({appRoot:'/app',dataDir:'/data',workspaceRoot:'/work',host:'0.0.0.0'}),/只允许绑定 localhost/);
  assert.throws(()=>validateHostBinding({appRoot:'/app',dataDir:'/data',workspaceRoot:'/work',joycrewEnabled:'1'}),/JOYCREW_ENABLED=0/);
  assert.doesNotThrow(()=>validateHostBinding({appRoot:'/app',dataDir:'/data',workspaceRoot:'/work',joycrewEnabled:'1',requireJoycrewDisabled:false}));
  assert.deepEqual(validateHostBinding({appRoot:'/app',dataDir:'/data',workspaceRoot:'/work',host:'localhost',port:'44173',joycrewEnabled:'0'}),{
    appRoot:path.resolve('/app'),dataDir:path.resolve('/data'),workspaceRoot:path.resolve('/work'),host:'127.0.0.1',port:44173
  });
});

test('content snapshot ignores safe rewrite timestamps but detects real data changes and ignored-cache changes',async t=>{
  const root=await temp(t);
  const dataFile=path.join(root,'project','a.txt');
  await fsp.mkdir(path.dirname(dataFile),{recursive:true});
  await fsp.writeFile(dataFile,'one','utf8');
  await fsp.mkdir(path.join(root,'project','node_modules','pkg'),{recursive:true});
  await fsp.writeFile(path.join(root,'project','node_modules','pkg','ignored.js'),'one','utf8');
  const before=await snapshotTree(root,{hashFiles:true,ignoreNames:['node_modules']});
  await fsp.writeFile(path.join(root,'project','node_modules','pkg','ignored.js'),'two','utf8');
  const ignored=await snapshotTree(root,{hashFiles:true,ignoreNames:['node_modules']});
  assert.equal(compareSnapshots(before,ignored).equal,true);
  const later=new Date(Date.now()+5000);
  await fsp.utimes(dataFile,later,later);
  const touched=await snapshotTree(root,{hashFiles:true,ignoreNames:['node_modules']});
  assert.equal(compareSnapshots(before,touched).equal,true,'content-hashed files must ignore mtime-only rewrites');
  await fsp.writeFile(dataFile,'two','utf8');
  const after=await snapshotTree(root,{hashFiles:true,ignoreNames:['node_modules']});
  assert.equal(compareSnapshots(before,after).equal,false);
  assert.equal(before.counts.contentHashedFiles,1);
});

test('macOS LaunchAgent plist uses direct Node arguments and contains no service secrets',()=>{
  const plist=buildMacosLaunchAgentPlist({
    label:'com.example.workbench',appRoot:'/Users/test/AI & Workbench',nodePath:'/opt/homebrew/bin/node',
    home:'/Users/test',pathEnv:'/opt/homebrew/bin:/usr/bin:/bin',
    stdoutPath:'/Users/test/Library/Logs/Workbench/out.log',stderrPath:'/Users/test/Library/Logs/Workbench/error.log'
  });
  assert.match(plist,/ProgramArguments/);
  assert.match(plist,/\/opt\/homebrew\/bin\/node/);
  assert.match(plist,/AI &amp; Workbench/);
  assert.doesNotMatch(plist,/WORKBENCH_PASSWORD|SESSION_SECRET|CAPTURE_TOKEN|OPENAI_API_KEY|JOYCREW_TRUSTED_PROXY_TOKEN/);
  assert.doesNotMatch(plist,/\/bin\/(?:ba|z)?sh|source |eval /);
});

test('LaunchAgent install gate binds a recent report to version, commit, and paths',()=>{
  const now=Date.now();
  const input={
    status:'passed',productVersion:'2.0.0',commit:'abc123',finishedAt:new Date(now-1000).toISOString(),
    scope:{joycrewEnabled:false,externalWrites:false},
    binding:{
      appRootFingerprint:pathFingerprint('/app'),
      dataDirFingerprint:pathFingerprint('/data'),
      workspaceRootFingerprint:pathFingerprint('/work')
    }
  };
  assert.equal(validateHostReadinessReport(input,{productVersion:'2.0.0',commit:'abc123',appRoot:'/app',dataDir:'/data',workspaceRoot:'/work',now}),true);
  assert.throws(()=>validateHostReadinessReport({...input,commit:'other'},{productVersion:'2.0.0',commit:'abc123',appRoot:'/app',dataDir:'/data',workspaceRoot:'/work',now}),/提交/);
  assert.throws(()=>validateHostReadinessReport({...input,finishedAt:new Date(now-2*24*60*60*1000).toISOString()},{productVersion:'2.0.0',commit:'abc123',appRoot:'/app',dataDir:'/data',workspaceRoot:'/work',now}),/过期/);
});

test('host scripts never use shell evaluation for service control',async()=>{
  const [preflight,service]=await Promise.all([
    fsp.readFile(new URL('../scripts/p0-host-preflight.mjs',import.meta.url),'utf8'),
    fsp.readFile(new URL('../scripts/macos-launch-agent.mjs',import.meta.url),'utf8')
  ]);
  for(const source of [preflight,service]){
    assert.doesNotMatch(source,/shell\s*:\s*true/);
    assert.doesNotMatch(source,/\bexec\s*\(/);
    assert.doesNotMatch(source,/\beval\s*\(/);
  }
  assert.match(preflight,/JOYCREW_ENABLED:'0'/);
  assert.match(service,/validateHostReadinessReport/);
});

test('macOS host P0 documentation and package scripts expose the guarded sequence',async()=>{
  const [document,packageJson]=await Promise.all([
    fsp.readFile(new URL('../docs/MACOS_HOST_P0.md',import.meta.url),'utf8'),
    fsp.readFile(new URL('../package.json',import.meta.url),'utf8').then(JSON.parse)
  ]);
  assert.equal(packageJson.scripts['p0:host'],'node scripts/p0-host-preflight.mjs');
  assert.equal(packageJson.scripts['service:macos'],'node scripts/macos-launch-agent.mjs');
  for(const required of ['JOYCREW_ENABLED=0','npm run p0:host','npm run service:macos -- install','backup v2','LaunchAgent','不启用 Joycrew'])assert.match(document,new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(document,/本地项目文件夹是真实工作文件来源/);
  assert.match(document,/远程访问.*本机 P0 通过后再启用/);
});
