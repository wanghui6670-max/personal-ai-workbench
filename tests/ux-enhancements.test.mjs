import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(file){return fsp.readFile(file,'utf8');}

test('workbench loads the reversible UX enhancement layer',async()=>{
  const [index,script,styles]=await Promise.all([
    read('public/index.html'),
    read('public/ux-enhancements.js'),
    read('public/ux-enhancements.css')
  ]);
  assert.match(index,/ux-enhancements\.css/);
  assert.match(index,/ux-enhancements\.js/);
  assert.match(script,/personal-ai-workbench\.ai-panel-mode/);
  assert.match(script,/dataset\.uxAction='morning-focus'/);
  assert.match(script,/\/api\/morning\/chat/);
  assert.match(script,/模型已配置，未联网验证/);
  assert.match(styles,/data-ai-panel-mode="rail"/);
  assert.match(styles,/data-ai-panel-mode="closed"/);
});

test('morning focus remains discussion-only, reopens AI and stores no conversation in browser persistence',async()=>{
  const script=await read('public/ux-enhancements.js');
  assert.match(script,/只讨论，不自动安排/);
  assert.match(script,/data-action="today-toggle"/);
  assert.match(script,/morning-focus'\)\{setPanelMode\('open'\);runMorning/);
  assert.doesNotMatch(script,/localStorage\.setItem\([^\n]*morning/i);
  assert.doesNotMatch(script,/sessionStorage|indexedDB/i);
  assert.match(script,/localStorage\.setItem\(PANEL_MODE_KEY,next\)/);
  assert.match(script,/'"':'&quot;'/);
});

test('critical actions keep an in-page receipt and AI results hide raw JSON behind details',async()=>{
  const [script,styles]=await Promise.all([
    read('public/ux-enhancements.js'),
    read('public/ux-enhancements.css')
  ]);
  assert.match(script,/window\.fetch=async function observedFetch/);
  assert.match(script,/ux-action-receipt/);
  assert.match(script,/查看技术详情/);
  assert.match(script,/飞书收件箱已读回/);
  assert.match(styles,/\.ux-action-receipt/);
  assert.match(styles,/\.ux-result-summary/);
  assert.match(styles,/\.ux-technical-details/);
});
