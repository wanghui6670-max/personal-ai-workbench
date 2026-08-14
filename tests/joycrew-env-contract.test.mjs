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
  for(const key of ['HARNESS_ENABLED','JOYCREW_ENABLED','JOYCREW_BASE_URL','JOYCREW_TRUSTED_PROXY_TOKEN','WORKBENCH_JOYCREW_RATE_LIMIT'])assert.ok(WORKBENCH_ENV_KEYS.includes(key));
});

test('env parser still rejects undeclared and command-substitution values',()=>{
  const parsed=parseWorkbenchEnv('JOYCREW_BASE_URL=$(cat /tmp/secret)\nJOYCREW_RANDOM_OVERRIDE=1\n');
  assert.equal(parsed.values.JOYCREW_BASE_URL,undefined);
  assert.equal(parsed.ignored.length,2);
  assert.deepEqual(parsed.ignored.map(item=>item.reason).sort(),['undeclared','unsafe']);
});
