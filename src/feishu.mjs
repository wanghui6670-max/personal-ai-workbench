import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PROJECT_RECORD_HEADING,
  PROJECT_ANALYSIS_PREFIX,
  PROJECT_SUMMARY_PREFIX,
  normalizeFeishuProjectDocumentUrl,
  normalizeProjectRecordText,
  normalizeProjectRecordOperationId,
  projectRecordOperationId,
  projectRecordMarker
} from './project-record-contract.mjs';
import {larkCliEnv} from './external-cli-env.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const WORKBENCH_INBOX_HEADING = 'Workbench 收件箱';

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
  try {
    return normalizeFeishuProjectDocumentUrl(value);
  } catch (error) {
    throw new FeishuSourceError(error.message, { cause:error, code:error.code || 'INVALID_FEISHU_SOURCE', statusCode:error.statusCode || 400 });
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
    const result = await exec('lark-cli', args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env:larkCliEnv(process.env)
    });
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

export function parseFeishuInboxXml(xml, { heading = '收件箱', prefix = '[INBOX]' } = {}) {
  const source = String(xml ?? '');
  const headingPattern = new RegExp(`<h1\\b[^>]*>${escapeRegExp(heading)}<\\/h1\\s*>`, 'i');
  const headingMatch = headingPattern.exec(source);
  if (!headingMatch) return { sectionFound: false, headingBlockId: null, items: [], mode: 'inbox_section' };
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
    items.push({ blockId, text: value, rawText: text, tag: match[1].toLowerCase(), explicitInbox:true, headingPath:[heading] });
  }
  const unique = new Map();
  for (const item of items) unique.set(item.blockId, item);
  const headingId = headingMatch[0].match(/\bid=["']([^"']+)["']/i)?.[1] || null;
  return { sectionFound: true, headingBlockId: headingId, items: [...unique.values()], mode:'inbox_section' };
}

export function parseFeishuDiaryXml(xml, { prefix = '[INBOX]' } = {}) {
  const source = String(xml ?? '');
  const headings = { h1:null, h2:null, h3:null };
  const items = [];
  const pattern = /<(h1|h2|h3|p|checkbox|li)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let match;
  let order = 0;
  while ((match = pattern.exec(source))) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const rawText = decodeXmlText(match[3]);
    const blockId = attrs.match(/\bid=["']([^"']+)["']/i)?.[1] || null;
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      if (rawText) headings[tag] = rawText;
      if (tag === 'h1') { headings.h2 = null; headings.h3 = null; }
      if (tag === 'h2') headings.h3 = null;
      continue;
    }
    if (!blockId || !rawText) continue;
    let text = rawText;
    let explicitInbox = false;
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      explicitInbox = true;
    }
    if (!text) continue;
    const checked = tag === 'checkbox' && /\bchecked(?:=["']?(?:true|1|checked)["']?)?/i.test(attrs);
    items.push({
      blockId,
      text,
      rawText,
      tag,
      checked,
      explicitInbox,
      headingPath:[headings.h1,headings.h2,headings.h3].filter(Boolean),
      order:order++
    });
  }
  const unique = new Map();
  for (const item of items) unique.set(item.blockId, item);
  return { sectionFound:false, headingBlockId:null, items:[...unique.values()], mode:'mixed_diary' };
}

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
    let value = rawText.slice(prefix.length).trim();
    let operationId = null;
    const operationMatch = value.match(/^\[WORKBENCH_OP:([A-Za-z0-9][A-Za-z0-9_-]{0,127})\]\s*/);
    if (operationMatch) {
      operationId = operationMatch[1];
      value = value.slice(operationMatch[0].length).trim();
    }
    if (!value) continue;
    const blockId = match[2].match(/\bid=["']([^"']+)["']/i)?.[1] || null;
    if (!blockId) continue;
    items.push({ blockId, kind, operationId, text: value, rawText, tag: match[1].toLowerCase() });
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

