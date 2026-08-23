/**
 * 共享存储默认值 — DEFAULT_CONFIG / DEFAULT_STATE / normalizeProject / normalizeActivity。
 *
 * 此前 store.mjs 和 store-sqlite.mjs 各有完全相同的复制粘贴，
 * 修改默认配置需同步改两处。本模块统一收敛。
 */
import { stripNarrativeProgress } from './project-record-policy.mjs';

export const DEFAULT_CONFIG = {
  workspaceRoot: './workspace',
  port: 4173,
  businesses: [
    { id: 'biz_ai', name: '动觉 AI', folder: '01_动觉AI' },
    { id: 'biz_store', name: '实体门店', folder: '02_实体门店' },
    { id: 'biz_client', name: '客户项目', folder: '03_客户项目' },
    { id: 'biz_personal', name: '个人内容', folder: '04_个人内容' },
  ],
  settings: { recentDays: 3, dueSoonDays: 3 },
  dataSource: null,
};

export const DEFAULT_STATE = {
  schemaVersion: 1,
  inbox: [], inboxAcks: [], todos: [], todayPlan: [], todayPlanDate: null, projects: [],
  confirmations: [], notes: [], activities: [], morningSessions: [],
};

/**
 * 归一化项目对象 — 剥离叙述性进度字段。
 */
export function normalizeProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return project;
  const next = { ...project };
  if (project.progress) next.progress = stripNarrativeProgress(project.progress);
  if (project.progressBeforeCompletion) next.progressBeforeCompletion = stripNarrativeProgress(project.progressBeforeCompletion);
  return next;
}

/**
 * 归一化活动日志 — 替换 project_synced 的文本。
 */
export function normalizeActivity(activity) {
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return activity;
  if (activity.type !== 'project_synced') return activity;
  return { ...activity, text: '项目进度已同步；分析与总结正文保存在飞书项目文档。' };
}
