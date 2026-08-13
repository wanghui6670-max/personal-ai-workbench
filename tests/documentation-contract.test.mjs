import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

async function read(file){return fsp.readFile(file,'utf8');}

test('iPhone documentation requires a stable captureId across retries',async()=>{
  const text=await read('docs/IPHONE_SHORTCUT.md');
  assert.match(text,/JSON 字段 `captureId`/);
  assert.match(text,/所有网络重试必须复用同一个 `captureId`/);
  assert.match(text,/不要把“生成 UUID”放进重试循环/);
  assert.match(text,/同一 `captureId` 与不同正文.*`409`/s);
  assert.doesNotMatch(text,/192\.168\.31\.100/);
});

test('public documentation contains no repository-specific Feishu URL',async()=>{
  const files=['README.md','docs/PRODUCT_SPEC.md','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/IPHONE_SHORTCUT.md'];
  for(const file of files){
    const text=await read(file);
    assert.doesNotMatch(text,/xcnn2pk8gpzl\.feishu\.cn/);
    assert.doesNotMatch(text,/By6ow2cm0iXXQkkx2XRc7Ym5nOb/);
  }
});

test('authoritative docs bind captureId and backup v2 recovery fields',async()=>{
  const [readme,product,architecture,api,deployment]=await Promise.all([
    read('README.md'),
    read('docs/PRODUCT_SPEC.md'),
    read('docs/ARCHITECTURE.md'),
    read('docs/API.md'),
    read('docs/DEPLOYMENT.md')
  ]);
  for(const text of [readme,product,architecture,api])assert.match(text,/captureId/);
  for(const text of [readme,product,architecture,api,deployment]){
    assert.match(text,/backup v2/i);
    assert.match(text,/captureReceipts/);
    assert.match(text,/projectRecordReceipts/);
  }
  assert.match(api,/`GET \/api\/export`[\s\S]*不是完整恢复包/);
  assert.match(deployment,/旧备份若没有 `captureReceipts` 或 `projectRecordReceipts` 字段/);
  assert.match(product,/旧备份没有凭据字段时，保留当前凭据目录/);
  assert.match(architecture,/恢复任一阶段失败[\s\S]*回滚/);
});
