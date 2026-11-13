'use strict';
// รัน:  node --test server/test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const L = require('../lib');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, '..', 'index.html');
const TEST_PW = 'test-only-password-123';

// ---------- ใช้โค้ดอ่านข้อมูลของ index.html จริง ๆ ----------
function loadPageParsers() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');
  const grab = (re, name) => { const m = html.match(re); assert.ok(m, `ไม่พบ ${name} ใน index.html`); return m[0]; };
  const code = [
    grab(/function parseCsvRow\(row\) \{[\s\S]*?\n        \}\n/, 'parseCsvRow'),
    grab(/function applyVaccinesCsv\(data\) \{[\s\S]*?\n        \}\n/, 'applyVaccinesCsv'),
    grab(/function applyHolidaysCsv\(data\) \{[\s\S]*?\n        \}\n/, 'applyHolidaysCsv'),
  ].join('\n');
  const ctx = { vaccineSchedules: {}, dynamicHolidays: {}, dynamicHolidayYears: new Set() };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.applyVaccinesCsv = applyVaccinesCsv; this.applyHolidaysCsv = applyHolidaysCsv;', ctx);
  return ctx;
}

test('CSV จาก server → หน้าเว็บอ่านได้ข้อมูลเดียวกับ CSV เดิม (วัคซีน)', () => {
  const seed = fs.readFileSync(path.join(ROOT, 'seed', 'vaccines.csv'), 'utf8');
  const rows = L.parseVaccinesCsv(seed);
  const a = loadPageParsers(); a.applyVaccinesCsv(seed);
  const b = loadPageParsers(); b.applyVaccinesCsv(L.vaccinesToCsv(rows));
  assert.deepEqual(JSON.parse(JSON.stringify(b.vaccineSchedules)), JSON.parse(JSON.stringify(a.vaccineSchedules)));
  assert.deepEqual(Object.keys(b.vaccineSchedules), Object.keys(a.vaccineSchedules), 'ลำดับช่วงอายุต้องเท่าเดิม');
  assert.equal(Object.keys(a.vaccineSchedules).length, 9);
});

test('CSV จาก server → หน้าเว็บอ่านได้ข้อมูลเดียวกับ CSV เดิม (วันหยุด)', () => {
  const seed = fs.readFileSync(path.join(ROOT, 'seed', 'holidays.csv'), 'utf8');
  const rows = L.parseHolidaysCsv(seed);
  const a = loadPageParsers(); a.applyHolidaysCsv(seed);
  const b = loadPageParsers(); b.applyHolidaysCsv(L.holidaysToCsv(rows));
  assert.deepEqual({ ...b.dynamicHolidays }, { ...a.dynamicHolidays });
  assert.deepEqual([...b.dynamicHolidayYears], [...a.dynamicHolidayYears]);
});