export function createFeishuJournalClient({ exec = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function fetchSource(config) {
    const document = await fetchDocument(config?.documentUrl, { exec, timeoutMs });
    const section = parseFeishuInboxXml(document.content, {
      heading: config?.inboxHeading || '收件箱',
      prefix: config?.inboxPrefix || '[INBOX]'
    });
    if (section.sectionFound) return { ...document, ...section, mode:'inbox_section' };
    const diary = parseFeishuDiaryXml(document.content, { prefix:config?.inboxPrefix || '[INBOX]' });
    return { ...document, ...diary, mode:'mixed_diary' };
  }

  async function ensureWriteSection(config) {
    const documentUrl = validateDocumentUrl(config?.documentUrl);
    const prefix = config?.inboxPrefix || '[INBOX]';
    let document = await fetchDocument(documentUrl, { exec, timeoutMs });
    let section = parseFeishuInboxXml(document.content, {
      heading:config?.inboxHeading || '收件箱', prefix
    });
    if (section.sectionFound) return { document, section };
    section = parseFeishuInboxXml(document.content, { heading:WORKBENCH_INBOX_HEADING, prefix });
    if (section.sectionFound) return { document, section };
    const anchor = lastDocumentBlockId(document.content);
    if (!anchor) throw new FeishuSourceError('飞书日记缺少可创建 Workbench 收件箱的锚点。', { code:'FEISHU_SOURCE_FORMAT' });
    await updateDocument(documentUrl, {
      anchorBlockId:anchor,
      content:`<h1>${escapeXml(WORKBENCH_INBOX_HEADING)}</h1>`
    }, { exec, timeoutMs });
    document = await fetchDocument(documentUrl, { exec, timeoutMs });
    section = parseFeishuInboxXml(document.content, { heading:WORKBENCH_INBOX_HEADING, prefix });
    if (!section.sectionFound || !section.headingBlockId) {
      throw new FeishuSourceError('Workbench 收件箱自动创建后读回失败。', { code:'FEISHU_SOURCE_READBACK_FAILED' });
    }
    return { document, section };
  }

  return {
    fetch:fetchSource,
    async appendAndFetch(config, text) {
      const documentUrl = validateDocumentUrl(config?.documentUrl);
      const prefix = config?.inboxPrefix || '[INBOX]';
      const before = await fetchSource(config);
      const beforeIds = new Set(before.items.map(item => item.blockId));
      const { section } = await ensureWriteSection(config);
      const anchor = section.items.at(-1)?.blockId || section.headingBlockId;
      if (!anchor) throw new FeishuSourceError('飞书日记 Workbench 收件箱缺少可写入锚点。', { code: 'FEISHU_SOURCE_FORMAT' });
      await updateDocument(documentUrl, {
        anchorBlockId: anchor,
        content: `<p>${escapeXml(`${prefix} ${text}`)}</p>`
      }, { exec, timeoutMs });
      const fetched = await fetchSource(config);
      const added = fetched.items.filter(item => !beforeIds.has(item.blockId) && item.text === text);
      if (added.length !== 1) throw new FeishuSourceError('飞书写入命令已返回，但文档读回无法唯一确认新增事项。', { code: 'FEISHU_SOURCE_READBACK_FAILED' });
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

  async function append(documentUrl, { kind, text, operationId, heading = PROJECT_RECORD_HEADING } = {}) {
    if (!['analysis', 'summary'].includes(kind)) throw new FeishuSourceError('飞书项目记录类型无效。', { code: 'INVALID_FEISHU_PROJECT_RECORD', statusCode: 400 });
    let value;
    try { value = normalizeProjectRecordText(text); }
    catch (error) { throw new FeishuSourceError(error.message, { cause:error, code:error.code, statusCode:error.statusCode }); }
    const normalizedUrl = validateDocumentUrl(documentUrl);
    const op = normalizeProjectRecordOperationId(operationId || projectRecordOperationId(kind,{documentUrl:normalizedUrl,text:value}));
    const prefix = kind === 'analysis' ? PROJECT_ANALYSIS_PREFIX : PROJECT_SUMMARY_PREFIX;
    const current = await ensureSection(normalizedUrl, heading);
    const existing = current.items.filter(item => item.kind === kind && item.operationId === op);
    if (existing.length > 1) throw new FeishuSourceError('飞书项目文档中存在重复 operationId，需要人工核对。', { code: 'FEISHU_PROJECT_RECORD_DUPLICATE_OPERATION', statusCode: 409 });
    if (existing.length === 1) return { ...current, item: existing[0], replayed: true, operationId: op };
    const beforeIds = new Set(current.items.map(item => item.blockId));
    const anchor = current.items.at(-1)?.blockId || current.headingBlockId;
    if (!anchor) throw new FeishuSourceError('飞书项目记录章节缺少可写入锚点。', { code: 'FEISHU_PROJECT_RECORD_FORMAT' });
    await updateDocument(normalizedUrl, {
      anchorBlockId: anchor,
      content: `<p>${escapeXml(`${prefix} ${projectRecordMarker(op)} ${value}`)}</p>`
    }, { exec, timeoutMs });
    const fetched = await fetchRecords(normalizedUrl, { heading });
    const matches = fetched.items.filter(item => item.kind === kind && item.operationId === op);
    if (matches.length !== 1) throw new FeishuSourceError('飞书项目记录写入后读回无法唯一确认 operationId。', { code: 'FEISHU_PROJECT_RECORD_READBACK_FAILED' });
    const item = matches[0];
    const replayed = beforeIds.has(item.blockId);
    return { ...fetched, item, replayed, operationId: op };
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
  if (!project || !String(project.feishu || '').trim()) return false;
  try { normalizeFeishuProjectDocumentUrl(project.feishu); return true; }
  catch { return false; }
}

export {
  escapeXml,
  validateDocumentUrl,
  WORKBENCH_INBOX_HEADING,
  PROJECT_RECORD_HEADING,
  PROJECT_ANALYSIS_PREFIX,
  PROJECT_SUMMARY_PREFIX
};
