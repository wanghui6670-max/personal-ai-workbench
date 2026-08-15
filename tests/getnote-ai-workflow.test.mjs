import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_WORKFLOWS,resolveProviderProfile} from '../src/ai/config.mjs';

test('GetNote insight is an explicit provider workflow and can be separately allow-listed',()=>{
  assert.equal(AI_WORKFLOWS.includes('getnote_insight'),true);
  const profile=resolveProviderProfile({env:{
    AI_PROVIDER_PROFILE:'third_party_responses',
    AI_PROVIDER_ENABLED:'0',
    AI_PROVIDER_MODEL:'unit-model',
    AI_PROVIDER_BASE_URL:'http://127.0.0.1:11434/v1',
    AI_PROVIDER_ALLOWED_ORIGINS:'http://127.0.0.1:11434',
    AI_PROVIDER_NETWORK_ZONE:'local_loopback',
    AI_PROVIDER_ALLOW_ANONYMOUS:'1',
    AI_PROVIDER_WORKFLOWS:'getnote_insight'
  }});
  assert.deepEqual(profile.workflowAllowlist,['getnote_insight']);
});
