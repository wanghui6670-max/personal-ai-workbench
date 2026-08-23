/**
 * Store 适配层
 * 
 * 通过环境变量 STORE_BACKEND 切换存储后端：
 * - 'sqlite'（默认）：使用 SqliteStore
 * - 'json'：使用 JsonStore（回滚用）
 * 
 * 提供统一的 store 接口，自动注入 userId：
 * - 当 userId 不传时，使用 LEGACY_USER_ID（兼容单用户模式）
 * - 当 userId 传入时，按用户隔离
 * 
 * 兼容策略：JsonStore 的所有方法都是 async 的，SqliteStore 的同名方法也包装为 async。
 * 上层代码通过 adapter 调用，无感知底层切换。
 */
import { JsonStore } from './store.mjs';
import { SqliteStore, LEGACY_USER_ID } from './store-sqlite.mjs';

/**
 * 创建一个绑定到特定 userId 的 store 代理。
 * 所有方法调用自动注入 userId，使上层业务函数无需改签名。
 */
function createScopedStore(adapter, userId) {
  return {
    // 数据读写 — 自动注入 userId
    async readState() { return adapter.readState(userId); },
    async writeState(state) { return adapter.writeState(userId, state); },
    async readConfig() { return adapter.readConfig(userId); },
    async writeConfig(config) { return adapter.writeConfig(userId, config); },
    async updateState(mutator) { return adapter.updateState(userId, mutator); },
    async updateConfig(mutator) { return adapter.updateConfig(userId, mutator); },
    async backupNow() { return adapter.backupNow(userId); },

    // 凭据管理 — 始终走 JsonStore（全局共享）
    async writeProjectRecordReceipt(receipt) { return adapter.writeProjectRecordReceipt(receipt); },
    async readProjectRecordReceipt(operationId) { return adapter.readProjectRecordReceipt(operationId); },
    async deleteProjectRecordReceipt(operationId) { return adapter.deleteProjectRecordReceipt(operationId); },
    async listCaptureReceipts() { return adapter.listCaptureReceipts(); },
    async listProjectRecordReceipts() { return adapter.listProjectRecordReceipts(); },

    // 透传属性 — health.mjs 等需要访问 dataDir / stateFile / configFile / backupDir
    get dataDir() { return adapter.dataDir; },
    get stateFile() { return adapter.stateFile; },
    get configFile() { return adapter.configFile; },
    get backupDir() { return adapter.backupDir; },

    // 原始后端 — 用户管理需要访问
    get raw() { return adapter.raw; },
    get backend() { return adapter.backend; },

    // userId 标记
    userId,
  };
}

export function createStoreAdapter({ db, dataDir, jsonStore }) {
  const backend = process.env.STORE_BACKEND || 'sqlite';
  
  if (backend === 'json') {
    // 回滚模式：完全使用 JsonStore
    const adapter = {
      backend: 'json',
      raw: jsonStore,
      dataDir: jsonStore.dataDir,
      stateFile: jsonStore.stateFile,
      configFile: jsonStore.configFile,
      backupDir: jsonStore.backupDir,
      // JsonStore 没有用户概念，所有调用忽略 userId
      async readState(userId = LEGACY_USER_ID) { return jsonStore.readState(); },
      async writeState(userId, state) { return jsonStore.writeState(state); },
      async readConfig(userId = LEGACY_USER_ID) { return jsonStore.readConfig(); },
      async writeConfig(userId, config) { return jsonStore.writeConfig(config); },
      async updateState(userId, mutator) { return jsonStore.updateState(mutator); },
      async updateConfig(userId, mutator) { return jsonStore.updateConfig(mutator); },
      async backupNow(userId = LEGACY_USER_ID) { return jsonStore.backupNow(); },
      // 凭据管理（始终用 JsonStore）
      async writeProjectRecordReceipt(receipt) { return jsonStore.writeProjectRecordReceipt(receipt); },
      async readProjectRecordReceipt(operationId) { return jsonStore.readProjectRecordReceipt(operationId); },
      async deleteProjectRecordReceipt(operationId) { return jsonStore.deleteProjectRecordReceipt(operationId); },
      async listCaptureReceipts() { return jsonStore.listCaptureReceipts(); },
      async listProjectRecordReceipts() { return jsonStore.listProjectRecordReceipts(); },
    };
    adapter.scope = (userId = LEGACY_USER_ID) => createScopedStore(adapter, userId);
    return adapter;
  }

  // SQLite 模式
  const sqliteStore = new SqliteStore(db, dataDir);
  const adapter = {
    backend: 'sqlite',
    raw: sqliteStore,
    dataDir,
    stateFile: null,       // SQLite 模式没有 state.json
    configFile: null,       // SQLite 模式没有 config.json
    backupDir: sqliteStore.backupDir,
    
    async readState(userId = LEGACY_USER_ID) { return sqliteStore.readState(userId); },
    async writeState(userId, state) { return sqliteStore.writeState(userId, state); },
    async readConfig(userId = LEGACY_USER_ID) { return sqliteStore.readConfig(userId); },
    async writeConfig(userId, config) { return sqliteStore.writeConfig(userId, config); },
    async updateState(userId, mutator) { return sqliteStore.updateState(userId, mutator); },
    async updateConfig(userId, mutator) { return sqliteStore.updateConfig(userId, mutator); },
    async backupNow(userId = LEGACY_USER_ID) { return sqliteStore.backupNow(userId); },
    
    // 凭据管理（保持 JsonStore 文件系统方式，因为涉及飞书幂等凭据）
    async writeProjectRecordReceipt(receipt) { return jsonStore.writeProjectRecordReceipt(receipt); },
    async readProjectRecordReceipt(operationId) { return jsonStore.readProjectRecordReceipt(operationId); },
    async deleteProjectRecordReceipt(operationId) { return jsonStore.deleteProjectRecordReceipt(operationId); },
    async listCaptureReceipts() { return jsonStore.listCaptureReceipts(); },
    async listProjectRecordReceipts() { return jsonStore.listProjectRecordReceipts(); },
  };
  adapter.scope = (userId = LEGACY_USER_ID) => createScopedStore(adapter, userId);
  return adapter;
}

export { LEGACY_USER_ID };
