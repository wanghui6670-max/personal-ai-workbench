import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  chooseMacosDataDir,
  chooseMacosWorkspace,
  encodeEnvValue,
  envValuesFromSource,
  macosP0Updates,
  macosUpgradeUpdates,
  restoreEnvFile,
  upsertEnvSource,
  writeEnvAtomically
} from '../src/macos-bootstrap.mjs';

async function temp(t){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'macos-bootstrap-test-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return root;}

test('env upsert preserves secrets, quotes spaces, and removes duplicate managed keys',()=>{
  const source='# existing\nPORT=4173\nOPENAI_API_KEY=keep-me\nDATA_DIR="/old data"\nPORT=9999\n';
  const updates=macosP0Updates({workspaceRoot:'/Users/wanghui/AI-Work-OS',dataDir:'/Users/wanghui/Library/Application Support/PersonalAIWorkbench/data',port:44173});
  const output=upsertEnvSource(source,updates);
  assert.equal((output.match(/^PORT=/gm)||[]).length,1);
  assert.match(output,/OPENAI_API_KEY=keep-me/);
  assert.match(output,/DATA_DIR="\/Users\/wanghui\/Library\/Application Support\/PersonalAIWorkbench\/data"/);
  assert.equal(envValuesFromSource(output).WORKSPACE_ROOT,'/Users/wanghui/AI-Work-OS');
  assert.equal(envValuesFromSource(output).OPENAI_API_KEY,'keep-me');
  assert.equal(encodeEnvValue('plain/path'),'plain/path');
  assert.equal(encodeEnvValue('path with spaces'),'"path with spaces"');
});

test('first install disables external runtimes but upgrade bindings preserve validated runtime settings',()=>{
  const options={workspaceRoot:'/Users/wanghui/AI-Work-OS',dataDir:'/Users/wanghui/Library/Application Support/PersonalAIWorkbench/data',port:44173};
  const first=macosP0Updates(options);
  assert.equal(first.JOYCREW_ENABLED,'0');
  assert.equal(first.HARNESS_ENABLED,'0');
  assert.equal(first.AI_PROVIDER_ENABLED,'0');

  const source=[
    'JOYCREW_ENABLED=1',
    'JOYCREW_BASE_URL=http://127.0.0.1:4000',
    'HARNESS_ENABLED=1',
    'HARNESS_PROVIDER_API_KEY=keep-harness-secret',
    'AI_PROVIDER_ENABLED=1',
    'AI_PROVIDER_API_KEY=keep-provider-secret',
    'PORT=41000',
    ''
  ].join('\n');
  const upgrade=macosUpgradeUpdates(options);
  assert.equal('JOYCREW_ENABLED' in upgrade,false);
  assert.equal('HARNESS_ENABLED' in upgrade,false);
  assert.equal('AI_PROVIDER_ENABLED' in upgrade,false);
  const output=upsertEnvSource(source,upgrade);
  const values=envValuesFromSource(output);
  assert.equal(values.JOYCREW_ENABLED,'1');
  assert.equal(values.HARNESS_ENABLED,'1');
  assert.equal(values.AI_PROVIDER_ENABLED,'1');
  assert.equal(values.HARNESS_PROVIDER_API_KEY,'keep-harness-secret');
  assert.equal(values.AI_PROVIDER_API_KEY,'keep-provider-secret');
  assert.equal(values.PORT,'44173');
});

test('workspace selection prefers explicit and existing bindings, then the known home AI-Work-OS root',async t=>{
  const root=await temp(t);
  const home=path.join(root,'home');
  const known=path.join(home,'AI-Work-OS');
  await fsp.mkdir(known,{recursive:true});
  assert.equal(await chooseMacosWorkspace({home}),known);
  const explicit=path.join(root,'custom-workspace');
  await fsp.mkdir(explicit);
  assert.equal(await chooseMacosWorkspace({home,explicit}),explicit);
  await assert.rejects(()=>chooseMacosWorkspace({home,existing:path.join(root,'missing')}),/现有 \.env/);
});

test('data selection preserves legacy repository data before choosing Application Support',async t=>{
  const root=await temp(t);
  const appRoot=path.join(root,'repo');
  const home=path.join(root,'home');
  await fsp.mkdir(path.join(appRoot,'data'),{recursive:true});
  await fsp.writeFile(path.join(appRoot,'data','state.json'),'{}','utf8');
  assert.equal(await chooseMacosDataDir({appRoot,home}),path.join(appRoot,'data'));
  await fsp.rm(path.join(appRoot,'data','state.json'));
  assert.equal(await chooseMacosDataDir({appRoot,home}),path.join(home,'Library','Application Support','PersonalAIWorkbench','data'));
});

test('atomic env write creates a private backup and can restore exactly',async t=>{
  const root=await temp(t);
  const file=path.join(root,'.env');
  const backupDir=path.join(root,'backups');
  await fsp.writeFile(file,'PORT=1\n',{encoding:'utf8',mode:0o600});
  const record=await writeEnvAtomically(file,'PORT=2\n',{backupDir});
  assert.equal(await fsp.readFile(file,'utf8'),'PORT=2\n');
  assert.equal(await fsp.readFile(record.backupPath,'utf8'),'PORT=1\n');
  await restoreEnvFile(file,record);
  assert.equal(await fsp.readFile(file,'utf8'),'PORT=1\n');
});

test('P0 updates refuse overlapping directories',()=>{
  assert.throws(()=>macosP0Updates({workspaceRoot:'/Users/wanghui/AI-Work-OS',dataDir:'/Users/wanghui/AI-Work-OS/data'}),/不能相同或互相嵌套/);
  assert.throws(()=>macosUpgradeUpdates({workspaceRoot:'/Users/wanghui/AI-Work-OS',dataDir:'/Users/wanghui/AI-Work-OS/data'}),/不能相同或互相嵌套/);
});

test('one-click entry, bootstrap, service controls, package scripts, and docs stay aligned',async()=>{
  const [command,bootstrap,bootstrapModule,service,packageJson,document,commandStat]=await Promise.all([
    fsp.readFile(new URL('../install-macos.command',import.meta.url),'utf8'),
    fsp.readFile(new URL('../scripts/macos-bootstrap.mjs',import.meta.url),'utf8'),
    fsp.readFile(new URL('../src/macos-bootstrap.mjs',import.meta.url),'utf8'),
    fsp.readFile(new URL('../scripts/macos-launch-agent.mjs',import.meta.url),'utf8'),
    fsp.readFile(new URL('../package.json',import.meta.url),'utf8').then(JSON.parse),
    fsp.readFile(new URL('../docs/MACOS_ONE_CLICK.md',import.meta.url),'utf8'),
    fsp.stat(new URL('../install-macos.command',import.meta.url))
  ]);
  assert.ok((commandStat.mode&0o111)!==0,'install-macos.command must be executable');
  assert.match(command,/git pull --ff-only origin main/);
  assert.match(command,/scripts\/macos-bootstrap\.mjs/);
  assert.doesNotMatch(command,/curl[^\n]*\|\s*(?:ba|z)?sh|\beval\b/);
  assert.match(bootstrapModule,/macosUpgradeUpdates/);
  assert.match(bootstrapModule,/AI-Work-OS/);
  assert.match(bootstrap,/p0-host-preflight\.mjs/);
  assert.match(bootstrap,/deploymentMode/);
  assert.match(bootstrap,/--preserve-runtime/);
  assert.match(bootstrap,/serviceCommand\('install'/);
  assert.match(service,/WORKBENCH_BUILD_COMMIT/);
  assert.match(service,/--preserve-runtime/);
  assert.match(service,/command==='start'/);
  assert.match(service,/command==='stop'/);
  assert.equal(packageJson.scripts['bootstrap:macos'],'node scripts/macos-bootstrap.mjs');
  for(const phrase of ['双击 install-macos.command','/Users/wanghui/AI-Work-OS','backup v2','首次安装','后续升级','失败时恢复'])assert.match(document,new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
