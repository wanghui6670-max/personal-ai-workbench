/**
 * 共享原子写入工具 — 将 JSON 数据安全写入文件（tmp + rename 模式）。
 *
 * 此前 atomicWrite 在 store.mjs / session-store.mjs / execution-store.mjs /
 * getnote-insight.mjs 中各有独立实现，逻辑几乎一致。
 * 本模块统一收敛，安全修复只需改一处。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * 原子写入 JSON 文件：创建临时文件 → rename → chmod。
 *
 * @param {string} file — 目标文件路径
 * @param {*} data — 要序列化的 JSON 数据
 * @param {object} [options]
 * @param {number} [options.mode=0o600] — 文件权限
 * @param {boolean} [options.ensureDir=true] — 是否自动创建父目录
 * @returns {Promise<void>}
 */
export async function atomicWriteJson(file, data, { mode = PRIVATE_FILE_MODE, ensureDir = true } = {}) {
  if (ensureDir) {
    const directory = path.dirname(file);
    await fsp.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await fsp.chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    created = true;
    await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, file);
    created = false;
  } finally {
    if (created) await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * 原子写入原始字符串/Buffer。
 *
 * @param {string} file — 目标文件路径
 * @param {string|Buffer} content — 要写入的内容
 * @param {object} [options]
 * @param {number} [options.mode=0o600] — 文件权限
 * @param {boolean} [options.ensureDir=true] — 是否自动创建父目录
 * @returns {Promise<void>}
 */
export async function atomicWriteRaw(file, content, { mode = PRIVATE_FILE_MODE, ensureDir = true } = {}) {
  if (ensureDir) {
    const directory = path.dirname(file);
    await fsp.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await fsp.chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await fsp.writeFile(tmp, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    created = true;
    await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, file);
    created = false;
  } finally {
    if (created) await fsp.unlink(tmp).catch(() => {});
  }
}
