import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoginAttemptLimiter} from '../src/auth.mjs';

test('login attempt limiter applies bounded exponential backoff and resets on success',()=>{
  let now=1000;
  const limiter=createLoginAttemptLimiter({now:()=>now,freeFailures:2,baseDelayMs:1000,maxDelayMs:4000});

  assert.deepEqual(limiter.recordFailure('client-a'),{allowed:true,retryAfterMs:0});
  assert.deepEqual(limiter.recordFailure('client-a'),{allowed:true,retryAfterMs:0});
  assert.deepEqual(limiter.recordFailure('client-a'),{allowed:false,retryAfterMs:1000});
  assert.deepEqual(limiter.check('client-a'),{allowed:false,retryAfterMs:1000});

  now+=1000;
  assert.deepEqual(limiter.check('client-a'),{allowed:true,retryAfterMs:0});
  assert.deepEqual(limiter.recordFailure('client-a'),{allowed:false,retryAfterMs:2000});

  limiter.recordSuccess('client-a');
  assert.deepEqual(limiter.check('client-a'),{allowed:true,retryAfterMs:0});
});
