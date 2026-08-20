import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const doctorScript = path.join(projectRoot, 'scripts', 'doctor.mjs');

function runDoctor(env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [doctorScript, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
        WORKBENCH_PASSWORD: '',
        JOYCREW_ENABLED: '0',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const stableDoctorCheckIds = [
  'node_runtime',
  'data_dir',
  'workspace_root',
  'getnote_runtime',
  'lark_cli',
  'ai_provider',
  'access_control',
  'joycrew'
];

function parseDoctorJson(result) {
  assert.doesNotMatch(result.stdout, /环境自检|[✓!]/, 'JSON stdout must not contain the human report');
  assert.equal(result.stderr, '', result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'ok', 'checks']);
  assert.equal(report.schemaVersion, 1);
  assert.equal(typeof report.ok, 'boolean');
  assert.ok(Array.isArray(report.checks));
  const allowedKeys = new Set(['id', 'required', 'ok', 'mode', 'liveRead', 'code', 'message']);
  for (const check of report.checks) {
    assert.equal(typeof check.id, 'string');
    assert.equal(typeof check.required, 'boolean', `${check.id} must declare whether it is required`);
    assert.equal(typeof check.ok, 'boolean', `${check.id} must declare its result`);
    assert.deepEqual(Object.keys(check).filter(key => !allowedKeys.has(key)), [], `${check.id} exposes an unsafe field`);
  }
  assert.equal(new Set(report.checks.map(check => check.id)).size, report.checks.length, 'check ids must be unique');
  assert.deepEqual(
    stableDoctorCheckIds.filter(id => !report.checks.some(check => check.id === id)),
    [],
    'JSON report must always expose the stable P0 check ids'
  );
  return report;
}

async function prepareEnabledStore(root,{journalDocumentUrl=''}={}){
  const dataDir=path.join(root,'data');
  const workspaceRoot=path.join(root,'workspace');
  await fsp.mkdir(workspaceRoot,{recursive:true});
  const store=new JsonStore(dataDir);
  await store.ensure();
  await store.updateConfig(config=>{
    config.settings={
      ...(config.settings||{}),
      externalTaskPipeline:{
        enabled:true,provider:'getnote_cli',noteLimit:100,timeZone:'Asia/Shanghai',journalDocumentUrl,
        journalHeading:'每日工作日记',calendarEnabled:true,calendarName:'个人 AI 工作台'
      }
    };
    return true;
  });
  return{dataDir,workspaceRoot};
}

async function startPrivateRuntime(token){
  const server=http.createServer((req,res)=>{
    if(req.method!=='GET'||!req.url?.startsWith('/v1/notes')){res.writeHead(404).end();return;}
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({success:true,data:{notes:[],has_more:false}}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  return{server,baseUrl:`http://127.0.0.1:${address.port}`};
}

test('doctor preserves a pre-existing legacy write-test file and reports disabled external pipeline', async t => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-doctor-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));

  const dataDir = path.join(tempRoot, 'data');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const legacyProbe = path.join(workspaceRoot, '.workbench-write-test');
  const originalContent = 'user-owned content\n';
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.writeFile(legacyProbe, originalContent, 'utf8');

  const result = await runDoctor({ DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceRoot });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /✓ 得到大脑待办管线: 未启用/);
  assert.equal(await fsp.readFile(legacyProbe, 'utf8'), originalContent);
  const entries = await fsp.readdir(workspaceRoot);
  assert.deepEqual(entries.filter(name => name.startsWith('.workbench-write-test-')), [], 'doctor must clean up its unique probe');
});

test('doctor exits non-zero when the workspace target is a file', async t => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-doctor-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));

  const dataDir = path.join(tempRoot, 'data');
  const workspaceFile = path.join(tempRoot, 'workspace-file');
  const originalContent = 'not a directory\n';
  await fsp.writeFile(workspaceFile, originalContent, 'utf8');

  const result = await runDoctor({ DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceFile });

  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /! 文件系统:/);
  assert.equal(await fsp.readFile(workspaceFile, 'utf8'), originalContent);
});

test('doctor requires GetNote runtime but not lark-cli when Feishu sink is not configured', async t => {
  const tempRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-doctor-getnote-only-'));
  t.after(()=>fsp.rm(tempRoot,{recursive:true,force:true}));
  const {dataDir,workspaceRoot}=await prepareEnabledStore(tempRoot);
  const emptyBin=path.join(tempRoot,'empty-bin');await fsp.mkdir(emptyBin,{recursive:true});

  const result=await runDoctor({DATA_DIR:dataDir,WORKSPACE_ROOT:workspaceRoot,PATH:emptyBin,GETNOTE_RUNTIME_MODE:'local_cli'});

  assert.equal(result.code,1,result.stderr||result.stdout);
  assert.match(result.stdout,/✓ 得到大脑待办管线: 最近 100 篇 \+ 未完成旧笔记追踪/);
  assert.match(result.stdout,/! GetNote 读取运行时: local_cli 未找到 getnote/);
  assert.match(result.stdout,/✓ 飞书每日工作日记: 未配置；核心 GetNote → Workbench 同步不依赖 lark-cli/);
  assert.doesNotMatch(result.stdout,/! 飞书每日工作日记:/);
  assert.match(result.stdout,/✓ 本机日历路径:/);
});

