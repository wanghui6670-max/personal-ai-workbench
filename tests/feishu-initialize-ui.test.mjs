import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('Feishu initialization stays explicit and remains available as reinitialize after the first import',async()=>{
  const [index,initializer,manual,registry,tool]=await Promise.all([
    read('public/index.html'),
    read('public/workbench-v3-initialize.js'),
    read('public/workbench-v3-manual-control.js'),
    read('src/mcp/registry.mjs'),
    read('src/mcp/feishu-initialize-tools.mjs')
  ]);
  assert.match(index,/workbench-v3-initialize\.js/);
  assert.match(initializer,/初始化导入并提取待办/);
  assert.match(initializer,/重新初始化/);
  assert.match(initializer,/Boolean\(source\.initialImportAt\)/);
  assert.doesNotMatch(initializer,/source\.initialImportAt\)\{existing\?\.remove\(\);return;/);
  assert.match(initializer,/提取 0-5 个真正可执行的待办/);
  assert.match(initializer,/feishu_initial_import/);
  assert.match(initializer,/confirmed:true/);
  assert.match(initializer,/__WORKBENCH_ARM_INITIAL_ANALYSIS__/);
  assert.match(initializer,/location\.reload\(\)/);
  assert.match(initializer,/飞书原文不会被删除或改写/);
  assert.match(manual,/INIT_ANALYZE_ONCE/);
  assert.match(manual,/classificationRun=sessionStorage\.getItem\(INIT_ANALYZE_ONCE\)==='1'/);
  assert.match(manual,/sessionStorage\.removeItem\(INIT_ANALYZE_ONCE\)/);
  assert.match(manual,/__WORKBENCH_ARM_INITIAL_ANALYSIS__/);
  assert.match(registry,/createFeishuInitializeTools/);
  assert.match(tool,/name:'feishu_initial_import'/);
  assert.match(tool,/requiresConfirmation:true/);
  assert.match(tool,/initialize:true/);
});
