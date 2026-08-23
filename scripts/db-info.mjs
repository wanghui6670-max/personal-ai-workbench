#!/usr/bin/env node
/**
 * db-info.mjs — 数据库状态诊断工具
 *
 * 用法：
 *   node scripts/db-info.mjs              # 默认数据目录
 *   DATA_DIR=/path/to/data node scripts/db-info.mjs
 *
 * 输出：
 *   - Schema 版本信息
 *   - 各表行数统计
 *   - 用户列表与活跃度
 *   - 数据库文件大小
 *   - WAL/SHM 状态
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorkbenchEnv } from '../src/env.mjs';
import { CURRENT_SCHEMA_VERSION, migrations } from '../src/db.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await loadWorkbenchEnv({ root });

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(root, 'data');

const dbPath = path.join(dataDir, 'workbench.db');

console.log('═══════════════════════════════════════════════');
console.log('  数据库状态诊断');
console.log('═══════════════════════════════════════════════\n');

// 1. 文件信息
console.log('── 文件信息 ──');
console.log(`  路径: ${dbPath}`);
if (fs.existsSync(dbPath)) {
  const stat = fs.statSync(dbPath);
  console.log(`  大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  修改时间: ${stat.mtime.toISOString()}`);
} else {
  console.log('  ⚠ 数据库文件不存在');
  process.exit(1);
}
for (const ext of ['-wal', '-shm']) {
  const p = dbPath + ext;
  if (fs.existsSync(p)) {
    const s = fs.statSync(p);
    console.log(`  ${ext} 文件: ${(s.size / 1024).toFixed(1)} KB`);
  }
}

// 2. 打开数据库
const db = new Database(dbPath, { readonly: true });
db.pragma('busy_timeout = 5000');

// 3. Schema 版本
console.log('\n── Schema 版本 ──');
let schemaVersion = 0;
try {
  const row = db.prepare('SELECT MAX(version) as v FROM _schema_version').get();
  schemaVersion = row?.v ?? 0;
} catch {
  console.log('  _schema_version 表不存在（旧版本数据库，未启用版本管理）');
}
console.log(`  当前版本: ${schemaVersion}`);
console.log(`  最新版本: ${CURRENT_SCHEMA_VERSION}`);
if (schemaVersion < CURRENT_SCHEMA_VERSION) {
  console.log(`  ⚠ 有 ${CURRENT_SCHEMA_VERSION - schemaVersion} 个迁移未应用`);
} else {
  console.log('  ✓ 已是最新版本');
}

// 迁移历史
if (schemaVersion > 0) {
  console.log('\n  迁移历史:');
  const records = db.prepare('SELECT * FROM _schema_version ORDER BY version').all();
  for (const r of records) {
    console.log(`    v${r.version}: ${r.description} (${r.appliedAt})`);
  }
}

// 4. 表行数统计
console.log('\n── 表统计 ──');
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(t => t.name);

let maxNameLen = 0;
for (const t of tables) maxNameLen = Math.max(maxNameLen, t.length);

for (const t of tables) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
    const padName = t.padEnd(maxNameLen + 2);
    const padCount = count.toString().padStart(6);
    console.log(`  ${padName} ${padCount} 行`);
  } catch (e) {
    console.log(`  ${t.padEnd(maxNameLen + 2)}  [错误: ${e.message}]`);
  }
}

// 5. 用户列表与活跃度
console.log('\n── 用户列表 ──');
try {
  const users = db.prepare('SELECT id, username, displayName, role, createdAt, lastSeenAt FROM users ORDER BY createdAt').all();
  if (users.length === 0) {
    console.log('  （无用户）');
  } else {
    for (const u of users) {
      const active = u.lastSeenAt ? u.lastSeenAt.slice(0, 16).replace('T', ' ') : '未活跃';
      console.log(`  ${u.username.padEnd(15)} ${u.role.padEnd(6)} ${u.displayName || '-'}  创建: ${u.createdAt.slice(0, 10)}  最近活跃: ${active}`);
    }
  }
} catch (e) {
  console.log(`  [错误: ${e.message}]`);
}

// 6. 索引列表
console.log('\n── 索引 ──');
const indexes = db.prepare(
  "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name"
).all();
for (const idx of indexes) {
  console.log(`  ${idx.tbl_name.padEnd(20)} → ${idx.name}`);
}

// 7. 可用迁移列表
console.log('\n── 可用迁移 ──');
for (const m of migrations) {
  const applied = m.version <= schemaVersion ? '✓' : ' ';
  console.log(`  [${applied}] v${m.version}: ${m.description}`);
}

db.close();
console.log('\n═══════════════════════════════════════════════');
console.log('  诊断完成');
console.log('═══════════════════════════════════════════════');
