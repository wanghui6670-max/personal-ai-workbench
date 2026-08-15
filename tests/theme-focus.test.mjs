import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

async function read(file){return fsp.readFile(file,'utf8');}

test('主题层由独立静态资源接入，并保持浏览器脚本语法有效',async()=>{
  const html=await read('public/index.html');
  assert.match(html,/theme-focus\.css/);
  assert.match(html,/theme-focus\.js/);
  assert.ok(html.indexOf('/theme-focus.css')>html.indexOf('/harness-navigator.css'));
  assert.ok(html.indexOf('/theme-focus.js')>html.indexOf('/harness-navigator.js'));
  execFileSync(process.execPath,['--check','public/theme-focus.js'],{stdio:'pipe'});
});

test('日间和夜间是全局主题，不只给 DSH 换皮',async()=>{
  const [script,styles]=await Promise.all([read('public/theme-focus.js'),read('public/theme-focus.css')]);
  assert.match(script,/personal-ai-workbench\.theme/);
  assert.match(script,/prefers-color-scheme: dark/);
  assert.match(script,/document\.documentElement\.dataset\.theme=next/);
  assert.match(script,/data-theme-toggle/);
  assert.match(styles,/html\[data-theme="light"\]/);
  assert.match(styles,/html\[data-theme="dark"\]/);
  assert.match(styles,/--canvas:#fbfcfd/);
  assert.match(styles,/--side:#edf1f5/);
  assert.match(styles,/--dsh-bg:#f4f7fa/);
  for(const selector of ['.sidebar','.topbar','.card','.ai-panel.harness-primary','.harness-nav-card','.harness-nav-form'])assert.match(styles,new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('今日工作台首屏只保留做事与拍板，统计、现场和项目进度降为默认折叠次要信息',async()=>{
  const [script,styles]=await Promise.all([read('public/theme-focus.js'),read('public/theme-focus.css')]);
  assert.match(script,/today-focus/);
  assert.match(script,/today-stats-details/);
  assert.match(script,/label:'工作概览'/);
  assert.match(script,/today-recent-details/);
  assert.match(script,/最近工作现场/);
  assert.match(script,/today-project-details/);
  assert.match(script,/label:'项目进度'/);
  assert.match(script,/decision-rule/);
  assert.match(script,/today-decision-row/);
  assert.match(script,/if\(decision\?\.parentElement===grid\)grid\.insertAdjacentElement\('afterend',decision\)/);
  assert.match(script,/if\(recent\?\.parentElement===primary\)\(decision\|\|grid\)\.insertAdjacentElement\('afterend',recent\)/);
  assert.match(script,/只显示你明确加入今天的任务/);
  assert.match(script,/只处理需要你拍板的事项/);
  assert.match(styles,/html\.today-focus \.grid\{grid-template-columns:1fr/);
  assert.match(styles,/html\.today-focus \.today-decision-row\{margin-top:14px;display:grid/);
  assert.match(styles,/html\.today-focus \.today-secondary-details\{margin-top:0;border:0;border-top:1px solid var\(--line\)/);
});

test('MutationObserver 增强层是幂等的，不会通过重复文本写入自触发微任务死循环',async()=>{
  const script=await read('public/theme-focus.js');
  assert.match(script,/function setTextIfChanged\(node,text\)\{\s*if\(node&&node\.textContent!==text\)node\.textContent=text;/);
  assert.match(script,/setTextIfChanged\(card\.querySelector\('\.card-desc'\),'只处理需要你拍板的事项。'\)/);
  assert.match(script,/setTextIfChanged\(attention,'需要处理'\)/);
  assert.match(script,/setTextIfChanged\(primary\?\.querySelector\('\.card-desc'\),'只显示你明确加入今天的任务。'\)/);
  assert.match(script,/if\(button\.innerHTML!==html\)button\.innerHTML=html/);
  assert.doesNotMatch(script,/if\(desc\)desc\.textContent='只处理需要你拍板的事项。'/);
  assert.doesNotMatch(script,/if\(primaryDesc\)primaryDesc\.textContent='只显示你明确加入今天的任务。'/);
});

test('今日任务为空时不会重复写 innerHTML，并使用紧凑主工作区',async()=>{
  const [script,styles]=await Promise.all([read('public/theme-focus.js'),read('public/theme-focus.css')]);
  assert.match(script,/const emptyHtml='<strong>今天还没有正式安排任务。<\/strong><br>从待办中选择真正要做的，再加入今日。';/);
  assert.match(script,/if\(empty\.innerHTML!==emptyHtml\)empty\.innerHTML=emptyHtml/);
  assert.match(script,/primary\.classList\.toggle\('today-primary-empty',primaryEmpty\)/);
  assert.match(styles,/html\.today-focus \.grid>section\.card\.pad\.today-primary-empty\{min-height:180px/);
  assert.doesNotMatch(script,/empty\.innerHTML='<strong>今天还没有正式安排任务。<\/strong><br>从待办中选择真正要做的，再加入今日。';/);
});

test('DSH 顶部始终规范为聊天，避免旧 Copilot 标题回流',async()=>{
  const script=await read('public/theme-focus.js');
  assert.match(script,/function normalizeHarnessChrome\(\)\{\s*setTextIfChanged\(document\.querySelector\('\.harness-nav-head>strong'\),'聊天'\);/);
  assert.match(script,/normalizeHarnessChrome\(\);/);
});

test('聚焦层不引入自动排期、自动同步或写入 DSH 权限边界',async()=>{
  const script=await read('public/theme-focus.js');
  assert.doesNotMatch(script,/\/api\/projects\/sync|\/api\/inbox\/sync|\/api\/joycrew\/actions|\/api\/mcp/);
  assert.doesNotMatch(script,/today-toggle|toggle-todo|sync-all/);
  assert.doesNotMatch(script,/HARNESS_NAVIGATOR_TOOL_ALLOWLIST|toolRefs|sandbox=/);
});
