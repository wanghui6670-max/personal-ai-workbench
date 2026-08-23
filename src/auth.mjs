/**
 * 认证模块 — 支持 JWT 多用户认证 + 旧单密码模式兼容
 *
 * 多用户模式（STORE_BACKEND=sqlite）：
 * - JWT（HS256）签发/验证，payload 含 {uid, name, role, exp}
 * - scrypt 密码哈希
 * - login(username, password, store) 从 SQLite 查用户验证
 *
 * 旧模式（STORE_BACKEND=json）：
 * - 单密码 WORKBENCH_PASSWORD + HMAC token
 * - 完全兼容原有逻辑
 */
import crypto from 'node:crypto';
import { timingSafeEqualText } from './utils.mjs';

const COOKIE = 'workbench_session';
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 30; // 30 天
const MAX_AGE = process.env.JWT_MAX_AGE ? Math.max(60, parseInt(process.env.JWT_MAX_AGE, 10)) : DEFAULT_MAX_AGE;
const LEGACY_USER_ID = '__legacy__';

const LOGIN_LIMITER_DEFAULTS = {
  freeFailures: 4,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  staleAfterMs: 15 * 60_000,
  maxEntries: 5000
};

export function createLoginAttemptLimiter(options = {}) {
  const settings = { ...LOGIN_LIMITER_DEFAULTS, ...options };
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const attempts = new Map();

  function prune(at) {
    for (const [key, entry] of attempts) {
      if (at - entry.lastSeen >= settings.staleAfterMs) attempts.delete(key);
    }
    while (attempts.size >= settings.maxEntries) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
  }
  function check(key) {
    const entry = attempts.get(String(key));
    const at = now();
    if (!entry) return { allowed: true, retryAfterMs: 0 };
    if (at - entry.lastSeen >= settings.staleAfterMs) { attempts.delete(String(key)); return { allowed: true, retryAfterMs: 0 }; }
    const retryAfterMs = Math.max(0, entry.blockedUntil - at);
    return { allowed: retryAfterMs === 0, retryAfterMs };
  }
  function recordFailure(key) {
    const id = String(key); const at = now(); prune(at);
    const previous = attempts.get(id); const failures = (previous?.failures || 0) + 1;
    const exponent = Math.max(0, failures - settings.freeFailures - 1);
    const delay = failures > settings.freeFailures ? Math.min(settings.maxDelayMs, settings.baseDelayMs * (2 ** exponent)) : 0;
    attempts.delete(id);
    attempts.set(id, { failures, blockedUntil: at + delay, lastSeen: at });
    return { allowed: delay === 0, retryAfterMs: delay };
  }
  function recordSuccess(key) { attempts.delete(String(key)); }
  return { check, recordFailure, recordSuccess };
}

export const loginAttemptLimiter = createLoginAttemptLimiter();
export const ipLoginLimiter = createLoginAttemptLimiter({ freeFailures: 10, maxEntries: 10000 });

/**
 * 双维度登录限流检查
 * @param {string} ip - 客户端 IP
 * @param {string} [username] - 登录用户名（多用户模式）
 * @returns {{allowed: boolean, retryAfterMs: number}}
 */
function checkLoginRate(ip, username) {
  const ipResult = ipLoginLimiter.check(ip);
  if (!ipResult.allowed) return ipResult;
  if (username) {
    const userResult = loginAttemptLimiter.check(`user:${username}`);
    if (!userResult.allowed) return userResult;
  }
  return { allowed: true, retryAfterMs: 0 };
}

function recordLoginFailure(ip, username) {
  const ipResult = ipLoginLimiter.recordFailure(ip);
  if (username) {
    const userResult = loginAttemptLimiter.recordFailure(`user:${username}`);
    // 返回更长的等待时间
    return ipResult.retryAfterMs >= userResult.retryAfterMs ? ipResult : userResult;
  }
  return ipResult;
}

function recordLoginSuccess(ip, username) {
  ipLoginLimiter.recordSuccess(ip);
  if (username) loginAttemptLimiter.recordSuccess(`user:${username}`);
}

export { checkLoginRate, recordLoginFailure, recordLoginSuccess };

// ========== 模式判断 ==========
export function isMultiUserMode() {
  return process.env.STORE_BACKEND !== 'json';
}

export function authEnabled() {
  if (isMultiUserMode()) return true;
  return !!process.env.WORKBENCH_PASSWORD;
}

