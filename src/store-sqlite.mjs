/**
 * SQLite Store 实现
 * 
 * 提供与 JsonStore 兼容的接口（readState/writeState/readConfig/writeConfig/updateState/updateConfig），
 * 同时增加 per-user 数据隔离能力。
 * 
 * 兼容策略：
 * - 当不传 userId 时，使用 '__legacy__' 作为默认用户，保持与单用户模式的完全兼容
 * - 当传 userId 时，所有读写操作按用户隔离
 * - updateState/updateConfig 的 mutator 模式保持不变，内部改为 SQLite 事务
 */
import { nowIso, todayIso, newId } from './utils.mjs';
import fsp from 'node:fs/promises';
import { validateState, validateConfig, validateStateConfigReferences, validateStateInput } from './validation.mjs';
import { stripNarrativeProgress } from './project-record-policy.mjs';
import { normalizeInboxAcks } from './inbox-ack.mjs';
import { DEFAULT_CONFIG, DEFAULT_STATE, normalizeProject, normalizeActivity } from './store-defaults.mjs';

const LEGACY_USER_ID = '__legacy__';

function parseJSON(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function boolToInt(v) { return v ? 1 : 0; }
function intToBool(v) { return v === 1 || v === true; }

export class SqliteStore {
  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    this.backupDir = dataDir + '/backups';
    this._initStatements();
  }

  _initStatements() {
    const db = this.db;
    this._stmts = {
      // Users
      getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
      getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
      createUser: db.prepare(`INSERT INTO users (id, username, passwordHash, displayName, role, tokenVersion, createdAt, updatedAt) VALUES (@id, @username, @passwordHash, @displayName, @role, @tokenVersion, @createdAt, @updatedAt)`),
      listUsers: db.prepare('SELECT id, username, displayName, role, createdAt, lastSeenAt FROM users ORDER BY createdAt'),
      updateUser: db.prepare(`UPDATE users SET displayName = @displayName, role = @role, passwordHash = @passwordHash, tokenVersion = @tokenVersion, updatedAt = @updatedAt WHERE id = @id`),
      updateLastSeen: db.prepare('UPDATE users SET lastSeenAt = @lastSeenAt WHERE id = @id'),
      incTokenVersion: db.prepare('UPDATE users SET tokenVersion = tokenVersion + 1, updatedAt = @updatedAt WHERE id = @id'),
      getTokenVersion: db.prepare('SELECT tokenVersion FROM users WHERE id = ?'),
      deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
      countUsers: db.prepare('SELECT COUNT(*) as count FROM users'),

      // Config
      getConfigs: db.prepare('SELECT configKey, configValue FROM user_configs WHERE userId = ?'),
      setConfig: db.prepare(`INSERT OR REPLACE INTO user_configs (userId, configKey, configValue, updatedAt) VALUES (@userId, @configKey, @configValue, @updatedAt)`),

      // Businesses
      listBusinesses: db.prepare('SELECT id, name, folder FROM businesses WHERE userId = ? ORDER BY folder'),
      insertBusiness: db.prepare(`INSERT INTO businesses (id, userId, name, folder, createdAt) VALUES (@id, @userId, @name, @folder, @createdAt)`),
      deleteBusinesses: db.prepare('DELETE FROM businesses WHERE userId = ?'),

      // Todos
      listTodos: db.prepare('SELECT * FROM todos WHERE userId = ? ORDER BY createdAt DESC'),
      insertTodo: db.prepare(`INSERT INTO todos (id, userId, title, context, dueDate, projectId, businessId, done, createdAt, dueAt, startAt, allDay, timeZone, priority, priorityLabel, tags, source, externalId, externalStatus, dueDateOwner) VALUES (@id, @userId, @title, @context, @dueDate, @projectId, @businessId, @done, @createdAt, @dueAt, @startAt, @allDay, @timeZone, @priority, @priorityLabel, @tags, @source, @externalId, @externalStatus, @dueDateOwner)`),
      updateTodo: db.prepare(`UPDATE todos SET title = @title, context = @context, dueDate = @dueDate, projectId = @projectId, businessId = @businessId, done = @done WHERE id = @id AND userId = @userId`),
      deleteTodo: db.prepare('DELETE FROM todos WHERE userId = ?'),
      deleteTodoById: db.prepare('DELETE FROM todos WHERE id = ? AND userId = ?'),

      // Projects
      listProjects: db.prepare('SELECT * FROM projects WHERE userId = ? ORDER BY createdAt DESC'),
      insertProject: db.prepare(`INSERT INTO projects (id, userId, name, intro, businessId, folder, git, feishu, startDate, endDate, completed, archived, createdAt, sourceInboxId, sourceDescription, progress, progressBeforeCompletion) VALUES (@id, @userId, @name, @intro, @businessId, @folder, @git, @feishu, @startDate, @endDate, @completed, @archived, @createdAt, @sourceInboxId, @sourceDescription, @progress, @progressBeforeCompletion)`),
      updateProject: db.prepare(`UPDATE projects SET name = @name, intro = @intro, businessId = @businessId, folder = @folder, git = @git, feishu = @feishu, endDate = @endDate, completed = @completed, archived = @archived, progress = @progress, progressBeforeCompletion = @progressBeforeCompletion WHERE id = @id AND userId = @userId`),
      deleteProjects: db.prepare('DELETE FROM projects WHERE userId = ?'),

      // Inbox
      listInbox: db.prepare('SELECT * FROM inbox WHERE userId = ? ORDER BY createdAt DESC'),
      insertInbox: db.prepare(`INSERT INTO inbox (id, userId, text, source, createdAt, feishuBlockId, feishuMode, feishuHeadingPath, feishuTag, feishuExplicitInbox, feishuExplicitTodo, feishuTodoKind, captureId, aiSuggestion) VALUES (@id, @userId, @text, @source, @createdAt, @feishuBlockId, @feishuMode, @feishuHeadingPath, @feishuTag, @feishuExplicitInbox, @feishuExplicitTodo, @feishuTodoKind, @captureId, @aiSuggestion)`),
      deleteInbox: db.prepare('DELETE FROM inbox WHERE userId = ?'),
      deleteInboxById: db.prepare('DELETE FROM inbox WHERE id = ? AND userId = ?'),

      // Inbox ACKs
      listAcks: db.prepare('SELECT blockId, contentHash, acknowledgedAt FROM inbox_acks WHERE userId = ?'),
      insertAck: db.prepare(`INSERT OR REPLACE INTO inbox_acks (userId, blockId, contentHash, acknowledgedAt) VALUES (@userId, @blockId, @contentHash, @acknowledgedAt)`),
      deleteAcks: db.prepare('DELETE FROM inbox_acks WHERE userId = ?'),

      // Today plan
      getTodayPlan: db.prepare('SELECT todoId FROM today_plan WHERE userId = ? AND date = ?'),
      replaceTodayPlan: db.prepare('DELETE FROM today_plan WHERE userId = ? AND date = ?'),
      insertTodayPlan: db.prepare(`INSERT INTO today_plan (userId, date, todoId) VALUES (@userId, @date, @todoId)`),

      // Confirmations
      listConfirmations: db.prepare('SELECT * FROM confirmations WHERE userId = ? ORDER BY createdAt DESC'),
      insertConfirmation: db.prepare(`INSERT INTO confirmations (id, userId, type, text, createdAt, projectId, inboxId, operationId, synthetic) VALUES (@id, @userId, @type, @text, @createdAt, @projectId, @inboxId, @operationId, @synthetic)`),
      deleteConfirmations: db.prepare('DELETE FROM confirmations WHERE userId = ?'),
      deleteConfirmationById: db.prepare('DELETE FROM confirmations WHERE id = ? AND userId = ?'),

      // Activities
      listActivities: db.prepare('SELECT at, type, text, projectId, todoId, inboxId FROM activities WHERE userId = ? ORDER BY at DESC LIMIT 2000'),
      insertActivity: db.prepare(`INSERT INTO activities (id, userId, at, type, text, projectId, todoId, inboxId) VALUES (@id, @userId, @at, @type, @text, @projectId, @todoId, @inboxId)`),
      deleteActivities: db.prepare('DELETE FROM activities WHERE userId = ?'),
      pruneActivitiesBefore: db.prepare('DELETE FROM activities WHERE at < ?'),

      // Notes
      listNotes: db.prepare('SELECT id, text, projectId, createdAt FROM notes WHERE userId = ? ORDER BY createdAt DESC'),
      insertNote: db.prepare(`INSERT INTO notes (id, userId, text, projectId, createdAt) VALUES (@id, @userId, @text, @projectId, @createdAt)`),
      deleteNotes: db.prepare('DELETE FROM notes WHERE userId = ?'),

      // Morning sessions
      listMorningSessions: db.prepare('SELECT id, date, createdAt, messages FROM morning_sessions WHERE userId = ? ORDER BY createdAt DESC LIMIT 30'),
      upsertMorningSession: db.prepare(`INSERT OR REPLACE INTO morning_sessions (id, userId, date, createdAt, messages) VALUES (@id, @userId, @date, @createdAt, @messages)`),
      deleteMorningSessions: db.prepare('DELETE FROM morning_sessions WHERE userId = ?'),

      // Harness sessions
      listHarnessSessions: db.prepare('SELECT * FROM harness_sessions WHERE userId = ? ORDER BY updatedAt DESC'),
      getHarnessSession: db.prepare('SELECT * FROM harness_sessions WHERE id = ? AND userId = ?'),
      upsertHarnessSession: db.prepare(`INSERT OR REPLACE INTO harness_sessions (id, userId, type, projectId, goal, checkpoint, workingMemory, contextRefs, decisionRefs, executionRefs, updatedAt) VALUES (@id, @userId, @type, @projectId, @goal, @checkpoint, @workingMemory, @contextRefs, @decisionRefs, @executionRefs, @updatedAt)`),
      deleteHarnessSession: db.prepare('DELETE FROM harness_sessions WHERE id = ? AND userId = ?'),

      // Harness executions
      listHarnessExecutions: db.prepare('SELECT * FROM harness_executions WHERE userId = ? ORDER BY startedAt DESC LIMIT 2000'),
      getHarnessExecution: db.prepare('SELECT * FROM harness_executions WHERE executionId = ? AND userId = ?'),
      appendHarnessExecution: db.prepare(`INSERT OR REPLACE INTO harness_executions (executionId, userId, sessionId, status, input, output, error, startedAt, completedAt, errorCode, resultSummary, sessionRef) VALUES (@executionId, @userId, @sessionId, @status, @input, @output, @error, @startedAt, @completedAt, @errorCode, @resultSummary, @sessionRef)`),
    };
  }

  // ========== 用户管理 ==========
  getUser(userId) { return this._stmts.getUser.get(userId); }
  getUserByName(username) { return this._stmts.getUserByName.get(username); }
  createUser(user) { this._stmts.createUser.run({...user, tokenVersion: user.tokenVersion || 0}); return user; }
  listUsers() { return this._stmts.listUsers.all(); }
  updateUser(user) { this._stmts.updateUser.run({...user, tokenVersion: user.tokenVersion || 0}); return user; }
  updateLastSeen(userId) { this._stmts.updateLastSeen.run({id: userId, lastSeenAt: nowIso()}); }
  getTokenVersion(userId) { const row = this._stmts.getTokenVersion.get(userId); return row ? row.tokenVersion : null; }
  incrementTokenVersion(userId) { this._stmts.incTokenVersion.run({id: userId, updatedAt: nowIso()}); }
  deleteUser(userId) { 
    const tx = this.db.transaction(() => {
      this._stmts.deleteUser.run(userId);
      this._stmts.deleteBusinesses.run(userId);
      this._stmts.deleteTodo.run(userId);
      this._stmts.deleteProjects.run(userId);
      this._stmts.deleteInbox.run(userId);
      this._stmts.deleteAcks.run(userId);
      this._stmts.deleteConfirmations.run(userId);
      this._stmts.deleteNotes.run(userId);
      this._stmts.deleteMorningSessions.run(userId);
    });
    tx();
  }
  countUsers() { return this._stmts.countUsers.get().count; }

  // ========== 配置读写 ==========
  readConfig(userId = LEGACY_USER_ID) {
    const rows = this._stmts.getConfigs.all(userId);
    const config = {
      ...DEFAULT_CONFIG,
      businesses: this._readBusinesses(userId),
      settings: { recentDays: 3, dueSoonDays: 3 },
      dataSource: null,
      workspaceRoot: './workspace'
    };
    for (const row of rows) {
      if (row.configKey === 'settings') Object.assign(config.settings, parseJSON(row.configValue, {}));
      else if (row.configKey === 'dataSource') config.dataSource = parseJSON(row.configValue, null);
      else if (row.configKey === 'workspaceRoot') config.workspaceRoot = row.configValue;
    }
    return config;
  }

  _readBusinesses(userId) {
    const rows = this._stmts.listBusinesses.all(userId);
    if (rows.length > 0) return rows.map(r => ({ id: r.id, name: r.name, folder: r.folder }));
    return DEFAULT_CONFIG.businesses;
  }

  async writeConfig(userId, config) {
    const tx = this.db.transaction(() => {
      this._stmts.setConfig.run({ userId, configKey: 'workspaceRoot', configValue: config.workspaceRoot || './workspace', updatedAt: nowIso() });
      this._stmts.setConfig.run({ userId, configKey: 'settings', configValue: JSON.stringify(config.settings || {}), updatedAt: nowIso() });
      this._stmts.setConfig.run({ userId, configKey: 'dataSource', configValue: JSON.stringify(config.dataSource || null), updatedAt: nowIso() });
      // 同步 businesses
      this._stmts.deleteBusinesses.run(userId);
      for (const biz of (config.businesses || [])) {
        this._stmts.insertBusiness.run({ id: biz.id, userId, name: biz.name, folder: biz.folder, createdAt: nowIso() });
      }
    });
    tx();
    return config;
  }

  async updateConfig(userId, mutator) {
    const config = this.readConfig(userId);
    const result = await mutator(config);
    await this.writeConfig(userId, config);
    return result;
  }

  // ========== State 读写 ==========
  readState(userId = LEGACY_USER_ID) {
    const todos = this._stmts.listTodos.all(userId).map(this._rowToTodo.bind(this));
    const projects = this._stmts.listProjects.all(userId).map(this._rowToProject.bind(this));
    const inbox = this._stmts.listInbox.all(userId).map(this._rowToInboxItem.bind(this));
    const inboxAcks = this._stmts.listAcks.all(userId);
    const today = todayIso();
    const todayPlanRows = this._stmts.getTodayPlan.all(userId, today);
    const todayPlan = todayPlanRows.map(r => r.todoId);
    const confirmations = this._stmts.listConfirmations.all(userId).map(this._rowToConfirmation.bind(this));
    const activities = this._stmts.listActivities.all(userId).map(normalizeActivity);
    const notes = this._stmts.listNotes.all(userId);
    const morningSessions = this._stmts.listMorningSessions.all(userId).map(this._rowToMorningSession.bind(this));

    return {
      schemaVersion: 1,
      inbox,
      inboxAcks: normalizeInboxAcks(inboxAcks),
      todos,
      todayPlan,
      todayPlanDate: todayPlan.length > 0 ? today : null,
      projects,
      confirmations,
      notes,
      activities,
      morningSessions
    };
  }

  writeState(userId, state) {
    const tx = this.db.transaction(() => {
      this._replaceTodos(userId, state.todos || []);
      this._replaceProjects(userId, state.projects || []);
      this._replaceInbox(userId, state.inbox || []);
      this._replaceAcks(userId, state.inboxAcks || []);
      this._replaceTodayPlan(userId, state.todayPlan || [], state.todayPlanDate || todayIso());
      this._replaceConfirmations(userId, state.confirmations || []);
      this._replaceActivities(userId, state.activities || []);
      this._replaceNotes(userId, state.notes || []);
      this._replaceMorningSessions(userId, state.morningSessions || []);
    });
    tx();
    return state;
  }

  async updateState(userId, mutator) {
    const state = this.readState(userId);
    const result = await mutator(state);
    this.writeState(userId, state);
    return result;
  }

  // ========== 单实体增量操作 ==========
  addActivity(userId, activity) {
    this._stmts.insertActivity.run({
      id: newId('act'),
      userId,
      at: activity.at || nowIso(),
      type: activity.type || '',
      text: activity.text || '',
      projectId: activity.projectId || null,
      todoId: activity.todoId || null,
      inboxId: activity.inboxId || null
    });
  }

  /**
   * 清理过期活动日志（TTL 清理）
   * @param {string} beforeIso - ISO 时间戳，早于此时间的记录将被删除
   * @returns {number} 删除的行数
   */
  pruneActivities(beforeIso) {
    const info = this._stmts.pruneActivitiesBefore.run(beforeIso);
    return info.changes;
  }

  /**
   * 执行 VACUUM 回收空间
   * 注意：VACUUM 会锁定数据库，应在低峰期执行
   */
  vacuum() {
    this.db.exec('VACUUM');
  }

  deleteConfirmation(userId, id) {
    this._stmts.deleteConfirmationById.run(id, userId);
  }

  // ========== 转换函数 ==========
  _rowToTodo(row) {
    const todo = {
      id: row.id,
      title: row.title,
      context: row.context,
      dueDate: row.dueDate,
      projectId: row.projectId,
      businessId: row.businessId,
      done: intToBool(row.done),
      createdAt: row.createdAt
    };
    if (row.dueAt) todo.dueAt = row.dueAt;
    if (row.startAt) todo.startAt = row.startAt;
    if (row.allDay !== null) todo.allDay = intToBool(row.allDay);
    if (row.timeZone) todo.timeZone = row.timeZone;
    if (row.priority) todo.priority = row.priority;
    if (row.priorityLabel) todo.priorityLabel = row.priorityLabel;
    if (row.tags) todo.tags = parseJSON(row.tags, null);
    if (row.source) todo.source = row.source;
    if (row.externalId) todo.externalId = row.externalId;
    if (row.externalStatus) todo.externalStatus = row.externalStatus;
    if (row.dueDateOwner) todo.dueDateOwner = row.dueDateOwner;
    return todo;
  }

  _rowToProject(row) {
    const project = {
      id: row.id,
      name: row.name,
      intro: row.intro,
      businessId: row.businessId,
      folder: row.folder || '',
      git: row.git || '',
      feishu: row.feishu || '',
      startDate: row.startDate,
      endDate: row.endDate,
      completed: intToBool(row.completed),
      archived: intToBool(row.archived),
      createdAt: row.createdAt,
      sourceInboxId: row.sourceInboxId || undefined,
      sourceDescription: row.sourceDescription || undefined,
      progress: parseJSON(row.progress, {}),
    };
    if (row.progressBeforeCompletion) project.progressBeforeCompletion = parseJSON(row.progressBeforeCompletion, undefined);
    return normalizeProject(project);
  }

  _rowToInboxItem(row) {
    const item = {
      id: row.id,
      text: row.text,
      source: row.source,
      createdAt: row.createdAt
    };
    if (row.feishuBlockId) item.feishuBlockId = row.feishuBlockId;
    if (row.feishuMode) item.feishuMode = row.feishuMode;
    if (row.feishuHeadingPath) item.feishuHeadingPath = parseJSON(row.feishuHeadingPath, row.feishuHeadingPath);
    if (row.feishuTag) item.feishuTag = row.feishuTag;
    if (row.feishuExplicitInbox !== null) item.feishuExplicitInbox = intToBool(row.feishuExplicitInbox);
    if (row.feishuExplicitTodo !== null) item.feishuExplicitTodo = intToBool(row.feishuExplicitTodo);
    if (row.feishuTodoKind) item.feishuTodoKind = row.feishuTodoKind;
    if (row.captureId) item.captureId = row.captureId;
    if (row.aiSuggestion) item.aiSuggestion = parseJSON(row.aiSuggestion, undefined);
    return item;
  }

  _rowToConfirmation(row) {
    const conf = {
      id: row.id,
      type: row.type,
      text: row.text,
      createdAt: row.createdAt
    };
    if (row.projectId) conf.projectId = row.projectId;
    if (row.inboxId) conf.inboxId = row.inboxId;
    if (row.operationId) conf.operationId = row.operationId;
    if (row.synthetic !== null) conf.synthetic = intToBool(row.synthetic);
    return conf;
  }

  _rowToMorningSession(row) {
    return {
      id: row.id,
      date: row.date,
      createdAt: row.createdAt,
      messages: parseJSON(row.messages, [])
    };
  }

  // ========== 批量替换 ==========
  _replaceTodos(userId, todos) {
    this._stmts.deleteTodo.run(userId);
    for (const todo of todos) {
      this._stmts.insertTodo.run({
        id: todo.id,
        userId,
        title: todo.title,
        context: todo.context || '',
        dueDate: todo.dueDate,
        projectId: todo.projectId || null,
        businessId: todo.businessId || null,
        done: boolToInt(todo.done),
        createdAt: todo.createdAt,
        dueAt: todo.dueAt || null,
        startAt: todo.startAt || null,
        allDay: todo.allDay !== undefined ? boolToInt(todo.allDay) : null,
        timeZone: todo.timeZone || null,
        priority: todo.priority || null,
        priorityLabel: todo.priorityLabel || null,
        tags: todo.tags ? JSON.stringify(todo.tags) : null,
        source: todo.source || null,
        externalId: todo.externalId || null,
        externalStatus: todo.externalStatus || null,
        dueDateOwner: todo.dueDateOwner || null
      });
    }
  }

  _replaceProjects(userId, projects) {
    this._stmts.deleteProjects.run(userId);
    for (const project of projects) {
      this._stmts.insertProject.run({
        id: project.id,
        userId,
        name: project.name,
        intro: project.intro || '',
        businessId: project.businessId || null,
        folder: project.folder || '',
        git: project.git || '',
        feishu: project.feishu || '',
        startDate: project.startDate,
        endDate: project.endDate,
        completed: boolToInt(project.completed),
        archived: boolToInt(project.archived),
        createdAt: project.createdAt,
        sourceInboxId: project.sourceInboxId || null,
        sourceDescription: project.sourceDescription || null,
        progress: JSON.stringify(project.progress || {}),
        progressBeforeCompletion: project.progressBeforeCompletion ? JSON.stringify(project.progressBeforeCompletion) : null
      });
    }
  }

  _replaceInbox(userId, inbox) {
    this._stmts.deleteInbox.run(userId);
    for (const item of inbox) {
      this._stmts.insertInbox.run({
        id: item.id,
        userId,
        text: item.text,
        source: item.source || 'manual',
        createdAt: item.createdAt,
        feishuBlockId: item.feishuBlockId || null,
        feishuMode: item.feishuMode || null,
        feishuHeadingPath: item.feishuHeadingPath ? (Array.isArray(item.feishuHeadingPath) ? JSON.stringify(item.feishuHeadingPath) : item.feishuHeadingPath) : null,
        feishuTag: item.feishuTag || null,
        feishuExplicitInbox: item.feishuExplicitInbox !== undefined ? boolToInt(item.feishuExplicitInbox) : null,
        feishuExplicitTodo: item.feishuExplicitTodo !== undefined ? boolToInt(item.feishuExplicitTodo) : null,
        feishuTodoKind: item.feishuTodoKind || null,
        captureId: item.captureId || null,
        aiSuggestion: item.aiSuggestion ? JSON.stringify(item.aiSuggestion) : null
      });
    }
  }

  _replaceAcks(userId, acks) {
    this._stmts.deleteAcks.run(userId);
    for (const ack of acks) {
      this._stmts.insertAck.run({
        userId,
        blockId: ack.blockId,
        contentHash: ack.contentHash || '',
        acknowledgedAt: ack.acknowledgedAt
      });
    }
  }

  _replaceTodayPlan(userId, plan, date) {
    this._stmts.replaceTodayPlan.run(userId, date);
    for (const todoId of plan) {
      this._stmts.insertTodayPlan.run({ userId, date, todoId });
    }
  }

  _replaceConfirmations(userId, confirmations) {
    this._stmts.deleteConfirmations.run(userId);
    for (const conf of confirmations) {
      this._stmts.insertConfirmation.run({
        id: conf.id,
        userId,
        type: conf.type,
        text: conf.text,
        createdAt: conf.createdAt,
        projectId: conf.projectId || null,
        inboxId: conf.inboxId || null,
        operationId: conf.operationId || null,
        synthetic: conf.synthetic !== undefined ? boolToInt(conf.synthetic) : null
      });
    }
  }

  _replaceActivities(userId, activities) {
    // 先删除当前用户的所有活动，再插入，避免每次 writeState 导致活动表指数增长
    this._stmts.deleteActivities.run(userId);
    for (const activity of activities) {
      this._stmts.insertActivity.run({
        id: activity.id || newId('act'),
        userId,
        at: activity.at || nowIso(),
        type: activity.type || '',
        text: activity.text || '',
        projectId: activity.projectId || null,
        todoId: activity.todoId || null,
        inboxId: activity.inboxId || null
      });
    }
  }

  _replaceNotes(userId, notes) {
    this._stmts.deleteNotes.run(userId);
    for (const note of notes) {
      this._stmts.insertNote.run({
        id: note.id,
        userId,
        text: note.text,
        projectId: note.projectId || null,
        createdAt: note.createdAt
      });
    }
  }

  _replaceMorningSessions(userId, sessions) {
    this._stmts.deleteMorningSessions.run(userId);
    for (const session of sessions) {
      this._stmts.upsertMorningSession.run({
        id: session.id,
        userId,
        date: session.date,
        createdAt: session.createdAt,
        messages: JSON.stringify(session.messages || [])
      });
    }
  }

  // ========== Harness 会话 ==========
  listHarnessSessions(userId) {
    return this._stmts.listHarnessSessions.all(userId).map(row => ({
      id: row.id,
      userId: row.userId,
      type: row.type,
      projectId: row.projectId,
      goal: row.goal,
      checkpoint: parseJSON(row.checkpoint, {}),
      workingMemory: parseJSON(row.workingMemory, {}),
      contextRefs: parseJSON(row.contextRefs, []),
      decisionRefs: parseJSON(row.decisionRefs, []),
      executionRefs: parseJSON(row.executionRefs, []),
      updatedAt: row.updatedAt
    }));
  }

  getHarnessSession(userId, id) {
    const row = this._stmts.getHarnessSession.get(id, userId);
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      type: row.type,
      projectId: row.projectId,
      goal: row.goal,
      checkpoint: parseJSON(row.checkpoint, {}),
      workingMemory: parseJSON(row.workingMemory, {}),
      contextRefs: parseJSON(row.contextRefs, []),
      decisionRefs: parseJSON(row.decisionRefs, []),
      executionRefs: parseJSON(row.executionRefs, []),
      updatedAt: row.updatedAt
    };
  }

  saveHarnessSession(session) {
    this._stmts.upsertHarnessSession.run({
      id: session.id,
      userId: session.userId,
      type: session.type || 'project',
      projectId: session.projectId || null,
      goal: session.goal || '',
      checkpoint: JSON.stringify(session.checkpoint || {}),
      workingMemory: JSON.stringify(session.workingMemory || {}),
      contextRefs: JSON.stringify(session.contextRefs || []),
      decisionRefs: JSON.stringify(session.decisionRefs || []),
      executionRefs: JSON.stringify(session.executionRefs || []),
      updatedAt: session.updatedAt || nowIso()
    });
    return session;
  }

  deleteHarnessSession(userId, id) {
    this._stmts.deleteHarnessSession.run(id, userId);
  }

  // ========== Harness 执行记录 ==========
  listHarnessExecutions(userId, options = {}) {
    let items = this._stmts.listHarnessExecutions.all(userId);
    if (options.sessionRef) items = items.filter(item => item.sessionRef === options.sessionRef);
    if (options.limit > 0) items = items.slice(0, options.limit);
    return items.map(row => ({
      executionId: row.executionId,
      userId: row.userId,
      sessionId: row.sessionId,
      status: row.status,
      input: parseJSON(row.input, {}),
      output: parseJSON(row.output, null),
      error: row.error || null,
      startedAt: row.startedAt,
      completedAt: row.completedAt || null,
      errorCode: row.errorCode || null,
      resultSummary: row.resultSummary || null,
      sessionRef: row.sessionRef || null
    }));
  }

  getHarnessExecution(userId, executionId) {
    const row = this._stmts.getHarnessExecution.get(executionId, userId);
    if (!row) return null;
    return {
      executionId: row.executionId,
      userId: row.userId,
      sessionId: row.sessionId,
      status: row.status,
      input: parseJSON(row.input, {}),
      output: parseJSON(row.output, null),
      error: row.error || null,
      startedAt: row.startedAt,
      completedAt: row.completedAt || null,
      errorCode: row.errorCode || null,
      resultSummary: row.resultSummary || null,
      sessionRef: row.sessionRef || null
    };
  }

  appendHarnessExecution(record) {
    this._stmts.appendHarnessExecution.run({
      executionId: record.executionId,
      userId: record.userId,
      sessionId: record.sessionId || null,
      status: record.status || 'running',
      input: JSON.stringify(record.input || {}),
      output: record.output ? (typeof record.output === 'string' ? record.output : JSON.stringify(record.output)) : null,
      error: record.error || null,
      startedAt: record.startedAt || nowIso(),
      completedAt: record.completedAt || null,
      errorCode: record.errorCode || null,
      resultSummary: record.resultSummary || null,
      sessionRef: record.sessionRef || null
    });
    return record;
  }

  // ========== 备份 ==========
  backupNow(userId = LEGACY_USER_ID) {
    const state = this.readState(userId);
    const config = this.readConfig(userId);
    const backupPayload = {
      backupVersion: 2,
      backedUpAt: nowIso(),
      state,
      config
    };
    const backupPath = `${this.backupDir}/user-${userId}-${todayIso()}.json`;
    fsp.mkdir(this.backupDir, { recursive: true }).catch(err => {
      console.error('[backupNow] mkdir failed:', err);
    });
    fsp.writeFile(backupPath, JSON.stringify(backupPayload, null, 2)).catch(err => {
      console.error('[backupNow] writeFile failed:', err);
    });
    return backupPath;
  }

  // ========== 项目记录凭据（保留 JSON 文件方式，因为涉及飞书幂等）==========
  // 这些方法保持与 JsonStore 兼容的空实现——实际仍由 receipt-backup.mjs 的文件系统函数处理
  // 在 server.mjs 中会保持 JsonStore 实例用于凭据管理

  // ========== 兼容接口 ==========
  // 以下方法提供与 JsonStore 完全兼容的 async 接口
  // 使得上层代码在过渡期可以无感切换

  async ensure(userId = LEGACY_USER_ID) {
    // SQLite 在构造时已建表，无需额外初始化
    // 如果用户不存在且是 legacy 模式，创建 legacy 用户
    if (!this.getUser(userId) && userId === LEGACY_USER_ID) {
      // legacy 用户不需要密码，只作为数据归属
    }
  }
}

export { LEGACY_USER_ID };
