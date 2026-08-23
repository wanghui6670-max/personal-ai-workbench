/**
 * SQLite 数据库初始化与表结构定义
 * 多用户改造：所有业务表增加 userId 字段实现数据隔离
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fsp from 'node:fs/promises';

const SCHEMA_SQL = `
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  displayName TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  tokenVersion INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- 用户配置表（per-user 飞书绑定、设置等）
CREATE TABLE IF NOT EXISTS user_configs (
  userId TEXT NOT NULL,
  configKey TEXT NOT NULL,
  configValue TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (userId, configKey)
);

-- 待办表
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  dueDate TEXT NOT NULL,
  projectId TEXT,
  businessId TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  dueAt TEXT, startAt TEXT, allDay INTEGER, timeZone TEXT,
  priority TEXT, priorityLabel TEXT, tags TEXT,
  source TEXT, externalId TEXT, externalStatus TEXT, dueDateOwner TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(userId);
CREATE INDEX IF NOT EXISTS idx_todos_user_due ON todos(userId, dueDate);
CREATE INDEX IF NOT EXISTS idx_todos_user_project ON todos(userId, projectId);

-- 项目表
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  businessId TEXT,
  folder TEXT,
  git TEXT,
  feishu TEXT,
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  sourceInboxId TEXT,
  sourceDescription TEXT,
  progress TEXT NOT NULL DEFAULT '{}',
  progressBeforeCompletion TEXT,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(userId);

-- 收件箱表
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  createdAt TEXT NOT NULL,
  feishuBlockId TEXT, feishuMode TEXT, feishuHeadingPath TEXT,
  feishuTag TEXT, feishuExplicitInbox INTEGER, feishuExplicitTodo INTEGER,
  feishuTodoKind TEXT, captureId TEXT,
  aiSuggestion TEXT,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox(userId);

-- 收件箱 ACK（幂等去重）
CREATE TABLE IF NOT EXISTS inbox_acks (
  userId TEXT NOT NULL,
  blockId TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  acknowledgedAt TEXT NOT NULL,
  PRIMARY KEY (userId, blockId)
);

-- 今日计划
CREATE TABLE IF NOT EXISTS today_plan (
  userId TEXT NOT NULL,
  date TEXT NOT NULL,
  todoId TEXT NOT NULL,
  PRIMARY KEY (userId, date, todoId)
);

-- 待确认事项
CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  projectId TEXT, inboxId TEXT, operationId TEXT, synthetic INTEGER,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_confirmations_user ON confirmations(userId);

-- 工作日志
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  projectId TEXT, todoId TEXT, inboxId TEXT
);
CREATE INDEX IF NOT EXISTS idx_activities_user_time ON activities(userId, at DESC);

-- 备忘
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  text TEXT NOT NULL,
  projectId TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(userId);

-- 早间对话会话
CREATE TABLE IF NOT EXISTS morning_sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  date TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_morning_sessions_user ON morning_sessions(userId);

-- DSH 对话会话
CREATE TABLE IF NOT EXISTS harness_sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'project',
  projectId TEXT,
  goal TEXT NOT NULL DEFAULT '',
  checkpoint TEXT NOT NULL DEFAULT '{}',
  workingMemory TEXT NOT NULL DEFAULT '{}',
  contextRefs TEXT NOT NULL DEFAULT '[]',
  decisionRefs TEXT NOT NULL DEFAULT '[]',
  executionRefs TEXT NOT NULL DEFAULT '[]',
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_harness_sessions_user ON harness_sessions(userId);

-- DSH 执行记录
CREATE TABLE IF NOT EXISTS harness_executions (
  executionId TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  sessionId TEXT,
  status TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT,
  error TEXT,
  startedAt TEXT NOT NULL,
  completedAt TEXT,
  errorCode TEXT,
  resultSummary TEXT,
  sessionRef TEXT,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_harness_exec_user ON harness_executions(userId, startedAt DESC);

-- 业务板块（per-user）
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_businesses_user ON businesses(userId);
`;

export function createDatabase(dataDir) {
  const dbPath = path.join(dataDir, 'workbench.db');
  const db = new Database(dbPath);
  // 并发安全：多用户同时写入时，SQLite 会等待最多 5 秒而不是立即抛 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  // 迁移：为已有 users 表添加 tokenVersion 列（v3.1 新增）
  try {
    const cols = db.pragma('table_info(users)');
    if (cols.length > 0 && !cols.some(c => c.name === 'tokenVersion')) {
      db.exec('ALTER TABLE users ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0');
      console.log('[migration] 已为 users 表添加 tokenVersion 列');
    }
  } catch (e) {
    // 首次创建表时无此列也无妨，SCHEMA_SQL 已包含
  }
  return db;
}

export { SCHEMA_SQL };
