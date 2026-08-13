import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const PROJECT_RECORD_HEADING = '项目分析与总结';
const PROJECT_ANALYSIS_PREFIX = '[WORKBENCH_ANALYSIS]';
const PROJECT_SUMMARY_PREFIX = '[WORKBENCH_SUMMARY]';

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

async function fetchDocument(documentUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, exec = execFileAsync } = {}) {
  const url = validateDocumentUrl(documentUrl);
  const payload = await runCli([
    'docs', '+fetch', '--api-version', 'v2', '--as', 'user', '--doc', url,
    '--detail', 'with-ids', '--format', 'json'
  ], '文档读取', { exec, timeoutMs });
  return { ...documentContent(payload), url };
}

async function updateDocument(documentUrl, { anchorBlockId, content }, { timeoutMs = DEFAULT_TIMEOUT_MS, exec = execFileAsync } = {}) {
  const url = validateDocumentUrl(documentUrl);
  validateToken(anchorBlockId);
  await runCli([
    'docs', '+update', '--api-version', 'v2', '--as', 'user', '--doc', url,
    '--command', 'block_insert_after', '--block-id', anchorBlockId,
    '--content', content, '--format', 'json'
  ], '文档写入', { exec, timeoutMs });
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

/**
 * Project narrative records live only in the bound Feishu project document.
 * The workbench recognizes records inside one fixed top-level section and two
 * fixed prefixes; it never treats arbitrary document prose as machine state.
 */
export function parseFeishuProjectRecordsXml(xml, { heading = PROJECT_RECORD_HEADING } = {}) {
  const source = String(xml ?? '');
  const headingPattern = new RegExp(`<h1\\b[^>]*>${escapeRegExp(heading)}<\\/h1\\s*>`, 'i');
  const headingMatch = headingPattern.exec(source);
  if (!headingMatch) return { sectionFound: false, headingBlockId: null, items: [] };
  const afterHeading = source.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = /<h1\b[^>]*>[^<]*<\/h1\s*>/i.exec(afterHeading);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  const blockPattern = /<(p|checkbox|li)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  const items = [];
  let match;
  while ((match = blockPattern.exec(section))) {
    const rawText = decodeXmlText(match[3]);
    let kind = null;
    let prefix = null;
    if (rawText.startsWith(PROJECT_ANALYSIS_PREFIX)) { kind = 'analysis'; prefix = PROJECT_ANALYSIS_PREFIX; }
    else if (rawText.startsWith(PROJECT_SUMMARY_PREFIX)) { kind = 'summary'; prefix = PROJECT_SUMMARY_PREFIX; }
    else continue;
    const value = rawText.slice(prefix.length).trim();
    if (!value) continue;
    const blockId = match[2].match(/\bid=["']([^"']+)["']/i)?.[1] || null;
    if (!blockId) continue;
    items.push({ blockId, kind, text: value, rawText, tag: match[1].toLowerCase() });
  }
  const unique = new Map();
  for (const item of items) unique.set(item.blockId, item);
  const headingBlockId = headingMatch[0].match(/\bid=["']([^"']+)["']/i)?.[1] || null;
  return { sectionFound: true, headingBlockId, items: [...unique.values()] };
}

function lastDocumentBlockId(xml) {
  const source = String(xml ?? '');
  const pattern = /<(?:title|h1|h2|h3|p|checkbox|li)\b([^>]*)>/gi;
  let match;
  let last = null;
  while ((match = pattern.exec(source))) {
    const id = match[1].match(/\bid=["']([^"']+)["']/i)?.[1] || null;
    if (id) last = id;
  }
  return last;
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function normalizedRecordText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function createFeishuJournalClient({ exec = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    async fetch(config) {
      const document = await fetchDocument(config?.documentUrl, { exec, timeoutMs });
      const parsed = parseFeishuInboxXml(document.content, {
        heading: config?.inboxHeading || '收件箱',
        prefix: config?.inboxPrefix || '[INBOX]'
      });
      if (!parsed.sectionFound) throw new FeishuSourceError(`文档中没有找到“${config?.inboxHeading || '收件箱'}”章节。`, { code: 'FEISHU_SOURCE_FORMAT' });
      return { ...document, ...parsed };
    },
    async appendAndFetch(config, text) {
      const documentUrl = validateDocumentUrl(config?.documentUrl);
      const prefix = config?.inboxPrefix || '[INBOX]';
      const current = await this.fetch(config);
      const beforeIds = new Set(current.items.map(item => item.blockId));
      const anchor = current.items.at(-1)?.blockId || current.headingBlockId;
      if (!anchor) throw new FeishuSourceError('飞书文档收件箱章节缺少可写入锚点。', { code: 'FEISHU_SOURCE_FORMAT' });
      await updateDocument(documentUrl, {
        anchorBlockId: anchor,
        content: `<p>${escapeXml(`${prefix} ${text}`)}</p>`
      }, { exec, timeoutMs });
      const fetched = await this.fetch(config);
      const added = fetched.items.filter(item => !beforeIds.has(item.blockId) && item.text === text);
      if (added.length !== 1) throw new FeishuSourceError('飞书写入命令已返回，但文档读回无法唯一确认新增收件箱事项。', { code: 'FEISHU_SOURCE_READBACK_FAILED' });
      return { ...fetched, item: added[0] };
    }
  };
}

export function createFeishuProjectRecordClient({ exec = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function fetchRecords(documentUrl, { heading = PROJECT_RECORD_HEADING } = {}) {
    const document = await fetchDocument(documentUrl, { exec, timeoutMs });
    const parsed = parseFeishuProjectRecordsXml(document.content, { heading });
    return { ...document, ...parsed, heading };
  }

  async function ensureSection(documentUrl, heading) {
    let current = await fetchRecords(documentUrl, { heading });
    if (current.sectionFound) return current;
    const anchor = lastDocumentBlockId(current.content);
    if (!anchor) throw new FeishuSourceError('飞书项目文档缺少可创建记录章节的锚点。', { code: 'FEISHU_PROJECT_RECORD_FORMAT' });
    await updateDocument(documentUrl, {
      anchorBlockId: anchor,
      content: `<h1>${escapeXml(heading)}</h1>`
    }, { exec, timeoutMs });
    current = await fetchRecords(documentUrl, { heading });
    if (!current.sectionFound || !current.headingBlockId) throw new FeishuSourceError('飞书项目记录章节创建后读回失败。', { code: 'FEISHU_PROJECT_RECORD_READBACK_FAILED' });
    return current;
  }

  async function append(documentUrl, { kind, text, heading = PROJECT_RECORD_HEADING } = {}) {
    if (!['analysis', 'summary'].includes(kind)) throw new FeishuSourceError('飞书项目记录类型无效。', { code: 'INVALID_FEISHU_PROJECT_RECORD', statusCode: 400 });
    const value = normalizedRecordText(text);
    if (!value) throw new FeishuSourceError('飞书项目记录不能为空。', { code: 'INVALID_FEISHU_PROJECT_RECORD', statusCode: 400 });
    const prefix = kind === 'analysis' ? PROJECT_ANALYSIS_PREFIX : PROJECT_SUMMARY_PREFIX;
    const current = await ensureSection(documentUrl, heading);
    const beforeIds = new Set(current.items.map(item => item.blockId));
    const anchor = current.items.at(-1)?.blockId || current.headingBlockId;
    if (!anchor) throw new FeishuSourceError('飞书项目记录章节缺少可写入锚点。', { code: 'FEISHU_PROJECT_RECORD_FORMAT' });
    await updateDocument(documentUrl, {
      anchorBlockId: anchor,
      content: `<p>${escapeXml(`${prefix} ${value}`)}</p>`
    }, { exec, timeoutMs });
    const fetched = await fetchRecords(documentUrl, { heading });
    const added = fetched.items.filter(item => !beforeIds.has(item.blockId) && item.kind === kind && item.text === value);
    if (added.length !== 1) throw new FeishuSourceError('飞书项目记录写入后读回无法唯一确认新增记录。', { code: 'FEISHU_PROJECT_RECORD_READBACK_FAILED' });
    return { ...fetched, item: added[0] };
  }

  return {
    fetch: fetchRecords,
    appendAnalysis(documentUrl, text, options = {}) { return append(documentUrl, { ...options, kind: 'analysis', text }); },
    appendSummary(documentUrl, text, options = {}) { return append(documentUrl, { ...options, kind: 'summary', text }); }
  };
}

export function sourceConfigured(dataSource) {
  return Boolean(dataSource && dataSource.provider === 'feishu_doc' && String(dataSource.documentUrl || '').trim());
}

export function projectRecordConfigured(project) {
  return Boolean(project && String(project.feishu || '').trim());
}

export {
  escapeXml,
  PROJECT_RECORD_HEADING,
  PROJECT_ANALYSIS_PREFIX,
  PROJECT_SUMMARY_PREFIX
};
