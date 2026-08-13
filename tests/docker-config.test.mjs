import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequestGuard } from '../src/http.mjs';

const read = (file) => fsp.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const execFileAsync=promisify(execFile);
const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Docker build excludes local secrets and runtime state', async () => {
  const dockerignore = await read('.dockerignore');

  for (const entry of ['.env', 'node_modules/', 'data/', 'workspace/', '.git']) {
    assert.match(dockerignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('image runs as non-root and initializes runtime mounts outside the image', async () => {
  const dockerfile = await read('Dockerfile');

  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /chown -R node:node \/data \/workspace/);
  assert.match(dockerfile, /^HEALTHCHECK .*$/m);
  assert.match(dockerfile, /127\.0\.0\.1.*\/api\/health/);
  assert.doesNotMatch(dockerfile, /^COPY(?:\s+--\S+)*\s+(?:\.\/?|data\/?)(?:\s|$)/m);
});

test('Compose is local-only by default and keeps env file optional', async () => {
  const [compose,example] = await Promise.all([read('docker-compose.yml'),read('.env.example')]);

  assert.match(compose, /\$\{WORKBENCH_BIND_ADDRESS:-127\.0\.0\.1\}/);
  assert.match(compose, /path: \.env\s+required: false/);
  assert.match(compose, /source: \$\{WORKBENCH_DATA_PATH:-\.\/data\}\s+target: \/data/);
  assert.match(compose, /source: \$\{WORKBENCH_WORKSPACE_PATH:-\.\/workspace\}\s+target: \/workspace\s+read_only: false/);
  assert.match(compose, /user: "\$\{WORKBENCH_UID:-1000\}:\$\{WORKBENCH_GID:-1000\}"/);
  assert.match(compose, /\$\{WORKBENCH_PORT:-4173\}:\$\{WORKBENCH_PORT:-4173\}/);
  assert.match(compose, /PORT: "\$\{WORKBENCH_PORT:-4173\}"/);
  for(const name of ['WORKBENCH_BIND_ADDRESS','WORKBENCH_PORT','WORKBENCH_DATA_PATH','WORKBENCH_WORKSPACE_PATH','WORKBENCH_UID','WORKBENCH_GID'])assert.match(example,new RegExp(`^# ${name}=`, 'm'));
});

test('Compose custom port drives published target and container PORT together', async t => {
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-compose-port-'));
  t.after(()=>fsp.rm(temp,{recursive:true,force:true}));
  const envFile=path.join(temp,'compose.env');
  await fsp.writeFile(envFile,'WORKBENCH_PORT=8080\n','utf8');
  let stdout;
  try{
    const env={...process.env,COMPOSE_PROJECT_NAME:'workbench-port-test'};
    for(const key of Object.keys(env))if(key.startsWith('WORKBENCH_'))delete env[key];
    ({stdout}=await execFileAsync('docker',['compose','--env-file',envFile,'config','--format','json'],{cwd:projectRoot,env}));
  }catch(error){
    if(error.code==='ENOENT')return t.skip('docker compose is not installed');
    throw error;
  }
  const service=JSON.parse(stdout).services.workbench;
  assert.equal(String(service.environment.PORT),'8080');
  assert.equal(service.ports.length,1);
  assert.equal(String(service.ports[0].published),'8080');
  assert.equal(Number(service.ports[0].target),8080);
  assert.equal(service.ports[0].host_ip,'127.0.0.1');
});

test('Host guard accepts the loopback Host selected by a custom container PORT', () => {
  const guard=createRequestGuard({bindHost:'0.0.0.0',port:8080});
  assert.equal(guard({method:'GET',headers:{host:'127.0.0.1:8080'}}),null);
  assert.deepEqual(guard({method:'GET',headers:{host:'127.0.0.1:4173'}}),{status:421,error:'请求 Host 不受信任'});
});
