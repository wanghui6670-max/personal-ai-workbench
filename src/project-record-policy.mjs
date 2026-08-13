import { nowIso } from './utils.mjs';

/**
 * Project progress has two deliberately separate shapes:
 *
 * 1. machine progress: tiny operational state persisted in state.json;
 * 2. narrative progress: human-readable analysis written only to the bound
 *    Feishu project document.
 *
 * This prevents PROJECT.md/state/activity logs from becoming competing copies
 * of the project analysis report.
 */
export function machineProgress(progress = {}, record = null) {
  const legacyBlocker=typeof progress.blocker==='string'?progress.blocker.trim():'';
  const hasBlocker=typeof progress.hasBlocker==='boolean'
    ?progress.hasBlocker
    :Boolean(legacyBlocker&&legacyBlocker!=='暂无明确卡点。');
  const next = {
    percent: Number.isInteger(progress.percent) ? progress.percent : 0,
    status: typeof progress.status === 'string' && progress.status ? progress.status : '未启动',
    hasBlocker,
    lastActivity: Object.hasOwn(progress,'lastActivity') ? progress.lastActivity : null,
    syncedAt: Object.hasOwn(progress,'syncedAt') ? progress.syncedAt : null,
    confidence: typeof progress.confidence === 'number' && Number.isFinite(progress.confidence) ? progress.confidence : 0
  };
  if (record?.revisionId !== undefined && record?.revisionId !== null) next.feishuRevisionId = String(record.revisionId);
  if (record?.item?.blockId) next.feishuRecordBlockId = String(record.item.blockId);
  if (record?.recordedAt) next.feishuRecordedAt = String(record.recordedAt);
  return next;
}

export function narrativeFromProgress(project, progress = {}, { kind = 'analysis', recordedAt = nowIso() } = {}) {
  const lines = [
    `时间：${recordedAt}`,
    `项目：${project?.name || '未命名项目'}`,
    `记录类型：${kind === 'summary' ? '阶段总结' : '项目分析'}`,
    `状态：${progress.status || '未启动'}`,
    `进度：${Number.isFinite(progress.percent) ? Math.round(progress.percent) : 0}%`,
    `分析：${progress.summary || '暂无分析说明。'}`,
    `卡点：${progress.blocker || '暂无明确卡点。'}`,
    `恢复摘要：${progress.resume || '暂无恢复摘要。'}`
  ];
  if (progress.lastActivity) lines.push(`最后工作痕迹：${progress.lastActivity}`);
  return lines.join(' ｜ ');
}

export function narrativeRecordPointer(progress = {}) {
  return {
    revisionId: progress.feishuRevisionId ?? null,
    blockId: progress.feishuRecordBlockId ?? null,
    recordedAt: progress.feishuRecordedAt ?? null
  };
}

export function stripNarrativeProgress(progress = {}) {
  return machineProgress(progress, {
    revisionId: progress.feishuRevisionId,
    item: progress.feishuRecordBlockId ? { blockId: progress.feishuRecordBlockId } : null,
    recordedAt: progress.feishuRecordedAt
  });
}