test('validation: ปฏิเสธข้อมูลอันตรายหรือผิดรูปแบบ', () => {
  const ok = L.parseVaccinesCsv(fs.readFileSync(path.join(ROOT, 'seed', 'vaccines.csv'), 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(ok));
  let v = clone(); v[0].name = '<img src=x onerror=alert(1)>'; assert.throws(() => L.validateVaccines(v), L.ValidationError);
  v = clone(); v[0].vaccines[0].name = 'a/b'; assert.throws(() => L.validateVaccines(v), /อักขระที่ไม่อนุญาต/);
  v = clone(); v[1].code = v[0].code; assert.throws(() => L.validateVaccines(v), /ซ้ำ/);
  v = clone(); v[0].weeks = []; assert.throws(() => L.validateVaccines(v), /สัปดาห์/);
  v = clone(); v[0].weeks = [6]; assert.throws(() => L.validateVaccines(v), /สัปดาห์/);
  v = clone(); v[0].nextAge = 'nope'; assert.throws(() => L.validateVaccines(v), /ไม่มีในตาราง/);
  assert.throws(() => L.validateVaccines([]), /อย่างน้อย 1/);
  assert.throws(() => L.validateHolidays([{ date: '2026-02-30', name: 'x' }]), /ไม่มีวันนี้/);
  assert.throws(() => L.validateHolidays([{ date: '26/01/2026', name: 'x' }]), /รูปแบบ/);
  assert.throws(() => L.validateHolidays([{ date: '2026-01-01', name: 'a"b' }]), /ไม่อนุญาต/);
});

test('นำเข้า CSV วันหยุดรูปแบบ วว/ดด/พ.ศ. ได้', () => {
  const r = L.parseHolidaysCsv('Date,Name\n13/05/2569,วันพืชมงคล\n');
  assert.deepEqual(r, [{ date: '2026-05-13', name: 'วันพืชมงคล' }]);
});

test('คอมมาในชื่อวันหยุดต้องไม่ทำให้ CSV เพี้ยน', () => {
  const csv = L.holidaysToCsv([{ date: '2026-05-13', name: 'หยุดชดเชย, กรณีพิเศษ' }]);
  const a = loadPageParsers(); a.applyHolidaysCsv(csv);
  assert.equal(a.dynamicHolidays['2026-05-13'], 'หยุดชดเชย, กรณีพิเศษ');
});

// ---------- integration: เปิด server จริงบนพอร์ตสุ่ม ----------
let proc, base, dataDir, webDir;
const J = { 'Content-Type': 'application/json', 'X-WCC': '1' };
async function login(pw = TEST_PW) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: J, body: JSON.stringify({ password: pw }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, cookie };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-test-'));
  webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-web-'));
  fs.copyFileSync(INDEX_HTML, path.join(webDir, 'index.html'));
  fs.copyFileSync(path.join(ROOT, '..', 'pcv-rules.js'), path.join(webDir, 'pcv-rules.js'));
  fs.copyFileSync(path.join(ROOT, 'admin.html'), path.join(webDir, 'admin.html'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, WEB_DIR: webDir };
  const sp = spawnSync(process.execPath, [path.join(ROOT, 'set-password.js'), '--stdin'], { input: TEST_PW + '\n', env });
  assert.equal(sp.status, 0, sp.stderr.toString());
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server ไม่ขึ้น');
});
after(() => { proc && proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(webDir, { recursive: true, force: true }); });

test('หน้าสาธารณะ: index.html และ CSV เปิดได้โดยไม่ต้อง login', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  const v = await (await fetch(base + '/data/vaccines.csv')).text();
  assert.match(v, /^AgeCode,AgeName/);
  assert.equal((await fetch(base + '/data/holidays.csv')).status, 200);
  assert.equal((await fetch(base + '/admin')).headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true);
});

test('เสิร์ฟ /pcv-rules.js (ถ้าขาด PCV จะหายเงียบ ๆ)', async () => {
  const r = await fetch(base + '/pcv-rules.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(await r.text(), /PCV/);
});

test('ไฟล์อื่นเข้าไม่ได้ (ไม่มี static ทั่วไป / path traversal)', async () => {
  for (const p of ['/data/admin.json', '/data/store.json', '/server.js', '/../server.js', '/%2e%2e/server.js', '/admin.json']) {
    const r = await fetch(base + p); assert.equal(r.status, 404, p);
  }
});

test('API แอดมินต้อง login (401) และเขียนต้องมี header กัน CSRF', async () => {
  assert.equal((await fetch(base + '/api/admin/store')).status, 401);
  assert.equal((await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: J, body: '{}' })).status, 401);
  const { cookie } = await login();
  const noHeader = await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
  assert.equal(noHeader.status, 400);
  const form = await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'X-WCC': '1', cookie }, body: '{}' });
  assert.equal(form.status, 400);
});

test('login ผิด = 401, cookie เป็น HttpOnly+SameSite', async () => {
  assert.equal((await login('wrong-password-xx')).r.status, 401);
  const { r } = await login();
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
});

test('บันทึกวัคซีน → CSV สาธารณะเปลี่ยนตาม + มีไฟล์สำรอง + audit log', async () => {
  const { cookie } = await login();
  const H = { ...J, cookie };
  const st = await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json();
  const vac = st.vaccines; vac[0].special = 'ทดสอบหมายเหตุใหม่';
  const put = await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: vac }) });
  assert.equal(put.status, 200);
  assert.match(await (await fetch(base + '/data/vaccines.csv')).text(), /ทดสอบหมายเหตุใหม่/);
  assert.ok(fs.readdirSync(path.join(dataDir, 'backups')).length >= 1, 'ต้องมีไฟล์สำรอง');
  assert.match(fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8'), /save vaccines/);
  // ข้อมูลเสียถูกปฏิเสธและไม่ทับของเดิม
  vac[0].name = '<script>';
  const bad = await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: vac }) });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await (await fetch(base + '/data/vaccines.csv')).text(), /<script>/);
});

