import path from 'node:path';
import crypto from 'node:crypto';

export function todayIso(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

export function nowIso() { return new Date().toISOString(); }

export function newId(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function dueDeltaDays(dateString, now = new Date()) {
  if (!dateString) return Infinity;
  const end = new Date(`${dateString}T23:59:59`);
  return Math.ceil((end - now) / 86400000);
}

export function parseDateLike(input, base = new Date()) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
  m = s.match(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) return `${base.getFullYear()}-${String(+m[1]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
  m = s.match(/(?:下周)([一二三四五六日天])/);
  if (m) {
    const dayMap = {一:1,二:2,三:3,四:4,五:5,六:6,日:0,天:0};
    const d = new Date(base);
    const current = d.getDay();
    let add = (7-current) + dayMap[m[1]];
    if (current === 0) add = dayMap[m[1]] || 7;
    d.setDate(d.getDate()+add);
    return todayIso(d);
  }
  return null;
}

export function sanitizeFolderName(name) {
  const raw = String(name || '').trim();
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return cleaned || `项目_${Date.now()}`;
}

export function safeResolve(base, ...parts) {
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('路径越界，已拒绝访问。');
  return full;
}

export function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }

export function compactText(value, max=160) {
  const s = String(value ?? '').replace(/\s+/g,' ').trim();
  return s.length <= max ? s : s.slice(0,max-1) + '…';
}

export function timingSafeEqualText(a,b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa,bb);
}
