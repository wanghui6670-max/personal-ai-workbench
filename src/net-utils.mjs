/**
 * 网络工具函数 — 统一的 hostname 归一化与回环地址判断。
 *
 * 此前 isLoopbackHostname / normalizeHostname 在 7 个文件中各有独立实现，
 * 行为存在差异（部分不含 IPv4-mapped IPv6、部分不做 isIP 校验）。
 * 本模块以 http.mjs 的实现为权威版本统一收敛。
 */
import { isIP } from 'node:net';

/**
 * 归一化 hostname：去首尾空格、转小写、去方括号、去末尾点、去 IPv6 zone-id。
 * @param {string} value
 * @returns {string}
 */
export function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .replace(/%.*$/, '');
}

/**
 * 判断 hostname 是否为回环地址。
 *
 * 支持：
 * - 'localhost'
 * - '::1'（IPv6 loopback）
 * - 127.x.x.x（IPv4 loopback）
 * - ::ffff:127.x.x.x（IPv4-mapped IPv6 loopback）
 * @param {string} value
 * @returns {boolean}
 */
export function isLoopbackHostname(value) {
  const hostname = normalizeHostname(value);
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (isIP(hostname) === 4 && hostname.startsWith('127.')) return true;
  if (isIP(hostname) === 6 && hostname.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * 判断 hostname 是否为私有地址（回环 + 私有网段 + 链路本地 + 本地域名）。
 * @param {string} value
 * @returns {boolean}
 */
export function isPrivateHostname(value) {
  const hostname = normalizeHostname(value);
  if (isLoopbackHostname(hostname)) return true;
  if (isIP(hostname) === 4) {
    const parts = hostname.split('.').map(Number);
    return parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254);
  }
  if (isIP(hostname) === 6) return /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(hostname);
  return !hostname.includes('.') || hostname.endsWith('.local') || hostname.endsWith('.internal');
}
