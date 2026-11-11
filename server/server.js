'use strict';
// WCC Vaccine server — Node ล้วน ไม่มี dependency
//  - เสิร์ฟ index.html + /data/*.csv (สร้างจากฐานข้อมูลของ server เอง) ให้หน้าเว็บเดิมใช้ได้ทันที
//  - /admin = หน้าตั้งค่า (ต้อง login) แก้ตารางวัคซีนและวันหยุด
// ENV: PORT (8100), HOST (0.0.0.0 ช่วงแรก → เปลี่ยนเป็น 127.0.0.1 เมื่อผูก Cloudflare), DATA_DIR, WEB_DIR
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const PORT = parseInt(process.env.PORT || '8100', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const WEB_DIR = process.env.WEB_DIR || ROOT;               // ที่อยู่ของ index.html / admin.html
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE = path.join(DATA_DIR, 'store.json');
const ADMIN = path.join(DATA_DIR, 'admin.json');
const BACKUPS = path.join(DATA_DIR, 'backups');
const AUDIT = path.join(DATA_DIR, 'audit.log');
const SESSION_MS = 8 * 3600 * 1000;
const MAX_BODY = 1024 * 1024;

fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });

// ---------- store ----------
function seedStore() {
  const v = L.parseVaccinesCsv(fs.readFileSync(path.join(ROOT, 'seed', 'vaccines.csv'), 'utf8'));
  const h = L.parseHolidaysCsv(fs.readFileSync(path.join(ROOT, 'seed', 'holidays.csv'), 'utf8'));
  return { version: 1, updatedAt: new Date().toISOString(), vaccines: v, holidays: h };
}
function writeAtomic(file, text, mode) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}
function loadStore() {
  if (!fs.existsSync(STORE)) { const s = seedStore(); writeAtomic(STORE, JSON.stringify(s, null, 2)); audit('system', 'seed from bundled CSV'); return s; }
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}
function saveStore(next, what) {
  if (fs.existsSync(STORE)) {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(STORE, path.join(BACKUPS, `store-${ts}-${crypto.randomBytes(2).toString('hex')}.json`));
    const files = fs.readdirSync(BACKUPS).filter(f => f.startsWith('store-')).sort();
    files.slice(0, Math.max(0, files.length - 50)).forEach(f => fs.unlinkSync(path.join(BACKUPS, f)));
  }
  next.updatedAt = new Date().toISOString();
  writeAtomic(STORE, JSON.stringify(next, null, 2));
  store = next;
  audit('admin', what);
}
function audit(who, what) {
  try { fs.appendFileSync(AUDIT, `${new Date().toISOString()}\t${who}\t${what}\n`, { mode: 0o600 }); } catch (e) { /* ไม่ให้ log พังแล้วระบบล้ม */ }
}
let store = loadStore();

// ---------- auth ----------
function readAdmin() { try { return JSON.parse(fs.readFileSync(ADMIN, 'utf8')); } catch (e) { return null; } }
function checkPassword(pw) {
  const a = readAdmin();
  if (!a || typeof pw !== 'string' || pw.length > 200) return false;
  const salt = Buffer.from(a.salt, 'hex');
  const want = Buffer.from(a.hash, 'hex');
  const got = crypto.scryptSync(pw, salt, want.length);
  return crypto.timingSafeEqual(got, want);
}
const sessions = new Map(); // token -> expiresAt
function newSession() {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_MS);
  return t;
}
function cookieOf(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}
function isAdmin(req) {
  const t = cookieOf(req, 'wcc_sid');
  const exp = sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  const fromLocal = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  // เชื่อ CF-Connecting-IP เฉพาะเมื่อมาจาก tunnel (loopback) เท่านั้น กันปลอมจาก LAN
  return (fromLocal && req.headers['cf-connecting-ip']) || ra;
}
const fails = new Map(); // ip -> {n, first}
function rateLimited(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60 * 1000) { fails.delete(ip); return false; }
  return f.n >= 5;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) fails.set(ip, { n: 1, first: Date.now() });
  else f.n++;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, e] of sessions) if (e < now) sessions.delete(t);
  for (const [ip, f] of fails) if (now - f.first > 15 * 60 * 1000) fails.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- http helpers ----------
