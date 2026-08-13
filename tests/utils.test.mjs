import test from 'node:test';import assert from 'node:assert/strict';import {parseDateLike,sanitizeFolderName,safeResolve} from '../src/utils.mjs';
test('parseDateLike parses explicit Chinese date',()=>{assert.equal(parseDateLike('8月18日',new Date('2026-08-12T00:00:00')),'2026-08-18');});
test('folder names are sanitized',()=>{assert.equal(sanitizeFolderName('客户/项目:测试'),'客户_项目_测试');});
test('safeResolve blocks traversal',()=>{assert.throws(()=>safeResolve('/tmp/a','../b'));});
