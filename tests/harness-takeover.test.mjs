import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(file){return fsp.readFile(file,'utf8');}

test('Harness 启用后 DSH 接管整个右侧 AI 控制面',async()=>{
  const script=await read('public/harness-navigator.js');
  assert.match(script,/const visible=Boolean\(status\?\.available\)\|\|Boolean\(status\?\.enabled\)/);
  assert.match(script,/panel\.classList\.toggle\('harness-primary',visible\)/);
  assert.match(script,/panel\.classList\.toggle\('harness-native',Boolean\(webUrl\)\)/);
});

test('DSH 接管态隐藏全部 Workbench AI chrome，而不是只隐藏聊天输入',async()=>{
  const styles=await read('public/harness-navigator.css');
  for(const selector of ['ai-panel-top','ai-context','ai-capabilities','ai-chat','ai-plan','ai-input','ai-foot','ux-morning-panel']){
    assert.match(styles,new RegExp(`\\.ai-panel\\.harness-primary>\\.${selector}`));
  }
  assert.match(styles,/\.ux-morning-panel\{display:none!important\}/);
  assert.match(styles,/\.ai-panel\.harness-primary\{padding:0/);
  assert.match(styles,/\[data-harness-navigator-mount\]\{flex:1/);
});

test('受控 DSH 会话面是全高聊天工作区，并使用底部 composer',async()=>{
  const [script,styles]=await Promise.all([read('public/harness-navigator.js'),read('public/harness-navigator.css')]);
  assert.match(script,/class="harness-nav-card"/);
  assert.match(script,/class="harness-nav-messages"/);
  assert.match(script,/class="harness-nav-form"/);
  assert.match(script,/<textarea name="message"/);
  assert.match(script,/event\.key!=='Enter'\|\|event\.shiftKey\|\|event\.isComposing/);
  assert.match(styles,/\.harness-nav-card\{flex:1/);
  assert.match(styles,/\.harness-nav-messages\{flex:1/);
  assert.match(styles,/\.harness-nav-form\{flex:none/);
});

test('旧 Workbench AI 入口在接管态直接路由成 DSH 对话',async()=>{
  const script=await read('public/harness-navigator.js');
  assert.match(script,/\[data-ux-action="morning-focus"\]/);
  assert.match(script,/document\.querySelector\('\.ai-panel\.harness-primary'\)/);
  assert.match(script,/event\.stopImmediatePropagation\(\)/);
  assert.match(script,/void sendMessage\('开始早晨对焦/);
  assert.match(script,/data-ux-action="ai-close"/);
});

test('通过 attestation 的原生 DSH Web 也无外层 Workbench chrome 地铺满右栏',async()=>{
  const [script,styles]=await Promise.all([read('public/harness-navigator.js'),read('public/harness-navigator.css')]);
  assert.match(script,/status\?\.uiMode==='embedded_experimental'/);
  assert.match(script,/status\?\.embeddedWeb\?\.verified===true/);
  assert.match(script,/sandbox="allow-scripts allow-same-origin allow-forms"/);
  assert.match(script,/referrerpolicy="no-referrer"/);
  assert.match(script,/原生 DSH Web 未通过组成校验/);
  assert.match(styles,/\.harness-embed\{flex:1;width:100%;height:100%/);
});
