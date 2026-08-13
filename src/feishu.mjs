import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

export class FeishuSourceError extends Error {
  constructor(message, { cause, code = 'FEISHU_SOURCE_UNAVAILABLE', statusCode = 502 } = {}) {
    super(message, { cause });
    this.name = 'FeishuSourceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function decodeXmlText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJson(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) throw new FeishuSourceError('飞书 CLI 没有返回内容。');
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  throw new FeishuSourceError('飞书 CLI 返回内容无法解析。');
}

function documentContent(payload) {
  const content = payload?.data?.document?.content;
  if (typeof content !== 'string') throw new FeishuSourceError('飞书文档读回结果缺少正文。');
  return { content, revisionId: payload.data.document.revision_id ?? null, documentId: payload.data.document.document_id ?? null };
}

function validateDocumentUrl(value) {
  const raw = String(value ?? '').trim();
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
    return url.toString();
  } catch {
    throw new FeishuSourceError('飞书文档 URL 无效。', { code: 'INVALID_FEISHU_SOURCE', statusCode: 400 });
  }
}

function validateToken(value) {
  if (value === undefined || value === null || value === '') return null;
  const token = String(value).trim();
  if (!SAFE_TOKEN.test(token)) throw new FeishuSourceError('飞书文档 token 格式无效。', { code: 'INVALID_FEISHU_SOURCE', statusCode: 400 });
  return token;
}

function cliError(error, action) {
  if (error instanceof FeishuSourceError) return error;
  const message = error?.code === 'ENOENT'
    ? '未找到 lark-cli，请在安装并登录 lark-cli 的本机运行工作台。'
    : `飞书${action}失败，请检查登录状态和文档权限。`;
  return new FeishuSourceError(message, { cause: error });
}

async function runCli(args, action, { timeoutMs = DEFAULT_TIMEOUT_MS, exec = execFileAsync } = {}) {
  try {
    const result = await exec('lark-cli', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return extractJson(result.stdout);
  } catch (error) {
    throw cliError(error, action);
  }
}

/**
 * Parse only the top-level section headed “收件箱”. Other diary sections are
 * deliberately ignored. Every returned item carries the Feishu block id so
 * the local cache can deduplicate without using the text as an identity key.
 */
export function parseFeishuInboxXml(xml, { heading = '收件箱', prefix = '[INBOX]' } = {}) {
  const source = String(xml ?? '');
  const headingPattern = new RegExp(`<h1\\b[^>]*>${escapeRegExp(heading)}<\\/h1\\s*>`, 'i');
  const headingMatch = headingPattern.exec(source);
  if (!headingMatch) return { sectionFound: false, items: [] };
  const afterHeading = source.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = /<h1\b[^>]*>[^<]*<\/h1\s*>/i.exec(afterHeading);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  const items = [];
  const blockPattern = /<(p|checkbox|li)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let match;
  while ((match = blockPattern.exec(section))) {
    const text = decodeXmlText(match[3]);
    if (!text.startsWith(prefix)) continue;
    const value = text.slice(prefix.length).trim();
    if (!value) continue;
    const idMatch = match[2].match(/\bid=["']([^"']+)["']/i);
    const blockId = idMatch?.[1] || null;
    if (!blockId) continue;
    items.push({ blockId, text: value, rawText: text, tag: match[1].toLowerCase() });
  }
  const unique = new Map();
  for (const item of items) unique.set(item.blockId, item);
  const headingId = headingMatch[0].match(/\bid=["']([^"']+)["']/i)?.[1] || null;
  return { sectionFound: true, headingBlockId: headingId, items: [...unique.values()] };
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

export function createFeishuJournalClient({ exec = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    async fetch(config) {
      const documentUrl = validateDocumentUrl(config?.documentUrl);
      const payload = await runCli([
        'docs', '+fetch', '--api-version', 'v2', '--as', 'user', '--doc', documentUrl,
        '--detail', 'with-ids', '--format', 'json'
      ], '文档读取', { exec, timeoutMs });
      const document = documentContent(payload);
      const parsed = parseFeishuInboxXml(document.content, {
        heading: config?.inboxHeading || '收件箱',
        prefix: config?.inboxPrefix || '[INBOX]'
      });
      if (!parsed.sectionFound) throw new FeishuSourceError(`文档中没有找到“${config?.inboxHeading || '收件箱'}”章节。`, { code: 'FEISHU_SOURCE_FORMAT' });
      return { ...document, ...parsed, url: documentUrl };
    },
    async appendAndFetch(config, text) {
      const documentUrl = validateDocumentUrl(config?.documentUrl);
      const prefix = config?.inboxPrefix || '[INBOX]';
      const current = await this.fetch(config);
      const anchor = current.items.at(-1)?.blockId || current.headingBlockId;
      if (!anchor) throw new FeishuSourceError('飞书文档收件箱章节缺少可写入锚点。', { code: 'FEISHU_SOURCE_FORMAT' });
      await runCli([
        'docs', '+update', '--api-version', 'v2', '--as', 'user', '--doc', documentUrl,
        '--command', 'block_insert_after', '--block-id', anchor,
        '--content', `<p>${escapeXml(`${prefix} ${text}`)}</p>`, '--format', 'json'
      ], '文档写入', { exec, timeoutMs });
      const fetched = await this.fetch(config);
      const matches = fetched.items.filter(item => item.text === text);
      const item = matches.at(-1);
      if (!item) throw new FeishuSourceError('飞书写入命令已返回，但文档读回没有找到新增收件箱事项。', { code: 'FEISHU_SOURCE_READBACK_FAILED' });
      return { ...fetched, item };
    }
  };
}

export function sourceConfigured(dataSource) {
  return Boolean(dataSource && dataSource.provider === 'feishu_doc' && String(dataSource.documentUrl || '').trim());
}

export { escapeXml };
