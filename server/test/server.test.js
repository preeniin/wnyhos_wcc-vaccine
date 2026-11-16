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
  assert.deepEqual(def, L.DEFAULT_SETTINGS);

  const body = JSON.stringify({ settings: { hospitalName: 'รพ.ทดสอบ', appTitle: 'นัดวัคซีนทดสอบ', clinicShort: 'TST' } });
  assert.equal((await fetch(base + '/api/admin/settings', { method: 'PUT', headers: J, body })).status, 401, 'ไม่ login ต้องแก้ไม่ได้');

  const { cookie } = await login(); const H = { ...J, cookie };
  for (const bad of [
    { hospitalName: '', appTitle: 'x', clinicShort: 'x' },                    // ว่าง
    { hospitalName: '<script>', appTitle: 'x', clinicShort: 'x' },            // XSS
    { hospitalName: 'x', appTitle: 'x'.repeat(81), clinicShort: 'x' },        // ยาวเกิน
    { hospitalName: 'x', appTitle: 'x', clinicShort: 'ยาวเกินยี่สิบตัวอักษรแน่นอนแน่นอน' },
    { ...def, pcvWeeks: [] },                 // PCV: ไม่เลือกสัปดาห์เลย
    { ...def, pcvWeeks: [1, 6] },             // PCV: สัปดาห์นอกช่วง 1–5
    { ...def, pcvMaxAgeMonths: 2 },           // PCV: อายุสูงสุดต่ำเกิน
    { ...def, pcvProduct: '<b>' },            // PCV: อักขระต้องห้าม
    { ...def, pcvSession: 'กลางคืน' },       // PCV: ช่วงเวลาต้องเช้า/บ่าย
    { ...def, pcvTime: '15:00-13:00น.' },    // PCV: เวลาเริ่มต้องน้อยกว่าเวลาเลิก
    { ...def, rotaAuto: 'yes' },                              // โรต้า: โหมดต้องเป็น boolean
    { ...def, rotaAuto: false, rotaNames: ['Rota1'], rotaFirst: 'Rota9' },   // โรต้า: เข็มแรกต้องอยู่ในรายการที่เลือก
    { ...def, rotaNames: ['a<b'] },
    { ...def, rotaDoses: 4 },                                   // โรต้า: สูตรต้อง 2 หรือ 3 เข็ม
    { ...def, rotaDoses: '2' },                             // โรต้า: อักขระต้องห้าม
    { ...def, serviceWeekday: 0 },            // วันให้บริการ: อาทิตย์ไม่อนุญาต
    { ...def, serviceWeekday: 'พุธ' },        // วันให้บริการ: ต้องเป็นตัวเลข
    { ...def, serviceStart: '12:00', serviceEnd: '9:00' },   // เวลาเปิดต้องก่อนเวลาปิด
    { ...def, serviceStart: '8.00' },         // เวลา: รูปแบบผิด
  ]) {
    const r = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: bad }) });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(await (await fetch(base + '/data/settings.json')).json(), def, 'ข้อมูลเสียต้องไม่ทับของเดิม');

  const ok = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body });
  assert.equal(ok.status, 200);
  // ไม่ส่งฟิลด์ PCV (ไคลเอนต์รุ่นเก่า) → ใช้ค่าตั้งต้น
  assert.deepEqual(await (await fetch(base + '/data/settings.json')).json(), { ...def, hospitalName: 'รพ.ทดสอบ', appTitle: 'นัดวัคซีนทดสอบ', clinicShort: 'TST' });
  // ตั้งค่า PCV เข็มเดี่ยว: เว้นสัปดาห์ + ชื่อวัคซีน + อายุสูงสุด
  const pcv = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: { ...def, clinicShort: 'TST', pcvWeeks: [3, 1, 3], pcvProduct: 'PCV-X', pcvMaxAgeMonths: 36 } }) });
  assert.equal(pcv.status, 200);
  const got = await (await fetch(base + '/data/settings.json')).json();
  assert.deepEqual(got.pcvWeeks, [1, 3]);
  const ro = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: { ...def, clinicShort: 'TST', rotaAuto: false, rotaNames: ['โรต้า 1', 'โรต้า 2', 'โรต้า 1'], rotaFirst: 'โรต้า 1', rotaDoses: 2 } }) });
  assert.equal(ro.status, 200);
  const gr = await (await fetch(base + '/data/settings.json')).json();
  assert.equal(gr.rotaAuto, false); assert.deepEqual(gr.rotaNames, ['โรต้า 1', 'โรต้า 2']); assert.equal(gr.rotaFirst, 'โรต้า 1'); assert.equal(gr.rotaDoses, 2);
  const pt = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: { ...def, clinicShort: 'TST', pcvSession: 'บ่าย', pcvTime: '13:00 - 15:00 น' } }) });
  assert.equal(pt.status, 200);
  const gp = await (await fetch(base + '/data/settings.json')).json();
  assert.equal(gp.pcvSession, 'บ่าย'); assert.equal(gp.pcvTime, '13:00-15:00น.');
  // วัน/เวลาให้บริการ: ตั้งเป็นพฤหัส 9:00–12:00 แล้วข้อความรอบอัตโนมัติของแถวใหม่ต้องใช้ชื่อวันตามที่ตั้ง + เวลาของวัคซีนต้องรูปแบบมาตรฐาน
  const svc = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: { ...def, clinicShort: 'TST', serviceWeekday: 4, serviceStart: '09:00', serviceEnd: '12:00' } }) });
  assert.equal(svc.status, 200);
  const g2 = await (await fetch(base + '/data/settings.json')).json();
  assert.equal(g2.serviceWeekday, 4); assert.equal(g2.serviceStart, '9:00'); assert.equal(g2.serviceEnd, '12:00');
  const vacs = (await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json()).vaccines;
  const mk = time => vacs.map((x, i) => i === 0 ? { ...x, schedule: '', time } : x);
  // ข้อความรอบแบบอัตโนมัติต้องตามวันที่ตั้ง (พฤหัสบดี) ส่วนข้อความที่แอดมินเขียนเองต้องไม่ถูกแตะ
  const sv = (await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json()).vaccines;
  const mk2 = (sched0, sched1) => sv.map((x, i) => i === 0 ? { ...x, schedule: sched0 } : i === 1 ? { ...x, schedule: sched1 } : x);
  const rs = await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: mk2('วันพุธ สัปดาห์ที่ 1,3,5 เวลา 8:00-11:30น.', 'วันพุธ พิเศษ ยกเว้นเดือน ธ.ค.') }) });
  assert.equal(rs.status, 200);
  const after2 = (await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json()).vaccines;
  assert.match(after2[0].schedule, /^วันพฤหัสบดี สัปดาห์ที่ /, 'ข้อความอัตโนมัติต้องตามวันที่ตั้ง');
  assert.equal(after2[1].schedule, 'วันพุธ พิเศษ ยกเว้นเดือน ธ.ค.', 'ข้อความที่เขียนเองต้องไม่ถูกแตะ');
  await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: sv }) });
  const okV = await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: mk('9:00 - 11:30 น') }) });
  assert.equal(okV.status, 200);
  const v0 = (await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json()).vaccines[0];
  assert.equal(v0.time, '9:00-11:30น.'); assert.match(v0.schedule, /^วันพฤหัสบดี /);
  for (const bad of ['เช้า', '8:00', '12:00-9:00', '25:00-26:00']) {
    assert.equal((await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: mk(bad) }) })).status, 400, 'เวลา ' + bad);
  }
  await fetch(base + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: vacs }) });   // คืนข้อมูลวัคซีนเดิม assert.equal(got.pcvProduct, 'PCV-X'); assert.equal(got.pcvMaxAgeMonths, 36);
  assert.equal((await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json()).settings.clinicShort, 'TST');
  assert.match(fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8'), /save clinic settings/);
  // คืนค่าเดิม ไม่ให้กระทบเทสต์อื่น
  await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: def }) });
});

