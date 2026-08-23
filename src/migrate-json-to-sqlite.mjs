/**
 * JSON → SQLite 数据迁移脚本
 * 
 * 将现有单用户 JSON 数据（state.json + config.json）迁移到 SQLite，
 * 归属到管理员用户。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from './utils.mjs';

export async function migrateJsonToSqlite(db, jsonDir, adminUserId) {
  const statePath = path.join(jsonDir, 'state.json');
  const configPath = path.join(jsonDir, 'config.json');

  let state, config;
  try {
    state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') { console.log('无 state.json，跳过迁移'); return false; }
    throw error;
  }
  try {
    config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') { config = {}; }
    else throw error;
  }

  console.log(`开始迁移 JSON → SQLite（归入用户 ${adminUserId}）...`);

  const tx = db.transaction(() => {
    const now = nowIso();

    // 迁移配置
    db.prepare('INSERT OR REPLACE INTO user_configs (userId, configKey, configValue, updatedAt) VALUES (?, ?, ?, ?)')
      .run(adminUserId, 'workspaceRoot', config.workspaceRoot || './workspace', now);
    db.prepare('INSERT OR REPLACE INTO user_configs (userId, configKey, configValue, updatedAt) VALUES (?, ?, ?, ?)')
      .run(adminUserId, 'settings', JSON.stringify(config.settings || {}), now);
    db.prepare('INSERT OR REPLACE INTO user_configs (userId, configKey, configValue, updatedAt) VALUES (?, ?, ?, ?)')
      .run(adminUserId, 'dataSource', JSON.stringify(config.dataSource || null), now);

    // 迁移业务板块
    for (const biz of (config.businesses || [])) {
      db.prepare('INSERT OR REPLACE INTO businesses (id, userId, name, folder, createdAt) VALUES (?, ?, ?, ?, ?)')
        .run(biz.id, adminUserId, biz.name, biz.folder, now);
    }

    // 迁移待办
    for (const todo of (state.todos || [])) {
      db.prepare(`INSERT OR REPLACE INTO todos (id, userId, title, context, dueDate, projectId, businessId, done, createdAt, dueAt, startAt, allDay, timeZone, priority, priorityLabel, tags, source, externalId, externalStatus, dueDateOwner) VALUES (@id, @userId, @title, @context, @dueDate, @projectId, @businessId, @done, @createdAt, @dueAt, @startAt, @allDay, @timeZone, @priority, @priorityLabel, @tags, @source, @externalId, @externalStatus, @dueDateOwner)`)
        .run({
          id: todo.id,
          userId: adminUserId,
          title: todo.title,
          context: todo.context || '',
          dueDate: todo.dueDate,
          projectId: todo.projectId || null,
          businessId: todo.businessId || null,
          done: todo.done ? 1 : 0,
          createdAt: todo.createdAt,
          dueAt: todo.dueAt || null,
          startAt: todo.startAt || null,
          allDay: todo.allDay !== undefined ? (todo.allDay ? 1 : 0) : null,
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

    // 迁移项目
    for (const project of (state.projects || [])) {
      db.prepare(`INSERT OR REPLACE INTO projects (id, userId, name, intro, businessId, folder, git, feishu, startDate, endDate, completed, archived, createdAt, sourceInboxId, sourceDescription, progress, progressBeforeCompletion) VALUES (@id, @userId, @name, @intro, @businessId, @folder, @git, @feishu, @startDate, @endDate, @completed, @archived, @createdAt, @sourceInboxId, @sourceDescription, @progress, @progressBeforeCompletion)`)
        .run({
          id: project.id,
          userId: adminUserId,
          name: project.name,
          intro: project.intro || '',
          businessId: project.businessId || null,
          folder: project.folder || '',
          git: project.git || '',
          feishu: project.feishu || '',
          startDate: project.startDate,
          endDate: project.endDate,
          completed: project.completed ? 1 : 0,
          archived: project.archived ? 1 : 0,
          createdAt: project.createdAt,
          sourceInboxId: project.sourceInboxId || null,
          sourceDescription: project.sourceDescription || null,
          progress: JSON.stringify(project.progress || {}),
          progressBeforeCompletion: project.progressBeforeCompletion ? JSON.stringify(project.progressBeforeCompletion) : null
        });
    }

    // 迁移收件箱
    for (const item of (state.inbox || [])) {
      db.prepare(`INSERT OR REPLACE INTO inbox (id, userId, text, source, createdAt, feishuBlockId, feishuMode, feishuHeadingPath, feishuTag, feishuExplicitInbox, feishuExplicitTodo, feishuTodoKind, captureId, aiSuggestion) VALUES (@id, @userId, @text, @source, @createdAt, @feishuBlockId, @feishuMode, @feishuHeadingPath, @feishuTag, @feishuExplicitInbox, @feishuExplicitTodo, @feishuTodoKind, @captureId, @aiSuggestion)`)
        .run({
          id: item.id,
          userId: adminUserId,
          text: item.text,
          source: item.source || 'manual',
          createdAt: item.createdAt,
          feishuBlockId: item.feishuBlockId || null,
          feishuMode: item.feishuMode || null,
          feishuHeadingPath: item.feishuHeadingPath ? JSON.stringify(item.feishuHeadingPath) : null,
          feishuTag: item.feishuTag || null,
          feishuExplicitInbox: item.feishuExplicitInbox !== undefined ? (item.feishuExplicitInbox ? 1 : 0) : null,
          feishuExplicitTodo: item.feishuExplicitTodo !== undefined ? (item.feishuExplicitTodo ? 1 : 0) : null,
          feishuTodoKind: item.feishuTodoKind || null,
          captureId: item.captureId || null,
          aiSuggestion: item.aiSuggestion ? JSON.stringify(item.aiSuggestion) : null
        });
    }

    // 迁移收件箱 ACK
    for (const ack of (state.inboxAcks || [])) {
      db.prepare('INSERT OR REPLACE INTO inbox_acks (userId, blockId, contentHash, acknowledgedAt) VALUES (?, ?, ?, ?)')
        .run(adminUserId, ack.blockId, ack.contentHash || '', ack.acknowledgedAt);
    }

    // 迁移今日计划
    if (state.todayPlan && state.todayPlanDate) {
      for (const todoId of state.todayPlan) {
        db.prepare('INSERT OR REPLACE INTO today_plan (userId, date, todoId) VALUES (?, ?, ?)')
          .run(adminUserId, state.todayPlanDate, todoId);
      }
    }

    // 迁移待确认事项
    for (const conf of (state.confirmations || [])) {
      db.prepare(`INSERT OR REPLACE INTO confirmations (id, userId, type, text, createdAt, projectId, inboxId, operationId, synthetic) VALUES (@id, @userId, @type, @text, @createdAt, @projectId, @inboxId, @operationId, @synthetic)`)
        .run({
          id: conf.id,
          userId: adminUserId,
          type: conf.type,
          text: conf.text,
          createdAt: conf.createdAt,
          projectId: conf.projectId || null,
          inboxId: conf.inboxId || null,
          operationId: conf.operationId || null,
          synthetic: conf.synthetic !== undefined ? (conf.synthetic ? 1 : 0) : null
        });
    }

    // 迁移工作日志
    for (const activity of (state.activities || [])) {
      db.prepare(`INSERT INTO activities (id, userId, at, type, text, projectId, todoId, inboxId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`, adminUserId, activity.at || now, activity.type || '', activity.text || '', activity.projectId || null, activity.todoId || null, activity.inboxId || null);
    }

    // 迁移备忘
    for (const note of (state.notes || [])) {
      db.prepare(`INSERT OR REPLACE INTO notes (id, userId, text, projectId, createdAt) VALUES (?, ?, ?, ?, ?)`)
        .run(note.id, adminUserId, note.text, note.projectId || null, note.createdAt);
    }

    // 迁移早间对话会话
    for (const session of (state.morningSessions || [])) {
      db.prepare(`INSERT OR REPLACE INTO morning_sessions (id, userId, date, createdAt, messages) VALUES (?, ?, ?, ?, ?)`)
        .run(session.id, adminUserId, session.date, session.createdAt, JSON.stringify(session.messages || []));
    }

    // 迁移 DSH 会话
    // 从 harness/sessions.json 读取
    // 这里不做，因为 harness 会话在 server.mjs 启动时处理
  });

  tx();
  console.log('迁移完成');
  return true;
}
