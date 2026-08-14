import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(file){return fsp.readFile(file,'utf8');}

test('Harness Copilot 未启用时不渲染卡片',async()=>{
  const script=await read('public/harness-navigator.js');
  assert.match(script,/const visible=Boolean\(status\?\.available\)\|\|Boolean\(status\?\.enabled\)/);
  assert.match(script,/if\(!visible\)\{root\?\.remove\(\);lastMountedHtml='';return;\}/);
});

test('AI 面板文案是大白话，工程术语已移除',async()=>{
  const script=await read('public/app.js');
  assert.match(script,/AI 助手/);
  assert.match(script,/需要你决定的事/);
  assert.match(script,/可以这样问右侧 AI/);
  assert.doesNotMatch(script,/AI CONTROL PLANE/);
  assert.doesNotMatch(script,/状态源：state\.json/);
  assert.doesNotMatch(script,/工具白名单/);
  assert.doesNotMatch(script,/人工决策区/);
});

test('侧边栏收尾区折叠组默认收起',async()=>{
  const [script,styles]=await Promise.all([read('public/app.js'),read('public/styles.css')]);
  assert.match(script,/data-action="toggle-cleanup"/);
  assert.match(script,/class="cleanup-group/);
  assert.match(script,/收尾区/);
  assert.match(styles,/\.cleanup-group\{display:none\}/);
  assert.match(styles,/\.cleanup-group\.open\{display:block\}/);
});

test('顶栏不再有同步类按钮，三个迁移按钮在对应页面',async()=>{
  const script=await read('public/app.js');
  const topbar=(script.match(/function topbar\([^)]*\)\{return `([^`]*)`;\}/)||[])[1]||'';
  assert.match(topbar,/data-action="new-project"/);
  assert.doesNotMatch(topbar,/data-action="sync-all"/);
  assert.doesNotMatch(topbar,/data-action="sync-feishu"/);
  assert.match(script,/data-action="sync-all">同步所有项目/);
  assert.match(script,/data-action="sync-feishu">同步得到大脑待办/);
  assert.match(script,/data-getnote-action="publish-summary">沉淀今日总结/);
});
