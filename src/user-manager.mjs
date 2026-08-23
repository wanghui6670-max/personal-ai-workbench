/**
 * 用户管理模块
 * 
 * 提供用户注册、查询、修改、删除功能。
 * 依赖 SqliteStore 的用户管理方法。
 */
import { nowIso, newId } from './utils.mjs';
import { hashPassword, verifyPassword } from './auth.mjs';

export class UserManager {
  constructor(store) {
    // store 可以是 SqliteStore 实例或 adapter（通过 .raw 获取 SqliteStore）
    this.store = store.raw || store;
  }

  /**
   * 注册新用户
   * @param {object} params - { username, password, displayName, role }
   * @returns {object} - { id, username, displayName, role, createdAt }
   */
  register({ username, password, displayName, role = 'member' }) {
    username = String(username || '').trim();
    if (!username) throw Object.assign(new Error('用户名不能为空。'), { statusCode: 400 });
    if (username.length < 2) throw Object.assign(new Error('用户名至少 2 个字符。'), { statusCode: 400 });
    if (username.length > 32) throw Object.assign(new Error('用户名最多 32 个字符。'), { statusCode: 400 });
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5.-]+$/.test(username)) throw Object.assign(new Error('用户名只能包含字母、数字、下划线、中文、点号和连字符。'), { statusCode: 400 });
    if (!password || password.length < 8) throw Object.assign(new Error('密码至少 8 个字符。'), { statusCode: 400 });
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) throw Object.assign(new Error('密码必须包含字母和数字。'), { statusCode: 400 });
    if (role && !['admin', 'member'].includes(role)) throw Object.assign(new Error('角色只能是 admin 或 member。'), { statusCode: 400 });

    // 检查重名
    const existing = this.store.getUserByName(username);
    if (existing) throw Object.assign(new Error('用户名已存在。'), { statusCode: 409 });

    const id = newId('user');
    const now = nowIso();
    const user = {
      id,
      username,
      passwordHash: hashPassword(password),
      displayName: displayName || username,
      role: role || 'member',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now
    };
    this.store.createUser(user);
    return { id, username, displayName: user.displayName, role: user.role, createdAt: now };
  }

  /**
   * 获取用户信息（不含密码）
   */
  get(userId) {
    const user = this.store.getUser(userId);
    if (!user) return null;
    return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, createdAt: user.createdAt };
  }

  /**
   * 列出所有用户（不含密码）
   */
  list() {
    return this.store.listUsers().map(u => ({
      id: u.id, username: u.username, displayName: u.displayName, role: u.role, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt || null
    }));
  }

  /**
   * 修改用户信息
   * @param {string} userId - 用户 ID
   * @param {object} params - { displayName?, role?, password? }
   */
  update(userId, { displayName, role, password }) {
    const user = this.store.getUser(userId);
    if (!user) throw Object.assign(new Error('用户不存在。'), { statusCode: 404 });

    if (role && !['admin', 'member'].includes(role)) throw Object.assign(new Error('角色只能是 admin 或 member。'), { statusCode: 400 });
    if (password !== undefined && password.length < 8) throw Object.assign(new Error('密码至少 8 个字符。'), { statusCode: 400 });
    if (password !== undefined && (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))) throw Object.assign(new Error('密码必须包含字母和数字。'), { statusCode: 400 });

    const updated = {
      id: userId,
      displayName: displayName !== undefined ? displayName : user.displayName,
      role: role !== undefined ? role : user.role,
      passwordHash: password ? hashPassword(password) : user.passwordHash,
      tokenVersion: user.tokenVersion || 0,
      updatedAt: nowIso()
    };
    // 如果修改了密码，递增 tokenVersion 使旧 token 失效
    if (password) {
      updated.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    this.store.updateUser(updated);
    return { id: userId, username: user.username, displayName: updated.displayName, role: updated.role, createdAt: user.createdAt };
  }

  /**
   * 删除用户（同时清理其所有数据）
   */
  delete(userId) {
    const user = this.store.getUser(userId);
    if (!user) throw Object.assign(new Error('用户不存在。'), { statusCode: 404 });
    if (user.role === 'admin') {
      const adminCount = this.store.listUsers().filter(u => u.role === 'admin').length;
      if (adminCount <= 1) throw Object.assign(new Error('不能删除最后一个管理员。'), { statusCode: 409 });
    }
    this.store.deleteUser(userId);
    return { ok: true };
  }

  /**
   * 修改密码
   */
  changePassword(userId, oldPassword, newPassword) {
    const user = this.store.getUser(userId);
    if (!user) throw Object.assign(new Error('用户不存在。'), { statusCode: 404 });
    if (!verifyPassword(oldPassword, user.passwordHash)) throw Object.assign(new Error('旧密码不正确。'), { statusCode: 403 });
    if (!newPassword || newPassword.length < 8) throw Object.assign(new Error('新密码至少 8 个字符。'), { statusCode: 400 });
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) throw Object.assign(new Error('新密码必须包含字母和数字。'), { statusCode: 400 });
    this.store.updateUser({
      id: userId,
      displayName: user.displayName,
      role: user.role,
      passwordHash: hashPassword(newPassword),
      tokenVersion: (user.tokenVersion || 0) + 1,
      updatedAt: nowIso()
    });
    return { ok: true };
  }

  /**
   * 初始化首个管理员（如果数据库中无用户）
   */
  ensureInitialAdmin({ username, password, displayName }) {
    if (this.store.countUsers() > 0) return null;
    return this.register({ username, password, displayName, role: 'admin' });
  }
}

export function createUserManager(store) {
  return new UserManager(store);
}
