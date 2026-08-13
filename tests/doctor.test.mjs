import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const doctorScript = path.join(projectRoot, 'scripts', 'doctor.mjs');

function runDoctor(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [doctorScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
        WORKBENCH_PASSWORD: '',
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

test('doctor preserves a pre-existing legacy write-test file', async t => {
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
  assert.equal(await fsp.readFile(legacyProbe, 'utf8'), originalContent);
  const entries = await fsp.readdir(workspaceRoot);
  assert.deepEqual(
    entries.filter(name => name.startsWith('.workbench-write-test-')),
    [],
    'doctor must clean up its unique probe'
  );
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
