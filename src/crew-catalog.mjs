// crew-catalog.mjs — 员工与技能目录（AI 工作台场景 #39「个人工作台」）
// 只读盘点本机数字员工与技能，不修改任何源文件。
// 数据源：
//   - Codex 数字员工：~/.codex/agents/*.toml
//   - Codex 技能：~/.codex/skills/*/SKILL.md
//   - DeepSeek Harness (dsh) 技能：~/.dsh/skills/*/SKILL.md
//   - Hermes 技能：~/.hermes/hermes-agent/skills/**/SKILL.md
//   - 底座状态：dsh web 服务 (127.0.0.1:3080) 存活探测
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = path.dirname(__filename);
const DEFAULT_HOME_DIR = process.env.HOME || os.homedir();

const CACHE_TTL_MS = 60_000;
const SKILL_MD_FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function safeRead(file) {
  return fsp.readFile(file, 'utf8').catch(() => null);
}

function parseFrontmatter(text) {
  if (!text) return {};
  const match = text.match(SKILL_MD_FRONTMATTER);
  if (!match) return {};
  const fm = match[1];
  const field = (key) => (fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm')) || [])[1]?.trim() || '';
  return { name: field('name'), description: field('description') };
}

// 从 TOML 提取字段：name / description / sandbox_mode 为单行引号；dept / risk 从 developer_instructions 中文段取
// title 从 description 开头提取（第一个句号前的内容），即岗位名
function parseAgentToml(text) {
  const field = (key) => (text.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm')) || [])[1]?.trim() || '';
  const line = (key) => (text.match(new RegExp(`${key}[:：]\\s*([^\\n]+)`, 'm')) || [])[1]?.trim() || '';
  const description = field('description');
  // 岗位名 = description 第一个句号前的内容（如"AI日终复盘与任务推进助理"）
  const titleMatch = description.match(/^([^。]+)。/);
  const title = titleMatch ? titleMatch[1].trim() : '';
  return {
    name: field('name'),
    title,  // 岗位名（从 description 提取）
    description,
    sandbox: field('sandbox_mode'),
    dept: line('部门') || '未标部门',
    risk: line('风险等级') || '未标风险',
  };
}

async function readDirs(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function scanCodexAgents(homeDir) {
  const dir = path.join(homeDir, '.codex', 'agents');
  const out = [];
  for (const entry of await readDirs(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.toml') || entry.name.includes('.bak')) continue;
    const id = entry.name.replace(/\.toml$/, '');
    if (!SAFE_AGENT_ID.test(id)) continue;
    const text = await safeRead(path.join(dir, entry.name));
    if (!text) continue;
    const parsed = parseAgentToml(text);
    out.push({
      id,
      file: entry.name,
      path: path.join(dir, entry.name),
      ...parsed,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function scanSkillDir(root, source) {
  const out = [];
  const walk = async (dir, rel, depth) => {
    if (depth > 4) return;
    for (const entry of await readDirs(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.startsWith('_')) continue;
      const full = path.join(dir, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const md = path.join(full, 'SKILL.md');
      const text = await safeRead(md);
      if (text) {
        const fm = parseFrontmatter(text);
        out.push({
          id: `${source}:${nextRel}`,
          source,
          name: fm.name || entry.name,
          description: fm.description || '',
          dir: entry.name,
          path: md,
          parent: rel,
        });
      } else {
        await walk(full, nextRel, depth + 1);
      }
    }
  };
  await walk(root, '', 0);
  return out;
}

async function scanCodexSkills(homeDir) {
  return scanSkillDir(path.join(homeDir, '.codex', 'skills'), 'codex');
}

async function scanDshSkills(homeDir) {
  return scanSkillDir(path.join(homeDir, '.dsh', 'skills'), 'harness');
}

async function scanHermesSkills(homeDir) {
  return scanSkillDir(path.join(homeDir, '.hermes', 'hermes-agent', 'skills'), 'hermes');
}

// dsh web 服务存活探测（127.0.0.1:3080，5 秒超时）
function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function readDshWebInfo(homeDir) {
  const pidFile = path.join(homeDir, '.dsh', 'dsh-web.pid');
  const text = await safeRead(pidFile);
  const pid = text ? text.trim() : null;
  return { pid, port: 3080 };
}

async function readHarnessVersion(appRoot) {
  const text = await safeRead(path.join(appRoot, 'harness', 'package.json'));
  if (!text) return 'unknown';
  try {
    const packageJson = JSON.parse(text);
    return packageJson.dependencies?.['@deepseek-ai/dsh'] || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createCrewCatalog({
  appRoot = path.dirname(SRC_DIR),
  homeDir = DEFAULT_HOME_DIR,
  cacheTtlMs = CACHE_TTL_MS,
  probe = probeTcp,
  harnessVersion = null
} = {}) {
  const catalogHome = path.resolve(homeDir || DEFAULT_HOME_DIR);
  let cache = null;
  let cacheAt = 0;

  async function catalog() {
    const now = Date.now();
    if (cache && now - cacheAt < cacheTtlMs) return cache;
    const [agents, codexSkills, harnessSkills, hermesSkills, webAlive, web, version] = await Promise.all([
      scanCodexAgents(catalogHome),
      scanCodexSkills(catalogHome),
      scanDshSkills(catalogHome),
      scanHermesSkills(catalogHome),
      probe('127.0.0.1', 3080),
      readDshWebInfo(catalogHome),
      harnessVersion || readHarnessVersion(appRoot)
    ]);
    const skills = [...codexSkills, ...harnessSkills, ...hermesSkills];
    const result = {
      scannedAt: new Date().toISOString(),
      agents,
      skills,
      counts: {
        agents: agents.length,
        codexSkills: codexSkills.length,
        harnessSkills: harnessSkills.length,
        hermesSkills: hermesSkills.length,
        totalSkills: skills.length,
      },
      harness: {
        web: { alive: webAlive, port: web.port, pid: web.pid },
        version,
      },
    };
    cache = result;
    cacheAt = now;
    return result;
  }

  return { catalog };
}
