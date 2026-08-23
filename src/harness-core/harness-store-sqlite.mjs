/**
 * SQLite-backed adapters for Harness session and execution stores.
 *
 * Wraps SqliteStore's existing harness_sessions / harness_executions tables
 * to match the interface expected by createSessionManager / createExecutionService.
 *
 * All data is automatically scoped by userId — different users' sessions
 * and execution records are fully isolated.
 */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Create a SQLite-backed session store matching the interface of createSessionStore.
 * Interface: { load, save, create, get, list, update }
 */
export function createSqliteSessionStore({ sqliteStore, userId, now = () => new Date() } = {}) {
  if (!sqliteStore) throw new Error('createSqliteSessionStore requires sqliteStore');
  const uid = userId || '__legacy__';

  async function load() {
    return sqliteStore.listHarnessSessions(uid).map(clone);
  }

  async function save() {
    return sqliteStore.listHarnessSessions(uid).map(clone);
  }

  async function create(record) {
    if (!record?.id) throw new Error('session id 必填');
    const saved = sqliteStore.saveHarnessSession({ ...record, userId: uid });
    return clone(saved);
  }

  function get(id) {
    const record = sqliteStore.getHarnessSession(uid, id);
    return record ? clone(record) : null;
  }

  function list() {
    return sqliteStore.listHarnessSessions(uid).map(clone);
  }

  async function update(id, patch = {}) {
    const current = get(id);
    if (!current) throw Object.assign(new Error(`未知 session：${id}`), { code: 'HARNESS_SESSION_NOT_FOUND' });
    const record = { ...current, ...patch, id: current.id, updatedAt: now().toISOString() };
    sqliteStore.saveHarnessSession({ ...record, userId: uid });
    return clone(record);
  }

  return Object.freeze({ load, save, create, get, list, update });
}

/**
 * Create a SQLite-backed execution store matching the interface of createExecutionStore.
 * Interface: { load, append, list, get }
 */
export function createSqliteExecutionStore({ sqliteStore, userId, now = () => new Date() } = {}) {
  if (!sqliteStore) throw new Error('createSqliteExecutionStore requires sqliteStore');
  const uid = userId || '__legacy__';

  async function load() {
    // Mark any 'running' executions as 'interrupted' (same logic as JSON store)
    const items = sqliteStore.listHarnessExecutions(uid);
    for (const item of items) {
      if (item.status === 'running') {
        sqliteStore.appendHarnessExecution({
          ...item,
          userId: uid,
          status: 'interrupted',
          completedAt: now().toISOString(),
          errorCode: 'HARNESS_EXECUTION_INTERRUPTED',
          resultSummary: 'interrupted during previous process'
        });
      }
    }
    return sqliteStore.listHarnessExecutions(uid).map(clone);
  }

  async function append(record) {
    if (!record?.executionId) throw new Error('executionId 必填');
    sqliteStore.appendHarnessExecution({ ...record, userId: uid });
    return clone(record);
  }

  async function list({ sessionRef, limit } = {}) {
    let items = sqliteStore.listHarnessExecutions(uid);
    if (sessionRef) items = items.filter(item => item.sessionRef === sessionRef);
    if (limit === 0) return [];
    if (Number.isInteger(limit) && limit > 0) items = items.slice(0, limit);
    return items.map(clone);
  }

  function get(executionId) {
    const record = sqliteStore.getHarnessExecution(uid, executionId);
    return record ? clone(record) : null;
  }

  return Object.freeze({ load, append, list, get });
}
