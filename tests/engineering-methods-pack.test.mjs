import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessRuntime} from '../platform/index.mjs';
import {engineeringMethodsPack} from '../packs/engineering-methods/manifest.mjs';

test('engineering methods install as reusable Harness contributions without tools',()=>{
  const runtime=new HarnessRuntime();
  runtime.install(engineeringMethodsPack);
  assert.equal(runtime.registry.getMethod('method.first-principles').packId,'engineering-methods');
  assert.equal(runtime.registry.getMethod('method.superpowers-cycle').packId,'engineering-methods');
  assert.equal(runtime.registry.getSkill('skill.test-first').packId,'engineering-methods');
  assert.equal(runtime.registry.getSkill('skill.verify-before-complete').packId,'engineering-methods');
  assert.deepEqual(runtime.describe().tools,[]);
  assert.equal(runtime.registry.getPack('engineering-methods').metadata.toolPermissions,'none');
});
