import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(path){return fsp.readFile(path,'utf8');}

test('one-time Feishu initialization is explicit, confirmed, and hands off to a single analysis reload',async()=>{
  const [index,initializer,manual,registry,tool]=await Promise.all([
    read('public/index.html'),
    read('public/workbench-v3-initialize.js'),
    read('public/workbench-v3-manual-control.js'),
    read('src/mcp/registry.mjs'),
    read('src/mcp/feishu-initialize-tools.mjs')
  ]);
  assert.match(index,/workbench-v3-initialize\.js/);
  assert.match(initializer,/初始化导入并分析/);
  assert.match(initializer,/initialImportAt/);
  assert.match(initializer,/feishu_initial_import/);
  assert.match(initializer,/confirmed:true/);
  assert.match(initializer,/__WORKBENCH_ARM_INITIAL_ANALYSIS__/);
  assert.match(initializer,/location\.reload\(\)/);
  assert.match(initializer,/这是一次性操作/);
  assert.match(manual,/INIT_ANALYZE_ONCE/);
  assert.match(manual,/classificationRun=sessionStorage\.getItem\(INIT_ANALYZE_ONCE\)==='1'/);
  assert.match(manual,/sessionStorage\.removeItem\(INIT_ANALYZE_ONCE\)/);
  assert.match(manual,/__WORKBENCH_ARM_INITIAL_ANALYSIS__/);
  assert.match(registry,/createFeishuInitializeTools/);
  assert.match(tool,/name:'feishu_initial_import'/);
  assert.match(tool,/requiresConfirmation:true/);
  assert.match(tool,/initialize:true/);
});
