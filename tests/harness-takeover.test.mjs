import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(file){return fsp.readFile(file,'utf8');}

test('Harness 可用时右侧面板加 harness-primary 接管标记',async()=>{
  const script=await read('public/harness-navigator.js');
  assert.match(script,/const available=Boolean\(status\?\.available\)/);
  assert.match(script,/panel\.classList\.toggle\('harness-primary',available\)/);
});

test('接管态下应用自带 AI 对话被 CSS 隐藏',async()=>{
  const styles=await read('public/harness-navigator.css');
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-chat/);
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-input/);
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-capabilities/);
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-plan\{display:none\}/);
});
