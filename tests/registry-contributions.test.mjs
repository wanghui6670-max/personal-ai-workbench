import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,HarnessRuntime} from '../platform/index.mjs';

test('Registry installs skills, methods and views as first-class reusable contributions',()=>{
  const registry=new CapabilityRegistry();
  registry.install({
    id:'method-pack',
    name:'Methods',
    version:'1.0.0',
    skills:['skill.research'],
    methods:[{id:'method.first-principles',description:'reason from irreducible facts'}],
    views:[{id:'view.intelligence',optional:true}]
  });
  assert.equal(registry.getSkill('skill.research').packId,'method-pack');
  assert.equal(registry.getMethod('method.first-principles').description,'reason from irreducible facts');
  assert.equal(registry.getView('view.intelligence').optional,true);
  const runtime=new HarnessRuntime({registry});
  assert.deepEqual(runtime.describe().skills,['skill.research']);
  assert.deepEqual(runtime.describe().methods,['method.first-principles']);
  assert.deepEqual(runtime.describe().views,['view.intelligence']);
});

test('Registry fails closed when two packs claim the same reusable contribution',()=>{
  const registry=new CapabilityRegistry();
  registry.install({id:'one-pack',name:'One',version:'1.0.0',skills:['skill.shared']});
  assert.throws(()=>registry.install({id:'two-pack',name:'Two',version:'1.0.0',skills:['skill.shared']}),/skill already registered/);
});