test('audit log ระบุผู้แก้จากอีเมล Cloudflare Access (เฉพาะรูปแบบที่ถูกต้อง) · ไม่มี header = admin', async () => {
  const { cookie } = await login();
  const hol = [{ date: '2026-12-01', name: 'ผู้แก้ทดสอบ' }];
  const put = (extra) => fetch(base + '/api/admin/holidays', { method: 'PUT', headers: { ...J, cookie, ...extra }, body: JSON.stringify({ holidays: hol }) });
  assert.equal((await put({ 'Cf-Access-Authenticated-User-Email': 'Nurse.A@Example.org' })).status, 200);
  let audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  assert.match(audit, /\tnurse\.a@example\.org\tsave holidays/, 'ต้องบันทึกอีเมล (ตัวพิมพ์เล็ก)');
  let st = await (await fetch(base + '/api/admin/store', { headers: { cookie, 'Cf-Access-Authenticated-User-Email': 'nurse.a@example.org' } })).json();
  assert.equal(st.updatedBy, 'nurse.a@example.org');
  assert.equal(st.me, 'nurse.a@example.org');
  // header ผิดรูปแบบ (มีช่องว่าง/อักขระต้องห้าม/ขึ้นบรรทัดใหม่) ต้องไม่ถูกเชื่อ → admin
  for (const bad of ['a b@example.org', 'x<script>@example.org', 'no-at-sign', 'a@b,c@d']) {
    assert.equal((await put({ 'Cf-Access-Authenticated-User-Email': bad })).status, 200);
    st = await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json();
    assert.equal(st.updatedBy, 'admin', bad);
  }
  audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  assert.doesNotMatch(audit, /script/, 'ค่าแปลกปลอมห้ามเข้า log');
});

