/**
 * 一次性迁移脚本：先创建数据库 + 管理员用户，再迁移 JSON 数据
 * 
 * 用法：node scripts/run-migration.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/db.mjs';
import { SqliteStore, LEGACY_USER_ID } from '../src/store-sqlite.mjs';
import { UserManager } from '../src/user-manager.mjs';
import { hashPassword } from '../src/auth.mjs';
import { migrateJsonToSqlite } from '../src/migrate-json-to-sqlite.mjs';
import { loadWorkbenchEnv } from '../src/env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');

// 加载 .env
await loadWorkbenchEnv({ root: APP_ROOT });
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(APP_ROOT, 'data');

console.log(`数据目录: ${DATA_DIR}`);

async function main() {
  // 1. 创建数据库
  const db = createDatabase(DATA_DIR);
  console.log('SQLite 数据库已创建');

  // 2. 创建管理员用户
  const adminUsername = process.env.WORKBENCH_ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.WORKBENCH_ADMIN_PASSWORD;
  
  if (!adminPassword) {
    console.error('未设置 WORKBENCH_ADMIN_PASSWORD，无法创建管理员');
    process.exit(1);
  }

  const store = new SqliteStore(db, DATA_DIR);
  const userManager = new UserManager(store);
  
  let adminUserId;
  const existing = store.getUserByName(adminUsername);
  if (existing) {
    console.log(`管理员用户 ${adminUsername} 已存在，将迁移数据到该用户`);
    adminUserId = existing.id;
  } else {
    const admin = userManager.register({
      username: adminUsername,
      password: adminPassword,
      displayName: '管理员',
      role: 'admin'
    });
    adminUserId = admin.id;
    console.log(`已创建管理员用户: ${adminUsername} (ID: ${adminUserId})`);
  }

  // 3. 迁移 JSON 数据
  const migrated = await migrateJsonToSqlite(db, DATA_DIR, adminUserId);
  if (!migrated) {
    console.log('无 JSON 数据需要迁移');
  }

  // 4. legacy 数据不需要单独迁移（admin 已包含所有数据）
  
  // 5. 验证
  const userCount = store.countUsers();
  const todos = store._stmts.listTodos.all(adminUserId);
  const projects = store._stmts.listProjects.all(adminUserId);
  const inbox = store._stmts.listInbox.all(adminUserId);
  
  console.log('\n=== 迁移结果 ===');
  console.log(`用户数: ${userCount}`);
  console.log(`管理员的待办: ${todos.length} 条`);
  console.log(`管理员的项目: ${projects.length} 个`);
  console.log(`管理员的收件箱: ${inbox.length} 条`);
  
  db.close();
  console.log('\n迁移完成，数据库已关闭。可以启动服务了。');
}

main().catch(error => {
  console.error('迁移失败:', error);
  process.exit(1);
});