function secureReq(req) { return req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || ''); }
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  }, extra || {}));
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new L.ValidationError('ข้อมูลใหญ่เกินไป')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new L.ValidationError('JSON ไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}
function serveFile(res, file, type, extraHeaders) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, type, Object.assign({ 'Cache-Control': 'no-cache' }, extraHeaders || {}));
  });
}
const ADMIN_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && p === '/healthz') return json(res, 200, { ok: true, vaccines: store.vaccines.length, holidays: store.holidays.length });

    // --- public ---
    if (m === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
    if (m === 'GET' && p === '/pcv-rules.js') return serveFile(res, path.join(WEB_DIR, 'pcv-rules.js'), 'application/javascript; charset=utf-8');
    if (m === 'GET' && p === '/data/vaccines.csv') return send(res, 200, L.vaccinesToCsv(store.vaccines), 'text/csv; charset=utf-8');
    if (m === 'GET' && p === '/data/holidays.csv') return send(res, 200, L.holidaysToCsv(store.holidays), 'text/csv; charset=utf-8');
    if (m === 'GET' && (p === '/admin' || p === '/admin/' || p === '/admin.html')) {
      return serveFile(res, path.join(WEB_DIR, 'admin.html'), 'text/html; charset=utf-8', { 'Content-Security-Policy': ADMIN_CSP, 'X-Frame-Options': 'DENY' });
    }

    // --- auth ---
    if (m === 'GET' && p === '/api/me') return json(res, 200, { admin: isAdmin(req), passwordSet: !!readAdmin() });

    if (p.startsWith('/api/') && m !== 'GET') {
      // กัน CSRF: ต้องมี header ที่ฟอร์มข้ามเว็บส่งเองไม่ได้ + เป็น JSON
      if (req.headers['x-wcc'] !== '1' || !/application\/json/.test(req.headers['content-type'] || '')) {
        return json(res, 400, { error: 'คำขอไม่ถูกต้อง' });
      }
    }

    if (m === 'POST' && p === '/api/login') {
      const ip = clientIp(req);
      if (rateLimited(ip)) { audit(ip, 'login blocked (rate limit)'); return json(res, 429, { error: 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที' }); }
      const body = await readBody(req);
      if (!readAdmin()) return json(res, 503, { error: 'ยังไม่ได้ตั้งรหัสผ่านแอดมินบน server (รัน node set-password.js)' });
      if (!checkPassword(body.password)) {
        noteFail(ip); audit(ip, 'login FAILED');
        return json(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
      }
      fails.delete(ip);
      const t = newSession(); audit(ip, 'login ok');
      const secure = secureReq(req) ? '; Secure' : '';
      return json(res, 200, { ok: true }, { 'Set-Cookie': `wcc_sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (m === 'POST' && p === '/api/logout') {
      sessions.delete(cookieOf(req, 'wcc_sid'));
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'wcc_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    // --- admin (ต้อง login) ---
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
      if (m === 'GET' && p === '/api/admin/store') return json(res, 200, { vaccines: store.vaccines, holidays: store.holidays, updatedAt: store.updatedAt });
      if (m === 'PUT' && p === '/api/admin/vaccines') {
        const b = await readBody(req);
        const v = L.validateVaccines(b.vaccines);
        saveStore(Object.assign({}, store, { vaccines: v }), `save vaccines (${v.length} rows)`);
        return json(res, 200, { ok: true, vaccines: store.vaccines, updatedAt: store.updatedAt });
      }
      if (m === 'PUT' && p === '/api/admin/holidays') {
        const b = await readBody(req);
        const h = L.validateHolidays(b.holidays);
        saveStore(Object.assign({}, store, { holidays: h }), `save holidays (${h.length} rows)`);
        return json(res, 200, { ok: true, holidays: store.holidays, updatedAt: store.updatedAt });
      }
      if (m === 'POST' && p === '/api/admin/import') {
        const b = await readBody(req);
        const next = Object.assign({}, store);
        const done = [];
        if (typeof b.vaccinesCsv === 'string' && b.vaccinesCsv.trim()) { next.vaccines = L.parseVaccinesCsv(b.vaccinesCsv); done.push(`vaccines ${next.vaccines.length}`); }
        if (typeof b.holidaysCsv === 'string' && b.holidaysCsv.trim()) { next.holidays = L.parseHolidaysCsv(b.holidaysCsv); done.push(`holidays ${next.holidays.length}`); }
        if (!done.length) throw new L.ValidationError('ไม่มีข้อมูล CSV ให้นำเข้า');
        saveStore(next, 'import CSV: ' + done.join(', '));
        return json(res, 200, { ok: true, imported: done, vaccines: store.vaccines, holidays: store.holidays });
      }
      return json(res, 404, { error: 'ไม่พบ' });
    }

    return send(res, 404, 'Not found');
  } catch (e) {
    if (e instanceof L.ValidationError) return json(res, 400, { error: e.message });
    console.error(e);
    return json(res, 500, { error: 'เกิดข้อผิดพลาดบน server' });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(PORT, HOST, () => console.log(`WCC vaccine server on http://${HOST}:${PORT}  data=${DATA_DIR}`));