test('ประวัติเวอร์ชัน: ต้อง login, เรียงใหม่→เก่า, ทุกเวอร์ชันมีรายละเอียด และเลขบนป้าย index.html ตรงกับรายการล่าสุด', async () => {
  assert.equal((await fetch(base + '/api/admin/changelog')).status, 401);
  const { cookie } = await login();
  const c = await (await fetch(base + '/api/admin/changelog', { headers: { cookie } })).json();
  assert.ok(c.versions.length >= 8);
  const nums = c.versions.map(v => v.version);
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a), 'ต้องเรียงเลขเวอร์ชันจากมากไปน้อย');
  assert.equal(new Set(nums).size, nums.length, 'เลขเวอร์ชันห้ามซ้ำ');
  for (const v of c.versions) { assert.ok(v.title && v.date && Array.isArray(v.items) && v.items.length, `เวอร์ชัน ${v.version} ต้องมี title/date/items`); assert.ok(!isNaN(new Date(v.date))); }
  const label = /✨ เวอร์ชัน (\d+) ·/.exec(fs.readFileSync(INDEX_HTML, 'utf8'));
  assert.ok(label, 'ไม่พบป้ายเวอร์ชันใน index.html');
  assert.equal(Number(label[1]), nums[0], 'ขึ้นเลขเวอร์ชันที่ป้ายแล้วต้องเพิ่มรายละเอียดใน server/changelog.json ด้วย');
});

