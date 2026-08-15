import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(file){return fsp.readFile(file,'utf8');}

test('Harness 启用后右侧只保留一个 AI 控制面',async()=>{
  const script=await read('public/harness-navigator.js');
  assert.match(script,/const visible=Boolean\(status\?\.available\)\|\|Boolean\(status\?\.enabled\)/);
  assert.match(script,/panel\.classList\.toggle\('harness-primary',visible\)/);
});

test('接管态下应用自带 AI 对话被 CSS 隐藏',async()=>{
  const styles=await read('public/harness-navigator.css');
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-chat/);
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-input/);
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-capabilities/);
  assert.match(styles,/\.ai-panel\.harness-primary \.ai-plan\{display:none\}/);
});

test('默认使用 Workbench 薄面板，只有实验模式且 attestation 通过才渲染 iframe',async()=>{
  const [script,styles]=await Promise.all([read('public/harness-navigator.js'),read('public/harness-navigator.css')]);
  assert.match(script,/status\?\.uiMode==='embedded_experimental'/);
  assert.match(script,/status\?\.embeddedWeb\?\.verified===true/);
  assert.match(script,/sandbox="allow-scripts allow-same-origin allow-forms"/);
  assert.match(script,/referrerpolicy="no-referrer"/);
  assert.match(script,/原生 DSH 界面未通过组成校验/);
  assert.match(styles,/\.harness-embed\{flex:1/);
});
