import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('Feishu todo initialization stays explicit and remains available as reinitialize after the first import',async()=>{
  const [index,initializer,manual,registry,tool]=await Promise.all([
    read('public/index.html'),
    read('public/workbench-v3-initialize.js'),
    read('public/workbench-v3-manual-control.js'),
    read('src/mcp/registry.mjs'),
    read('src/mcp/feishu-initialize-tools.mjs')
  ]);
  assert.match(index,/workbench-v3-initialize\.js/);
  assert.match(initializer,/初始化待办同步/);
  assert.match(initializer,/重新初始化待办/);
  assert.match(initializer,/Boolean\(source\.initialImportAt\)/);
  assert.doesNotMatch(initializer,/source\.initialImportAt\)\{existing\?\.remove\(\);return;/);
  assert.match(initializer,/只读取飞书原生未完成待办\/复选框/);
  assert.match(initializer,/普通段落、复盘、分析、项目进展和日常记录全部忽略/);
  assert.match(initializer,/feishu_initial_import/);
  assert.match(initializer,/confirmed:true/);
  assert.match(initializer,/location\.reload\(\)/);
  assert.match(initializer,/飞书原文不会被删除或改写/);
  assert.match(initializer,/旧版“整篇日记解析”本地项/);
  assert.doesNotMatch(initializer,/提取 0-5 个真正可执行的待办/);
  assert.doesNotMatch(manual,/INIT_ANALYZE_ONCE|classificationRun/);
  assert.match(manual,/__WORKBENCH_ARM_INITIAL_ANALYSIS__=\(\)=>\{\}/);
  assert.match(registry,/createFeishuInitializeTools/);
  assert.match(tool,/name:'feishu_initial_import'/);
  assert.match(tool,/requiresConfirmation:true/);
  assert.match(tool,/initialize:true/);
});
