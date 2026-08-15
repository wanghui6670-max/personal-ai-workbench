import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkbenchEnv, WORKBENCH_ENV_KEYS } from '../src/env.mjs';

test('Workbench env allowlist loads Harness and Joycrew server-only configuration',()=>{
  const source=`HARNESS_ENABLED=1\nJOYCREW_ENABLED=1\nJOYCREW_BASE_URL=http://127.0.0.1:4000\nJOYCREW_AUTH_MODE=trusted_proxy\nJOYCREW_TRUSTED_PROXY_TOKEN=${'x'.repeat(24)}\nJOYCREW_WORKSPACE_ID=ws\nJOYCREW_USER_ID=chris\nJOYCREW_ROLE=admin\n`;
  const parsed=parseWorkbenchEnv(source);
  assert.equal(parsed.values.HARNESS_ENABLED,'1');
  assert.equal(parsed.values.JOYCREW_BASE_URL,'http://127.0.0.1:4000');
  assert.equal(parsed.values.JOYCREW_ROLE,'admin');
  assert.deepEqual(parsed.ignored,[]);
  for(const key of ['HARNESS_ENABLED','HARNESS_UI_MODE','HARNESS_WEB_URL','HARNESS_WEB_ATTESTATION_URL','JOYCREW_ENABLED','JOYCREW_BASE_URL','JOYCREW_TRUSTED_PROXY_TOKEN','WORKBENCH_JOYCREW_RATE_LIMIT'])assert.ok(WORKBENCH_ENV_KEYS.includes(key));
});

test('Workbench env allowlist loads experimental DSH embed configuration',()=>{
  const parsed=parseWorkbenchEnv('HARNESS_ENABLED=1\nHARNESS_UI_MODE=embedded_experimental\nHARNESS_WEB_URL=http://127.0.0.1:3080/\nHARNESS_WEB_ATTESTATION_URL=http://127.0.0.1:3080/.well-known/workbench-harness.json\n');
  assert.equal(parsed.values.HARNESS_UI_MODE,'embedded_experimental');
  assert.equal(parsed.values.HARNESS_WEB_URL,'http://127.0.0.1:3080/');
  assert.equal(parsed.values.HARNESS_WEB_ATTESTATION_URL,'http://127.0.0.1:3080/.well-known/workbench-harness.json');
  assert.deepEqual(parsed.ignored,[]);
});

test('env parser still rejects undeclared and command-substitution values',()=>{
  const parsed=parseWorkbenchEnv('JOYCREW_BASE_URL=$(cat /tmp/secret)\nJOYCREW_RANDOM_OVERRIDE=1\n');
  assert.equal(parsed.values.JOYCREW_BASE_URL,undefined);
  assert.equal(parsed.ignored.length,2);
  assert.deepEqual(parsed.ignored.map(item=>item.reason).sort(),['undeclared','unsafe']);
});