// ========== 密码哈希（scrypt）==========
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, encoded) {
  if (!encoded || typeof encoded !== 'string') return false;
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const hash = Buffer.from(parts[2], 'hex');
    const computed = crypto.scryptSync(password, salt, 64);
    if (hash.length !== computed.length) return false;
    return crypto.timingSafeEqual(hash, computed);
  } catch {
    return false;
  }
}

// ========== JWT ==========
function jwtSecret() {
  return process.env.SESSION_SECRET || 'local-dev-session-secret-change-me';
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac('sha256', jwtSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, sig] = parts;
  // 防御 alg:none 攻击：校验 header.alg 必须是 HS256
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
  } catch {
    return null;
  }
  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto.createHmac('sha256', jwtSecret()).update(data).digest('base64url');
  if (!timingSafeEqualText(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() >= payload.exp * 1000) return null;
    if (!payload.uid) return null;
    return payload;
  } catch {
    return null;
  }
}

// ========== Cookie 工具 ==========
function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => {
        const i = x.indexOf('=');
        return i < 0 ? [x, ''] : [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
      })
  );
}

export function createSessionCookie(userId, displayName, role, tokenVersion = 0, username = null) {
  const payload = {
    uid: userId,
    name: displayName || userId,
    username: username || displayName || userId,
    role: role || 'member',
    v: tokenVersion,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE
  };
  const token = signJwt(payload);
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
}

export function logoutCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// ========== 旧模式 HMAC token（兼容 STORE_BACKEND=json）==========
function legacySign() {
  const payload = `ok.${Date.now()}`;
  const sig = crypto.createHmac('sha256', jwtSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function legacyVerify(value) {
  if (!value) return false;
  const idx = value.lastIndexOf('.');
  if (idx < 1) return false;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  if (!timingSafeEqualText(sig, crypto.createHmac('sha256', jwtSecret()).update(payload).digest('base64url'))) return false;
  const ts = Number(payload.split('.').pop());
  return Number.isFinite(ts) && Date.now() - ts < MAX_AGE * 1000;
}

function legacyCookie() {
  return `${COOKIE}=${encodeURIComponent(legacySign())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
}

// ========== 请求级认证 ==========
/**
 * 从请求中提取当前登录用户信息
 * @returns {{uid,name,role}|null}
 */
export function getSessionUser(req, store = null) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;

  if (isMultiUserMode()) {
    const payload = verifyJwt(token);
    if (!payload) return null;
    // Token 吊销校验：如果提供了 store，检查 payload 中的 tokenVersion 与数据库是否一致
    if (store) {
      const raw = store.raw || store;
      if (raw.getTokenVersion) {
        const currentVersion = raw.getTokenVersion(payload.uid);
        if (currentVersion === null) return null; // 用户已被删除
        if (payload.v !== currentVersion) return null; // token 已被吊销
      }
    }
    return { uid: payload.uid, name: payload.name, username: payload.username || payload.name, role: payload.role };
  } else {
    if (legacyVerify(token)) return { uid: LEGACY_USER_ID, name: 'Admin', role: 'admin' };
    return null;
  }
}

export function isAuthenticated(req, store = null) {
  return !authEnabled() || !!getSessionUser(req, store);
}

/**
 * 登录
 * 多用户模式：{username, password, store} → 查 SQLite users 表
 * 旧模式：{password} → 比对 WORKBENCH_PASSWORD
 */
export async function login(params) {
  if (isMultiUserMode()) {
    const { username, password, store } = params;
    if (!username || !password) return { ok: false };
    // store 可以是 SqliteStore 实例或 adapter 的 raw
    const raw = store.raw || store;
    const user = raw.getUserByName ? raw.getUserByName(username) : null;
    if (!user) return { ok: false };
    if (!verifyPassword(password, user.passwordHash)) return { ok: false };
    return {
      ok: true,
      cookie: createSessionCookie(user.id, user.displayName, user.role, user.tokenVersion || 0, user.username),
      user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role }
    };
  } else {
    const { password } = params;
    if (!authEnabled()) return { ok: true, cookie: null };
    if (!timingSafeEqualText(password || '', process.env.WORKBENCH_PASSWORD)) return { ok: false };
    return { ok: true, cookie: legacyCookie() };
  }
}

export function captureAuthorized(req) {
  const expected = process.env.CAPTURE_TOKEN;
  if (authEnabled() && isAuthenticated(req)) return true;
  if (!expected) return false;
  const auth = String(req.headers.authorization || '');
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return timingSafeEqualText(supplied, expected);
}

export { COOKIE, LEGACY_USER_ID, MAX_AGE };