test('บันทึกวันหยุดและนำเข้า CSV', async () => {
  const { cookie } = await login(); const H = { ...J, cookie };
  const put = await fetch(base + '/api/admin/holidays', { method: 'PUT', headers: H, body: JSON.stringify({ holidays: [{ date: '2026-12-24', name: 'หยุดทดสอบ' }] }) });
  assert.equal(put.status, 200);
  assert.match(await (await fetch(base + '/data/holidays.csv')).text(), /2026-12-24,หยุดทดสอบ/);
  const imp = await fetch(base + '/api/admin/import', { method: 'POST', headers: H, body: JSON.stringify({ holidaysCsv: 'Date,Name\n2026-01-02,นำเข้า\n' }) });
  assert.equal(imp.status, 200);
  assert.match(await (await fetch(base + '/data/holidays.csv')).text(), /2026-01-02,นำเข้า/);
});

test('ข้อมูลคลินิก: public อ่านได้, แก้ต้อง login, ข้อมูลเสียถูกปฏิเสธ, บันทึกแล้ว public เปลี่ยนตาม', async () => {
  const pub = await fetch(base + '/data/settings.json');
  assert.equal(pub.status, 200);
  const def = await pub.json();
  assert.deepEqual(def, { hospitalName: 'โรงพยาบาลวังน้ำเย็น', appTitle: 'ระบบนัดหมายวัคซีน WCC', clinicShort: 'WCC' });

  const body = JSON.stringify({ settings: { hospitalName: 'รพ.ทดสอบ', appTitle: 'นัดวัคซีนทดสอบ', clinicShort: 'TST' } });
  assert.equal((await fetch(base + '/api/admin/settings', { method: 'PUT', headers: J, body })).status, 401, 'ไม่ login ต้องแก้ไม่ได้');

  const { cookie } = await login(); const H = { ...J, cookie };
  for (const bad of [
    { hospitalName: '', appTitle: 'x', clinicShort: 'x' },                    // ว่าง
    { hospitalName: '<script>', appTitle: 'x', clinicShort: 'x' },            // XSS
    { hospitalName: 'x', appTitle: 'x'.repeat(81), clinicShort: 'x' },        // ยาวเกิน
    { hospitalName: 'x', appTitle: 'x', clinicShort: 'ยาวเกินยี่สิบตัวอักษรแน่นอนแน่นอน' },
  ]) {
    const r = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: bad }) });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(await (await fetch(base + '/data/settings.json')).json(), def, 'ข้อมูลเสียต้องไม่ทับของเดิม');

  const ok = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(await (await fetch(base + '/data/settings.json')).json(), { hospitalName: 'รพ.ทดสอบ', appTitle: 'นัดวัคซีนทดสอบ', clinicShort: 'TST' });
  assert.equal((await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json()).settings.clinicShort, 'TST');
  assert.match(fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8'), /save clinic settings/);
  // คืนค่าเดิม ไม่ให้กระทบเทสต์อื่น
  await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: def }) });
});

test('store.json รุ่นเก่า (ไม่มี settings) → เติมค่าตั้งต้นให้ ไม่ทำให้ server ล้ม', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-old-'));
  const seedFile = path.join(ROOT, 'seed');
  const old = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', vaccines: [{ code: '2m', name: '2 เดือน', vaccines: [{ name: 'X', thai: 'เอ็กซ์', type: 'injection' }], schedule: '', weeks: [1], time: '', nextAge: '', special: '' }], holidays: [] };
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(old));
  assert.ok(fs.existsSync(seedFile));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, WEB_DIR: webDir }, stdio: 'ignore' });
  try {
    let res;
    for (let i = 0; i < 50 && !res; i++) { try { res = await fetch(`http://127.0.0.1:${port}/data/settings.json`); } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(res, 'server ไม่ขึ้น');
    assert.equal((await res.json()).clinicShort, 'WCC');
  } finally { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('logout แล้ว session ใช้ไม่ได้', async () => {
  const { cookie } = await login();
  await fetch(base + '/api/logout', { method: 'POST', headers: { ...J, cookie }, body: '{}' });
  assert.equal((await fetch(base + '/api/admin/store', { headers: { cookie } })).status, 401);
});

test('ลองรหัสผิด 5 ครั้ง → 429 (rate limit) แม้ใส่รหัสถูกก็ถูกบล็อกชั่วคราว', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = (await login('definitely-wrong-' + i)).r.status;
  assert.equal(last, 429);
  assert.equal((await login()).r.status, 429);
});
