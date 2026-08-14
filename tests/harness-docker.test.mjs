import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('production image includes the locked Harness runtime on Node 24',async()=>{
  const dockerfile=await fsp.readFile('Dockerfile','utf8');
  assert.match(dockerfile,/^FROM node:24-alpine$/m);
  assert.match(dockerfile,/COPY --chown=node:node harness\/package\.json harness\/package-lock\.json \.\/harness\//);
  assert.match(dockerfile,/npm ci --prefix harness --omit=dev --ignore-scripts/);
  assert.match(dockerfile,/COPY --chown=node:node harness \.\/harness/);
  assert.match(dockerfile,/USER node/);
});
