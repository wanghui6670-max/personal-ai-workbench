import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(file){return fsp.readFile(file,'utf8');}

test('DSH 右栏使用 IDE 风格极简顶部和内容流，不保留产品介绍 chrome',async()=>{
  const [script,styles]=await Promise.all([read('public/harness-navigator.js'),read('public/harness-navigator.css')]);
  assert.match(script,/<header class="harness-nav-head"><strong>聊天<\/strong>/);
  assert.match(script,/data-harness-new title="新对话"/);
  assert.match(script,/data-action="settings" title="工作台设置"/);
  assert.match(styles,/\.harness-nav-message\.assistant>div\{padding:0;background:transparent;border:0/);
  assert.match(styles,/\.harness-nav-message\.user>div\{padding:8px 11px;border-radius:10px/);
  assert.doesNotMatch(script,/统一工作 Copilot/);
  assert.doesNotMatch(script,/连续会话 · Workbench/);
});

test('DSH 空态靠前展示，并提供真实只读工作入口而不是装饰卡片',async()=>{
  const [script,theme]=await Promise.all([read('public/harness-navigator.js'),read('public/theme-focus.css')]);
  assert.match(script,/class="harness-nav-empty-actions"/);
  assert.match(script,/data-harness-suggest="帮我看今天/);
  assert.match(script,/data-harness-suggest="查看收件箱/);
  assert.match(script,/data-harness-suggest="查看项目/);
  assert.match(script,/const suggestion=event\.target\.closest\?\.\('\[data-harness-suggest\]'\);if\(suggestion\)\{void sendMessage\(suggestion\.dataset\.harnessSuggest\);return;\}/);
  assert.match(theme,/\.harness-nav-empty\{margin:72px auto auto!important/);
  assert.match(theme,/\.harness-nav-empty-actions button\{/);
});

test('工具轨迹只有真实工具调用时出现，并以轻量折叠摘要呈现',async()=>{
  const [script,styles]=await Promise.all([read('public/harness-navigator.js'),read('public/harness-navigator.css')]);
  assert.match(script,/const calls=items\.filter\(item=>item\.type==='tool_call'\);if\(!calls\.length\)return''/);
  assert.match(script,/已使用 \$\{calls\.length\} 个工具/);
  assert.match(styles,/\.harness-nav-trajectory\{flex:none;margin-top:-6px;border:0;background:transparent\}/);
});

test('右栏默认更宽且支持拖拽调整，但不持久化到浏览器存储',async()=>{
  const [script,styles]=await Promise.all([read('public/harness-navigator.js'),read('public/harness-navigator.css')]);
  assert.match(script,/const DEFAULT_PANEL_WIDTH=500/);
  assert.match(script,/data-harness-resize/);
  assert.match(script,/document\.addEventListener\('pointerdown',beginResize\)/);
  assert.match(script,/--dsh-panel-width/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB|IndexedDB/);
  assert.match(styles,/grid-template-columns:minmax\(0,1fr\) var\(--dsh-panel-width,500px\)/);
  assert.match(styles,/\.harness-nav-resize\{position:absolute/);
});

test('底部 composer 采用 Agent 风格并展示实际模型，不制造未接入附件能力',async()=>{
  const script=await read('public/harness-navigator.js');
  assert.match(script,/placeholder="描述要处理的内容…"/);
  assert.match(script,/<span>Agent<\/span><span>\$\{model\}<\/span>/);
  assert.match(script,/class="harness-nav-send"/);
  assert.doesNotMatch(script,/附件|上传文件|data-harness-attach/);
});