test('นำเข้าปฏิทิน .ics (ตัวอ่านในหน้าแอดมิน): วันที่ล้วน/ช่วงวัน/เวลา UTC/พับบรรทัด/ข้ามรายการซ้ำ-ยกเลิก-ไม่ซ้ำปี/ล้างอักขระต้องห้าม', () => {
  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const a = html.indexOf('/*ICS-PARSER-START*/'), b = html.indexOf('/*ICS-PARSER-END*/');
  assert.ok(a > 0 && b > a, 'ไม่พบตัวอ่าน .ics ใน admin.html');
  const parseIcs = new Function(html.slice(a, b) + '; return parseIcs;')();
  const ev = (...l) => ['BEGIN:VEVENT', ...l, 'END:VEVENT'].join('\r\n');
  const cal = ['BEGIN:VCALENDAR',
    ev('DTSTART;VALUE=DATE:20270101', 'DTEND;VALUE=DATE:20270102', 'SUMMARY:วันขึ้นปีใหม่'),
    ev('DTSTART;VALUE=DATE:20270413', 'DTEND;VALUE=DATE:20270416', 'SUMMARY:สงกรานต์\, <b>ชื่อ</b>'),      // 3 วัน (DTEND ไม่รวมวันสุดท้าย) + อักขระต้องห้าม
    ev('DTSTART:20261231T170000Z', 'SUMMARY:ปีใหม่ (UTC)'),                                                  // 17:00Z = 1 ม.ค. เวลาไทย
    ev('DTSTART;VALUE=DATE:20270101', 'SUMMARY:วันขึ้นปีใหม่'),                                              // ซ้ำกับรายการแรก
    ev('DTSTART;VALUE=DATE:20270505', 'RRULE:FREQ=YEARLY', 'SUMMARY:ซ้ำรายปี'),
    ev('DTSTART;VALUE=DATE:20270506', 'STATUS:CANCELLED', 'SUMMARY:ยกเลิก'),
    ev('DTSTART;VALUE=DATE:20190101', 'SUMMARY:เก่าเกิน'),
    ev('DTSTART;VALUE=DATE:20270231', 'SUMMARY:วันที่ไม่มีจริง'),
    ev('DTSTART;VALUE=DATE:20270701', 'SUMMARY:ชื่อที่ถูกพับ', ' ต่อบรรทัด'),
    'END:VCALENDAR'].join('\r\n');
  const r = parseIcs(cal);
  const got = r.events.map(e => e.date + ' ' + e.name);
  assert.deepEqual(got, ['2027-01-01 ปีใหม่ (UTC)', '2027-01-01 วันขึ้นปีใหม่', '2027-04-13 สงกรานต์, b ชื่อ /b', '2027-04-14 สงกรานต์, b ชื่อ /b', '2027-04-15 สงกรานต์, b ชื่อ /b', '2027-07-01 ชื่อที่ถูกพับต่อบรรทัด']);
  assert.deepEqual(r.skipped, { recurring: 1, cancelled: 1, noDate: 1, outOfRange: 1, tooLong: 0 });
  assert.equal(parseIcs('hello').total, 0);
  // ทุกชื่อที่นำเข้าต้องผ่านกติกาของ server
  assert.doesNotThrow(() => L.validateHolidays(r.events));
});

