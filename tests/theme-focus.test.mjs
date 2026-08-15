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

test('UI vNext 使用统一日夜 token、系统字体与低对比细边线',async()=>{
  const [script,styles]=await Promise.all([read('public/theme-focus.js'),read('public/theme-focus.css')]);
  assert.match(script,/personal-ai-workbench\.theme/);
  assert.match(script,/prefers-color-scheme: dark/);
  assert.match(script,/document\.documentElement\.dataset\.theme=next/);
  assert.match(script,/data-theme-toggle/);
  assert.match(styles,/html\[data-theme="light"\]/);
  assert.match(styles,/html\[data-theme="dark"\]/);
  assert.match(styles,/--canvas:#fafbfc/);
  assert.match(styles,/--side:#f1f4f7/);
  assert.match(styles,/--dsh-bg:#f5f7fa/);
  assert.match(styles,/--line:rgba\(30,41,59,\.10\)/);
  assert.match(styles,/--canvas:#11151b/);
  assert.match(styles,/--line:rgba\(255,255,255,\.08\)/);
  assert.match(styles,/font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","PingFang SC"/);
  assert.match(styles,/\.top-left h1\{font-size:22px;font-weight:650/);
  for(const selector of ['.sidebar','.topbar','.card','.ai-panel.harness-primary','.harness-nav-card','.harness-nav-form'])assert.match(styles,new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('今日工作台使用常驻轻仪表盘，最近现场和项目进度保持 IDE 折叠区',async()=>{
  const [script,styles]=await Promise.all([read('public/theme-focus.js'),read('public/theme-focus.css')]);
  assert.match(script,/function normalizeTodayDashboard\(main,grid\)/);
  assert.match(script,/statRow\.classList\.add\('today-dashboard'\)/);
  assert.match(script,/const labels=\['今日','收件箱','项目','需处理'\]/);
  assert.match(script,/grid\.insertAdjacentElement\('beforebegin',statRow\)/);
  assert.doesNotMatch(script,/label:'工作概览'/);
  assert.match(script,/today-recent-details/);
  assert.match(script,/最近工作现场/);
  assert.match(script,/today-project-details/);
  assert.match(script,/label:'项目进度'/);
  assert.match(script,/today-decision-row/);
  assert.match(styles,/html\.today-focus \.today-dashboard\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles,/html\.today-focus \.today-dashboard \.stat \.n\{font-size:24px/);
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

test('今日任务为空时使用无虚线框轻空态，并保持幂等写入',async()=>{
  const [script,styles]=await Promise.all([read('public/theme-focus.js'),read('public/theme-focus.css')]);
  assert.match(script,/const emptyHtml='<div class="today-empty-copy"><strong>今天还没有明确安排<\/strong><span>从待办中选真正要推进的事项。<\/span><\/div><a class="today-empty-action" href="#tasks">查看待办<\/a>';/);
  assert.match(script,/if\(empty\.innerHTML!==emptyHtml\)empty\.innerHTML=emptyHtml/);
  assert.match(script,/primary\.classList\.toggle\('today-primary-empty',primaryEmpty\)/);
  assert.match(styles,/today-primary-empty>\.empty\{min-height:92px;display:flex/);
  assert.match(styles,/padding:24px 4px 14px;text-align:left;border:0;background:transparent;border-radius:0/);
  assert.match(styles,/\.today-empty-action\{flex:none;display:inline-flex/);
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
