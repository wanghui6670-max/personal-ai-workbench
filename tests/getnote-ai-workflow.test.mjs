import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {AI_WORKFLOWS,resolveProviderProfile} from '../src/ai/config.mjs';

test('mixed diary extraction is an explicit provider workflow',()=>{
  assert.equal(AI_WORKFLOWS.includes('mixed_diary_todo_extraction'),true);
});

test('.env.example exposes the complete explicit workflow allowlist',async()=>{
  const example=await fsp.readFile('.env.example','utf8');
  assert.match(
    example,
    /AI_PROVIDER_WORKFLOWS=project_creation,project_progress,morning_dialogue,ai_console,getnote_insight,mixed_diary_todo_extraction/
  );
});

test('OpenAI profile honors an explicitly narrowed workflow allowlist',()=>{
  const profile=resolveProviderProfile({env:{
    AI_PROVIDER_PROFILE:'openai_luna',
    OPENAI_API_KEY:'unit-test-key',
    AI_PROVIDER_WORKFLOWS:'project_creation'
  }});
  assert.deepEqual(profile.workflowAllowlist,['project_creation']);
  assert.equal(profile.workflowAllowlist.includes('mixed_diary_todo_extraction'),false);
});

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