test('doctor requires lark-cli only when the Feishu journal sink is configured', async t => {
  const tempRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-doctor-feishu-'));
  t.after(()=>fsp.rm(tempRoot,{recursive:true,force:true}));
  const {dataDir,workspaceRoot}=await prepareEnabledStore(tempRoot,{journalDocumentUrl:'https://example.feishu.cn/wiki/journal'});
  const emptyBin=path.join(tempRoot,'empty-bin');await fsp.mkdir(emptyBin,{recursive:true});

  const result=await runDoctor({DATA_DIR:dataDir,WORKSPACE_ROOT:workspaceRoot,PATH:emptyBin,GETNOTE_RUNTIME_MODE:'local_cli'});

  assert.equal(result.code,1,result.stderr||result.stdout);
  assert.match(result.stdout,/! GetNote 读取运行时: local_cli 未找到 getnote/);
  assert.match(result.stdout,/! 飞书每日工作日记: 已配置飞书 sink，但未找到 lark-cli 可执行文件/);
});

test('doctor accepts private_http GetNote Runtime without a local getnote binary or Feishu CLI',async t=>{
  const tempRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-doctor-private-runtime-'));
  t.after(()=>fsp.rm(tempRoot,{recursive:true,force:true}));
  const {dataDir,workspaceRoot}=await prepareEnabledStore(tempRoot);
  const emptyBin=path.join(tempRoot,'empty-bin');await fsp.mkdir(emptyBin,{recursive:true});
  const token='doctor-private-runtime-token-1234567890';
  const runtime=await startPrivateRuntime(token);
  t.after(()=>new Promise(resolve=>runtime.server.close(resolve)));

  const result=await runDoctor({
    DATA_DIR:dataDir,WORKSPACE_ROOT:workspaceRoot,PATH:emptyBin,
    GETNOTE_RUNTIME_MODE:'private_http',GETNOTE_RUNTIME_BASE_URL:runtime.baseUrl,GETNOTE_RUNTIME_SERVICE_TOKEN:token
  });

  assert.equal(result.code,0,result.stderr||result.stdout);
  assert.match(result.stdout,/✓ GetNote 读取运行时: private_http:/);
  assert.match(result.stdout,/只读连通性与鉴权检查通过/);
  assert.match(result.stdout,/✓ 飞书每日工作日记: 未配置/);
  assert.doesNotMatch(result.stdout,/未找到 getnote/);
});

test('doctor --json emits only the stable machine-readable contract without sensitive values', async t => {
  const secretMarker = 'doctor-secret-marker-8f55bdf1';
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `workbench-${secretMarker}-`));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, 'data');
  const workspaceRoot = path.join(tempRoot, 'workspace');

  const result = await runDoctor({
    DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspaceRoot,
    OPENAI_API_KEY: secretMarker,
    WORKBENCH_PASSWORD: `${secretMarker}-password`
  }, ['--json']);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, new RegExp(secretMarker));
  const report = parseDoctorJson(result);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.id === 'access_control')?.ok, true);
  assert.equal(report.checks.find(check => check.id === 'ai_provider')?.required, false);
});

test('doctor --json returns a complete report and non-zero exit when a required check fails', async t => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-doctor-json-failure-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, 'data');
  const workspaceFile = path.join(tempRoot, 'workspace-file');
  await fsp.writeFile(workspaceFile, 'not a directory\n', 'utf8');

  const result = await runDoctor({ DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceFile }, ['--json']);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = parseDoctorJson(result);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some(check => check.required && !check.ok));
  assert.equal(report.checks.find(check => check.id === 'workspace_root')?.ok, false);
});

test('doctor --json does not claim a live GetNote read when the required CLI check fails', async t => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-doctor-json-getnote-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const { dataDir, workspaceRoot } = await prepareEnabledStore(tempRoot);
  const emptyBin = path.join(tempRoot, 'empty-bin');
  await fsp.mkdir(emptyBin, { recursive: true });

  const result = await runDoctor({
    DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspaceRoot,
    PATH: emptyBin,
    GETNOTE_RUNTIME_MODE: 'local_cli'
  }, ['--json']);

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = parseDoctorJson(result);
  assert.deepEqual(report.checks.find(check => check.id === 'getnote_runtime'), {
    id: 'getnote_runtime',
    required: true,
    ok: false,
    mode: 'local_cli',
    liveRead: false
  });
  assert.deepEqual(report.checks.find(check => check.id === 'lark_cli'), {
    id: 'lark_cli',
    required: false,
    ok: true,
    mode: 'disabled',
    liveRead: false
  });
});
