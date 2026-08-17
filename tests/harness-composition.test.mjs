import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHarnessPlatform} from '../src/harness-platform.mjs';
import {createAihotPack} from '../plugins/aihot/manifest.mjs';

test('business composition installs new packs without changing Harness platform bootstrap',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-composition-'));
  const legacyRegistry={tools:[],async call(){throw new Error('not expected');}};
  const aihot=createAihotPack({client:{latest:async()=>({items:['ok']})}});
  const runtime=createHarnessPlatform({mcpRegistry:legacyRegistry,dataDir:root,packs:[aihot]});
  assert.deepEqual(runtime.describe().packs,['personal-workbench','engineering-methods','workbench-v3-bridge','aihot']);
  const result=await runtime.invoke('aihot.latest',{}, {agentId:'research-agent'});
  assert.deepEqual(result.result,{items:['ok']});
});

test('business composition fails closed on duplicate pack capabilities',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-composition-'));
  const legacyRegistry={tools:[],async call(){throw new Error('not expected');}};
  const pack={id:'extra-one',name:'One',version:'1.0.0',capabilities:[{id:'shared.capability'}]};
  const duplicate={id:'extra-two',name:'Two',version:'1.0.0',capabilities:[{id:'shared.capability'}]};
  assert.throws(()=>createHarnessPlatform({mcpRegistry:legacyRegistry,dataDir:root,packs:[pack,duplicate]}),/already registered/);
});
