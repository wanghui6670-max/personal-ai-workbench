import test from 'node:test';
import assert from 'node:assert/strict';
import { createEndpointRateLimiter,createSyncCoordinator,endpointRateLimitConfig,RATE_LIMIT_CAPS,RATE_LIMIT_DEFAULTS } from '../src/rate-limit.mjs';

test('endpoint limiter is deterministic, per-client, and bounded',()=>{
  let at=1_000;
  const limiter=createEndpointRateLimiter({limits:{capture:2,sync:1,morning:1},windowMs:1_000,maxClients:2,now:()=>at});
  assert.equal(limiter.consume('capture','client-a').allowed,true);
  assert.equal(limiter.consume('capture','client-a').allowed,true);
  const blocked=limiter.consume('capture','client-a');
  assert.equal(blocked.allowed,false);assert.equal(blocked.retryAfterMs,1_000);
  assert.equal(limiter.consume('capture','client-b').allowed,true);
  assert.equal(limiter.consume('capture','client-c').allowed,true);
  assert.equal(limiter.size,2,'rotating client keys cannot grow memory without bound');
  assert.equal(limiter.consume('capture','client-a').allowed,true,'evicted clients start a fresh bounded window');
  at=2_000;
  assert.equal(limiter.consume('capture','client-a').allowed,true,'a completed window resets deterministically');
});

test('environment settings retain safe upper bounds',()=>{
  const config=endpointRateLimitConfig({
    WORKBENCH_RATE_LIMIT_WINDOW_MS:'999999999',
    WORKBENCH_RATE_LIMIT_MAX_CLIENTS:'999999999',
    WORKBENCH_CAPTURE_RATE_LIMIT:'999999999',
    WORKBENCH_SYNC_RATE_LIMIT:'0',
    WORKBENCH_MORNING_RATE_LIMIT:'not-a-number'
  });
  assert.equal(config.windowMs,RATE_LIMIT_CAPS.windowMs);
  assert.equal(config.maxClients,RATE_LIMIT_CAPS.maxClients);
  assert.equal(config.limits.capture,RATE_LIMIT_CAPS.limits.capture);
  assert.equal(config.limits.sync,1);
  assert.equal(config.limits.morning,RATE_LIMIT_DEFAULTS.limits.morning);
});

test('sync coordinator rejects overlapping work on the same project',()=>{
  const coordinator=createSyncCoordinator();
  const first=coordinator.tryAcquireProject('p-1');assert.ok(first);
  assert.equal(coordinator.tryAcquireProject('p-1'),null);
  const other=coordinator.tryAcquireProject('p-2');assert.ok(other,'different single-project syncs may proceed');
  assert.equal(coordinator.tryAcquireAll(),null,'sync-all waits while any project sync is active');
  first.release();other.release();
  const all=coordinator.tryAcquireAll();assert.ok(all);
  assert.equal(coordinator.tryAcquireProject('p-1'),null,'single-project sync waits while sync-all is active');
  all.release();
  assert.ok(coordinator.tryAcquireProject('p-1'));
});