test('ประวัติและคืนค่าจากไฟล์สำรอง: ต้อง login, ตรวจชื่อไฟล์, ตรวจข้อมูลด้วยกติกาเดิม, คงข้อมูลคลินิกเมื่อสำรองรุ่นเก่า, คืนค่าแล้วย้อนกลับได้', async () => {
  const bk = path.join(dataDir, 'backups');
  assert.equal((await fetch(base + '/api/admin/history')).status, 401);
  assert.equal((await fetch(base + '/api/admin/restore', { method: 'POST', headers: J, body: JSON.stringify({ file: 'x' }) })).status, 401);

  const { cookie } = await login(); const H = { ...J, cookie };
  const putHol = (name) => fetch(base + '/api/admin/holidays', { method: 'PUT', headers: H, body: JSON.stringify({ holidays: [{ date: '2026-12-03', name }] }) });
  await putHol('สถานะ-A');
  await putHol('สถานะ-B');       // ตอนบันทึก B → ระบบสำรองสถานะ A ไว้
  const hist = await (await fetch(base + '/api/admin/history', { headers: { cookie } })).json();
  assert.ok(hist.audit.length >= 2 && hist.audit[0].what.startsWith('save holidays'), 'audit ต้องเรียงใหม่→เก่า');
  assert.ok(hist.backups.length >= 2);
  assert.match(hist.backups[0].file, /^store-\d{14}-[0-9a-f]{4}\.json$/);
  assert.ok(hist.backups[0].summary && hist.backups[0].summary.vaccines >= 1, 'ต้องมีสรุปของแต่ละไฟล์สำรอง');

  // หาไฟล์สำรองที่เป็นสถานะ A (อ่านเนื้อไฟล์ ไม่พึ่งลำดับชื่อ เพราะเข็มเดียวกันวินาทีเดียวกันเรียงตามค่าสุ่ม)
  const fileA = fs.readdirSync(bk).find(f => JSON.parse(fs.readFileSync(path.join(bk, f), 'utf8')).holidays.some(h => h.name === 'สถานะ-A'));
  assert.ok(fileA, 'ต้องมีไฟล์สำรองของสถานะ A');
  const r = await fetch(base + '/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ file: fileA }) });
  assert.equal(r.status, 200);
  assert.match(await (await fetch(base + '/data/holidays.csv')).text(), /สถานะ-A/);
  assert.doesNotMatch(await (await fetch(base + '/data/holidays.csv')).text(), /สถานะ-B/);
  assert.match(fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8'), /restore backup store-/);
  // การคืนค่าเองก็ถูกสำรองไว้ → คืนกลับเป็น B ได้
  const fileB = fs.readdirSync(bk).find(f => JSON.parse(fs.readFileSync(path.join(bk, f), 'utf8')).holidays.some(h => h.name === 'สถานะ-B'));
  assert.ok(fileB, 'สถานะ B ต้องถูกสำรองก่อนคืนค่า');

  // ชื่อไฟล์ไม่ถูกต้อง / path traversal / ไม่พบ
  for (const bad of ['../store.json', '..\\store.json', 'store-1.json', 'admin.json', '', 'store-20260101000000-zzzz.json']) {
    assert.equal((await fetch(base + '/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ file: bad }) })).status, 400, bad);
  }
  assert.equal((await fetch(base + '/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ file: 'store-20200101000000-abcd.json' }) })).status, 404);

  // ไฟล์สำรองที่ข้อมูลไม่ผ่านกติกา ต้องไม่ถูกนำมาใช้ และไม่ทับของเดิม
  const badName = 'store-20200102000000-beef.json';
  fs.writeFileSync(path.join(bk, badName), JSON.stringify({ vaccines: [{ code: 'bad code!', name: 'x' }], holidays: [] }));
  assert.equal((await fetch(base + '/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ file: badName }) })).status, 400);
  assert.match(await (await fetch(base + '/data/holidays.csv')).text(), /สถานะ-A/, 'ข้อมูลเดิมต้องไม่ถูกทับ');

  // สำรองรุ่นเก่า (ไม่มี settings) → คืนค่าได้และข้อมูลคลินิกคงเดิม
  const cur = await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json();
  const oldName = 'store-20200103000000-cafe.json';
  fs.writeFileSync(path.join(bk, oldName), JSON.stringify({ vaccines: cur.vaccines, holidays: [{ date: '2026-12-04', name: 'จากสำรองรุ่นเก่า' }] }));
  assert.equal((await fetch(base + '/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ file: oldName }) })).status, 200);
  const after = await (await fetch(base + '/api/admin/store', { headers: { cookie } })).json();
  assert.deepEqual(after.settings, cur.settings, 'ข้อมูลคลินิกต้องคงเดิม');
  assert.equal(after.holidays[0].name, 'จากสำรองรุ่นเก่า');
});

test('กันแก้ทับกัน: บันทึกด้วยเลขรุ่นเก่า → 409 ไม่ทับงานคนอื่น · คนละส่วนไม่ชนกัน · ไม่ส่งเลขรุ่น (เครื่องมือ/รุ่นเก่า) ยังบันทึกได้', async () => {
  const { cookie } = await login(); const H = { ...J, cookie };
  const get = async () => (await fetch(base + '/api/admin/store', { headers: { cookie } })).json();
  const put = (p, body) => fetch(base + p, { method: 'PUT', headers: H, body: JSON.stringify(body) });

  const s0 = await get();
  assert.ok(s0.rev && Number.isInteger(s0.rev.vaccines) && Number.isInteger(s0.rev.holidays) && Number.isInteger(s0.rev.settings), 'ต้องมีเลขรุ่นของทุกส่วน');
  // A และ B โหลดหน้าพร้อมกันที่เลขรุ่นเดียวกัน
  const vA = JSON.parse(JSON.stringify(s0.vaccines)); vA[0].special = 'แก้โดย A';
  const vB = JSON.parse(JSON.stringify(s0.vaccines)); vB[1].special = 'แก้โดย B';
  const rA = await put('/api/admin/vaccines', { vaccines: vA, baseRev: s0.rev.vaccines });
  assert.equal(rA.status, 200);
  const jA = await rA.json();
  assert.equal(jA.rev.vaccines, s0.rev.vaccines + 1, 'บันทึกสำเร็จต้องเพิ่มเลขรุ่น');
  const rB = await put('/api/admin/vaccines', { vaccines: vB, baseRev: s0.rev.vaccines });   // B ยังถือเลขรุ่นเก่า
  assert.equal(rB.status, 409);
  const jB = await rB.json();
  assert.match(jB.error, /ผู้อื่นบันทึก/);
  assert.equal(jB.rev.vaccines, s0.rev.vaccines + 1);
  const mid = await get();
  assert.equal(mid.vaccines[0].special, 'แก้โดย A', 'งานของ A ต้องไม่ถูกทับ');
  assert.notEqual(mid.vaccines[1].special, 'แก้โดย B', 'งานของ B ที่ถูกปฏิเสธต้องไม่เข้า');
  assert.equal(mid.rev.vaccines, s0.rev.vaccines + 1, 'คำขอที่ถูกปฏิเสธต้องไม่เพิ่มเลขรุ่น');

  // B โหลดใหม่แล้วบันทึกซ้ำได้
  vB[0].special = 'แก้โดย A'; // เนื้อหาใหม่ = ข้อมูลล่าสุด + การแก้ของ B
  assert.equal((await put('/api/admin/vaccines', { vaccines: vB, baseRev: mid.rev.vaccines })).status, 200);

  // คนละส่วนไม่ชนกัน: เลขรุ่นของวันหยุดไม่ขยับจากการบันทึกวัคซีน
  const s1 = await get();
  assert.equal(s1.rev.holidays, s0.rev.holidays, 'เลขรุ่นวันหยุดต้องไม่เปลี่ยนเพราะแก้ตารางวัคซีน');
  assert.equal((await put('/api/admin/holidays', { holidays: [{ date: '2026-12-05', name: 'คนละส่วน' }], baseRev: s1.rev.holidays })).status, 200);
  assert.equal((await put('/api/admin/settings', { settings: s1.settings, baseRev: s1.rev.settings })).status, 200);

  // ชนิดข้อมูลของ baseRev ไม่ตรง (สตริง/ลบ/ใหญ่เกิน) ถือว่าไม่ตรงรุ่น → 409 ไม่ใช่ล้ม
  for (const bad of ['0', -1, 1e9, {}, [], true]) {
    assert.equal((await put('/api/admin/holidays', { holidays: [], baseRev: bad })).status, 409, JSON.stringify(bad));
  }
  // ไม่ส่ง baseRev = พฤติกรรมเดิม (ยังบันทึกได้)
  assert.equal((await put('/api/admin/holidays', { holidays: [{ date: '2026-12-06', name: 'ไม่ส่งรุ่น' }] })).status, 200);

  // นำเข้า CSV และคืนค่า เพิ่มเลขรุ่น → คนที่เปิดหน้าค้างไว้บันทึกทับไม่ได้
  const s2 = await get();
  const imp = await fetch(base + '/api/admin/import', { method: 'POST', headers: H, body: JSON.stringify({ holidaysCsv: 'Date,Name\n2026-01-03,นำเข้ารุ่น\n' }) });
  assert.equal(imp.status, 200);
  assert.equal((await imp.json()).rev.holidays, s2.rev.holidays + 1);
  assert.equal((await put('/api/admin/holidays', { holidays: [], baseRev: s2.rev.holidays })).status, 409, 'หน้าค้างก่อนนำเข้า ต้องบันทึกทับไม่ได้');
});

test('restore: ไฟล์สำรองที่เนื้อเป็น null/array/ตัวเลข ต้องตอบ 400 ไม่ใช่ 500', async () => {
  const { cookie } = await login(); const H = { ...J, cookie };
  const bk = path.join(dataDir, 'backups');
  for (const [i, content] of ['null', '[]', '5', '"text"', 'true', '{{ broken'].entries()) {
    const name = `store-2018010${i + 1}000000-d00${i}.json`;
    fs.writeFileSync(path.join(bk, name), content);
    const r = await fetch(base + '/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ file: name }) });
    assert.equal(r.status, 400, content);
  }
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

test('อัปเกรดจากข้อมูลบนเซิร์ฟเวอร์รุ่นก่อน (store.json ไม่มี rev/updatedBy/settings): ใช้งานเต็มรูปแบบ ไม่เสียข้อมูลเดิม', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-upg-'));
  const prev = { version: 1, updatedAt: '2026-11-03T00:00:00.000Z',
    vaccines: [{ code: '2m', name: '2 เดือน', vaccines: [{ name: 'DTP', thai: 'ดีทีพี', type: 'injection' }, { name: 'PCV', thai: 'นิวโมค็อกคัส', type: 'injection' }], schedule: '', weeks: [1, 3], time: '8:00-11:30น.', nextAge: '', special: 'ข้อมูลเดิมบนเซิร์ฟเวอร์' }],
    holidays: [{ date: '2026-07-20', name: 'ทดสอบเดิม' }], settings: { hospitalName: 'รพ.เดิม', appTitle: 'ชื่อเดิม', clinicShort: 'OLD' } };  // รูปแบบของ v52: มี settings แต่ไม่มี rev/updatedBy
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(prev));
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000), b = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, WEB_DIR: webDir };
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, 'set-password.js'), '--stdin'], { input: TEST_PW + '\n', env }).status, 0);
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  try {
    let up = false; for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(b + '/healthz')).ok; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(up, 'server ไม่ขึ้น');
    const lg = await fetch(b + '/api/login', { method: 'POST', headers: J, body: JSON.stringify({ password: TEST_PW }) });
    const cookie = (lg.headers.get('set-cookie') || '').split(';')[0]; const H = { ...J, cookie };
    const st = await (await fetch(b + '/api/admin/store', { headers: { cookie } })).json();
    assert.deepEqual(st.rev, { vaccines: 0, holidays: 0, settings: 0 }, 'ต้องเติมเลขรุ่นเริ่มต้น');
    assert.equal(st.settings.clinicShort, 'OLD', 'ข้อมูลคลินิกเดิมต้องไม่ถูกทับด้วยค่าตั้งต้น');
    assert.equal(st.vaccines[0].special, 'ข้อมูลเดิมบนเซิร์ฟเวอร์');
    assert.match(await (await fetch(b + '/data/vaccines.csv')).text(), /PCV\/นิวโมค็อกคัส/);
    // บันทึกทุกส่วนด้วยเลขรุ่นเริ่มต้นได้ แล้วเลขรุ่นเพิ่ม
    const v = st.vaccines; v[0].special = 'แก้หลังอัปเกรด';
    let r = await fetch(b + '/api/admin/vaccines', { method: 'PUT', headers: H, body: JSON.stringify({ vaccines: v, baseRev: 0 }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).rev.vaccines, 1);
    r = await fetch(b + '/api/admin/holidays', { method: 'PUT', headers: H, body: JSON.stringify({ holidays: st.holidays, baseRev: 0 }) }); assert.equal(r.status, 200);
    r = await fetch(b + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ settings: st.settings, baseRev: 0 }) }); assert.equal(r.status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
    assert.deepEqual(after.rev, { vaccines: 1, holidays: 1, settings: 1 });
    assert.equal(after.updatedBy, 'admin');
    // ไฟล์สำรองถูกสร้างจากข้อมูลรุ่นเดิม และคืนค่าได้ (รวมสำรองที่ไม่มี rev)
    const hist = await (await fetch(b + '/api/admin/history', { headers: { cookie } })).json();
    assert.ok(hist.backups.length >= 3);
    const oldest = fs.readdirSync(path.join(dir, 'backups')).find(f => JSON.parse(fs.readFileSync(path.join(dir, 'backups', f), 'utf8')).vaccines[0].special === 'ข้อมูลเดิมบนเซิร์ฟเวอร์');
    assert.ok(oldest, 'ต้องมีไฟล์สำรองของข้อมูลเดิม');
    r = await fetch(b + '/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ file: oldest }) });
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(b + '/api/admin/store', { headers: { cookie } })).json()).vaccines[0].special, 'ข้อมูลเดิมบนเซิร์ฟเวอร์');
  } finally { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('คำขอที่ใหญ่เกิน 1 MB → ตอบ 400 พร้อมข้อความ (ไม่ตัดการเชื่อมต่อ) และ JSON เสียก็ตอบ 400', async () => {
  const { cookie } = await login(); const H = { ...J, cookie };
  const big = await fetch(base + '/api/admin/holidays', { method: 'PUT', headers: H, body: JSON.stringify({ holidays: [], pad: 'x'.repeat(3 * 1024 * 1024) }) });
  assert.equal(big.status, 400); assert.match((await big.json()).error, /ใหญ่เกิน/);
  const bad = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: '{bad' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(base + '/healthz')).status, 200, 'server ต้องยังอยู่');
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
