import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('DSH 右栏 v2 设计约束有文档化',async()=>{
  const doc=await fsp.readFile('docs/DSH_RIGHT_PANEL_V2.md','utf8');
  for(const phrase of ['DSH 永久拥有右侧','默认桌面宽度 500px','无卡片内容流','不伪造未接入的附件能力'])assert.match(doc,new RegExp(phrase));
});
