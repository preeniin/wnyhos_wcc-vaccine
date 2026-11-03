'use strict';
// รัน:  node --test tests/pcv.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PCV = require('../pcv-rules');

const ROOT = path.join(__dirname, '..');

// ---------- สภาพแวดล้อมจริงจาก index.html (วันหยุด + สัปดาห์ของคลินิก) ----------
function loadEnv() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const grab = (re, n) => { const m = html.match(re); assert.ok(m, 'ไม่พบ ' + n + ' ใน index.html'); return m[0]; };
  const code = [
    'let dynamicHolidays = {}; let dynamicHolidayYears = new Set(); let vaccineSchedules = {};',
    grab(/function parseCsvRow\(row\) \{[\s\S]*?\n        \}\n/, 'parseCsvRow'),
    grab(/function applyVaccinesCsv\(data\) \{[\s\S]*?\n        \}\n/, 'applyVaccinesCsv'),
    grab(/function applyHolidaysCsv\(data\) \{[\s\S]*?\n        \}\n/, 'applyHolidaysCsv'),
    grab(/const fixedHolidays = \{.*\};\n/, 'fixedHolidays'),
    grab(/const buddhistHolidayOffsets = \{[\s\S]*?\n        \};\n/, 'buddhistHolidayOffsets'),
    grab(/function getHolidayForDate\(date\) \{[\s\S]*?\n        \}\n/, 'getHolidayForDate'),
    grab(/function findNextApptDate\(start, weeks\) \{[\s\S]*?\n        \}\n/, 'findNextApptDate'),
  ].join('\n');
  const ctx = { Date, Math, Set, parseInt, isNaN, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  ctx.applyHolidaysCsv(fs.readFileSync(path.join(ROOT, 'data/holidays.csv'), 'utf8'));
  ctx.applyVaccinesCsv(fs.readFileSync(path.join(ROOT, 'data/vaccines.csv'), 'utf8'));
  const sched = vm.runInContext('vaccineSchedules', ctx);
  return {
    findDate: ctx.findNextApptDate,
    isHoliday: d => ctx.getHolidayForDate(d),
    weeksFor: code => sched[code].weeks,
    pcvWeeks: [1, 2, 3, 4, 5], // ช่วงแรก PCV เดี่ยวเปิดทุกวันพุธ
  };
}
const env = loadEnv();

const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const weekOfMonth = d => Math.ceil(d.getDate() / 7);
const D = (y, m, d) => new Date(y, m - 1, d);

// ---------- 1) ตัวอย่างที่คุยกันกับผู้ใช้ (วันที่มารับบริการ พุธ 11/11/2026) ----------
test('ตัวอย่างที่ตกลงกัน: เริ่ม 7, 8, 9, 10, 11 เดือน (มารับบริการ 11 พ.ย. 2026)', () => {
  const visit = D(2026, 11, 11);
  const expected = {
    7:  ['2026-11-11', '2027-01-13', '2027-04-28'],
    8:  ['2026-11-11', '2026-12-23', '2027-03-24'],
    9:  ['2026-11-11', '2026-12-16', '2027-02-24'],
    10: ['2026-11-11', '2027-01-13', '2027-04-21'],
    11: ['2026-11-11', '2026-12-23', '2027-06-16'],
  };
  for (const [S, want] of Object.entries(expected)) {
    const r = PCV.plan({ birth: addMonths(visit, -S), visit, env });
    assert.ok(r.ok, 'S=' + S);
    assert.deepEqual(r.doses.map(d => iso(d.date)), want, 'เริ่ม ' + S + ' เดือน');
  }
});

test('เข็มที่ "ไม่ใช่ทันที" ตรงกับ CPG ทั้ง 6 แถว (2,4,6,9,12,18 เดือน) และที่เหลือเป็น "ทันที"', () => {
  const withRows = [];
  for (let m = 2; m <= 23; m++) if (PCV.RULES[m].d1.how === 'with') withRows.push(m);
  assert.deepEqual(withRows, [2, 4, 6, 9, 12, 18]);
  const visit = D(2026, 11, 11);
  const map = { 2: '2m', 4: '4m', 6: '6m', 9: '9m', 12: '1y', 18: '18m' };
  for (const m of withRows) assert.equal(PCV.RULES[m].d1.visit, map[m]);
});

test('จำนวนเข็ม: เริ่มก่อน 12 เดือน = 3 เข็ม, เริ่ม 12–23 เดือน = 2 เข็ม (ไม่มี booster)', () => {
  const visit = D(2026, 11, 11);
  for (let m = 2; m <= 23; m++) {
    const r = PCV.plan({ birth: addMonths(visit, -m), visit, env });
    assert.equal(r.doses.length, m < 12 ? 3 : 2, 'เริ่ม ' + m + ' เดือน');
  }
});

// ---------- 2) คุณสมบัติที่ต้องเป็นจริงเสมอ (ทุกแถว × หลายวัน × หลายวันเกิด) ----------
test('ทุกแถว 2–23 เดือน: วันนัดเป็นวันพุธที่เปิด ไม่ใช่วันหยุด เรียงลำดับ ห่างขั้นต่ำตามหมายเหตุ CPG', () => {
  let n = 0;
  for (let S = 2; S <= 23; S++) {
    for (let v = 0; v < 21; v++) {
      for (let extra = 0; extra < 30; extra += 3) {
        const visit = addDays(D(2026, 11, 4), v);
        const birth = addDays(addMonths(visit, -S), -extra);
        const r = PCV.plan({ birth, visit, env });
        if (!r.ok) { assert.fail(`S=${S} extra=${extra} visit=${iso(visit)}: ${r.message}`); }
        n++;
        const tag = `เริ่ม ${r.startMonths} ด. เกิด ${iso(birth)} มา ${iso(visit)}`;
        const rule = PCV.RULES[r.startMonths];
        let prev = null;
        for (const d of r.doses) {
          assert.ok(d.date, tag + ' เข็ม ' + d.n + ' ไม่มีวัน');
          if (prev) assert.ok(d.date > prev, tag + ' ลำดับเข็มผิด');
          prev = d.date;
          if (d.n === 1) { assert.equal(iso(d.date), iso(visit)); continue; }
          assert.equal(d.date.getDay(), 3, tag + ' เข็ม ' + d.n + ' ไม่ใช่วันพุธ');
          assert.equal(env.isHoliday(d.date), null, tag + ' ตรงวันหยุด ' + iso(d.date));
          if (d.withVisit) {
            assert.ok(env.weeksFor(d.withVisit).includes(weekOfMonth(d.date)), tag + ' เข็ม ' + d.n + ' ไม่ตรงสัปดาห์ของรอบ ' + d.withVisit);
            assert.ok(d.date >= addMonths(birth, PCV.VISIT_AGE[d.withVisit]), tag + ' เด็กยังไม่ถึงอายุของรอบ ' + d.withVisit);
          }
        }
        // ระยะห่างเข็ม 1→2: 4 สัปดาห์ (เริ่ม <12 ด.) / 8 สัปดาห์ (เริ่ม 12–23 ด.)
        const gap = Math.round((r.doses[1].date - r.doses[0].date) / 86400000);
        assert.ok(gap >= (r.startMonths < 12 ? 28 : 56), `${tag} ห่างเข็ม1→2 แค่ ${gap} วัน`);
        // เข็มที่ให้ "เดี่ยว" ตามอายุ ต้องไม่ก่อนอายุเป้าหมาย
        for (const [key, idx] of [['d2', 1], ['d3', 2]]) {
          const spec = rule[key]; if (!spec || spec.how !== 'age') continue;
          assert.ok(r.doses[idx].date >= addMonths(birth, spec.months), tag + ' ก่อนอายุ ' + spec.months + ' ด.');
        }
      }
    }
  }
  assert.ok(n > 1000, 'ควรทดสอบหลายกรณี: ' + n);
});

test('PCV เดี่ยวเปิดทุกวันพุธ: เข็มเดี่ยวมีโอกาสตกสัปดาห์ที่วัคซีนอื่นปิด (เช่น เริ่ม 9 เดือน เข็ม 2 พุธ 16/12/2026 = สัปดาห์ 3)', () => {
  const visit = D(2026, 11, 11);
  const r = PCV.plan({ birth: addMonths(visit, -9), visit, env });
  assert.equal(iso(r.doses[1].date), '2026-12-16');
  assert.equal(weekOfMonth(r.doses[1].date), 3);
  assert.ok(!env.weeksFor('9m').includes(3), 'ชุด 9 เดือนปิดสัปดาห์ 3 แต่ PCV เดี่ยวเปิดได้');
});

test('เริ่ม 10 เดือน: booster คงที่ 15 เดือน (CPG) เป็น PCV เดี่ยว วันพุธใดก็ได้ ช่วงเช้า; เข็มที่ไปพร้อมรอบอื่นไม่ระบุช่วง', () => {
  const visit = D(2026, 11, 11);
  const birth = addMonths(visit, -10);
  const r = PCV.plan({ birth, visit, env });
  const d3 = r.doses[2];
  assert.equal(iso(d3.date), '2027-04-21');
  assert.equal(d3.session, 'เช้า');
  assert.equal(d3.withVisit, null);
  assert.equal(r.doses[1].session, null);   // เข็ม 2 พร้อม LAJE1
});

// ---------- 2.5) booster ห่างเข็ม 2 ≥ 8 สัปดาห์ เฉพาะผู้เริ่ม 7–11 เดือน (หมายเหตุ WHO ใน CPG) ----------
test('ตัวอย่างที่ตรวจกับผู้ใช้: เริ่ม 9 เดือน มาช้า → booster เลื่อนให้ห่างเข็ม 2 ครบ 8 สัปดาห์', () => {
  const birth = D(2026, 1, 13);
  const r = PCV.plan({ birth, visit: D(2026, 11, 4), env });       // อายุ 9 ด. 22 ว.
  assert.equal(r.startMonths, 9);
  assert.deepEqual(r.doses.map(d => iso(d.date)), ['2026-11-04', '2026-12-02', '2027-01-27']);
  assert.ok(r.doses[2].notes.some(t => t.includes('8 สัปดาห์')));
  // สุดขอบ: มาวันพฤหัส 12/11/2026 (9 ด. 30 ว.)
  const e = PCV.plan({ birth, visit: D(2026, 11, 12), env });
  assert.deepEqual(e.doses.map(d => iso(d.date)), ['2026-11-12', '2026-12-16', '2027-02-10']);
  assert.equal(e.doses[2].warnings.length, 0, 'อายุ 12 ด. 28 ว. ยังอยู่ในช่วง 12–15 เดือน');
  // มาตรงเวลา ไม่ต้องปรับ
  const ok = PCV.plan({ birth, visit: D(2026, 10, 13), env });
  assert.equal(iso(ok.doses[2].date), '2027-01-13');
  assert.equal(ok.doses[2].notes.length, 0);
});

test('ทุกแถวที่มี booster (2–11 เดือน): ห่างเข็ม 2 ≥ 56 วัน; กรณีมาตามกำหนดไม่มีการปรับ/คำเตือน', () => {
  let checked = 0;
  for (let S = 2; S <= 11; S++) {
    for (let v = 0; v < 120; v++) {
      for (let extra = 0; extra < 30; extra++) {
        const visit = addDays(D(2026, 11, 4), v);
        const birth = addDays(addMonths(visit, -S), -extra);
        const r = PCV.plan({ birth, visit, env });
        if (!r.ok || r.doses.length < 3) continue;
        const gap = Math.round((r.doses[2].date - r.doses[1].date) / 86400000);
        const rule = PCV.RULES[r.startMonths];
        assert.ok(gap >= 56, `เริ่ม ${r.startMonths} ด. เกิด ${iso(birth)} มา ${iso(visit)}: ห่าง ${gap} วัน`);
        assert.equal(r.doses[2].warnings.length, 0, `เริ่ม ${r.startMonths} ด. เกิด ${iso(birth)} มา ${iso(visit)}: ${r.doses[2].warnings}`);
        if (r.startMonths <= 6) assert.equal(r.doses[2].notes.length, 0, 'เริ่ม 2–6 เดือน มาตามกำหนด ต้องไม่ต้องปรับวัน');
        checked++;
        assert.equal(rule.d3MinGapDays, 56);
      }
    }
  }
  assert.ok(checked > 5000, 'ควรทดสอบหลายกรณี: ' + checked);
});

test('booster เลยช่วงอายุที่ CPG ให้ → เตือน (เด็กมีประวัติ มาช้ามาก)', () => {
  // เริ่ม 8 เดือน ได้เข็ม 1 แล้ว แต่เข็ม 2 ฉีดตอน 14 เดือน → booster ต้องห่าง 8 สัปดาห์ = เกิน 15 เดือน
  const birth = D(2025, 1, 10);
  const r = PCV.plan({
    birth, visit: addMonths(birth, 16),
    history: { dose1: addMonths(birth, 8), dose2: addMonths(birth, 14) }, env,
  });
  assert.ok(r.ok);
  assert.ok(r.doses[2].warnings.some(w => w.includes('15 เดือน')), JSON.stringify(r.doses[2]));
});

test('หมายเหตุ "ใช้ระยะห่างที่ลดลง": ขึ้นเมื่อเริ่มก่อน 12 เดือนและห่างเข็ม 1 < 8 สัปดาห์ เท่านั้น', () => {
  const seen = { yes: 0, no: 0 };
  for (let S = 2; S <= 23; S++) {
    for (let v = 0; v < 60; v++) {
      for (let extra = 0; extra < 30; extra += 2) {
        const visit = addDays(D(2026, 11, 4), v);
        const birth = addDays(addMonths(visit, -S), -extra);
        const r = PCV.plan({ birth, visit, env });
        if (!r.ok) continue;
        const gap = Math.round((r.doses[1].date - r.doses[0].date) / 86400000);
        const has = r.doses[1].notes.some(t => t.includes('ลดลง'));
        assert.equal(has, r.startMonths < 12 && gap < 56, `เริ่ม ${r.startMonths} ด. ห่าง ${gap} วัน note=${has}`);
        seen[has ? 'yes' : 'no']++;
      }
    }
  }
  assert.ok(seen.yes > 100 && seen.no > 100, JSON.stringify(seen));
  // แถว 3 และ 5 เดือน ต้องมีหมายเหตุทุกกรณี, แถว 6 เดือนไม่มีเลย
  for (const S of [3, 5]) {
    const visit = D(2026, 11, 11);
    assert.ok(PCV.plan({ birth: addMonths(visit, -S), visit, env }).doses[1].notes.some(t => t.includes('ลดลง')), 'S=' + S);
  }
  const v6 = D(2026, 11, 11);
  assert.ok(!PCV.plan({ birth: addMonths(v6, -6), visit: v6, env }).doses[1].notes.some(t => t.includes('ลดลง')));
});

// ---------- 3) กรณีขอบ ----------
test('เริ่ม 3 เดือน: เข็ม 2 พร้อมรอบ 4 เดือน และถ้าห่างเข็ม 1 ไม่ถึง 4 สัปดาห์ ต้องไปรอบ 6 เดือน (ทางสำรองของ CPG)', () => {
  // เด็กอายุ 3 เดือน 28 วัน: รอบ 4 เดือนถัดไปไม่ถึง 4 สัปดาห์ แต่ยังอยู่ช่วงรอบ 4 เดือน (4–<6) ได้ถ้าเลื่อนไปวันที่เปิดถัดไป
  const visit = D(2026, 11, 11);
  const birth = addDays(addMonths(visit, -3), -28);
  const r = PCV.plan({ birth, visit, env });
  assert.ok(r.ok);
  const d2 = r.doses[1];
  assert.ok((d2.date - visit) / 86400000 >= 28);
  assert.ok(['4m', '6m'].includes(d2.withVisit));
  // ตัวอย่างบังคับให้เกินช่วงรอบ 4 เดือน → ต้องตกไปรอบ 6 เดือน
  const strict = PCV.plan({
    birth, visit,
    env: { ...env, weeksFor: c => (c === '4m' ? [] : env.weeksFor(c)), findDate: (s, w) => (w.length ? env.findDate(s, w) : null) },
  });
  assert.equal(strict.doses[1].withVisit, '6m');
  assert.equal(strict.doses[1].fellBack, true);
});

test('เริ่ม 5 เดือนปลาย: เข็ม 2 พร้อมรอบ 6 เดือน ปรับให้ห่างอย่างน้อย 4 สัปดาห์ (มีหมายเหตุ)', () => {
  const visit = D(2026, 11, 11);
  const birth = addDays(addMonths(visit, -5), -28); // 5 เดือน 28 วัน → ครบ 6 เดือนในอีก 2–3 วัน
  const r = PCV.plan({ birth, visit, env });
  const d2 = r.doses[1];
  assert.equal(d2.withVisit, '6m');
  assert.ok((d2.date - visit) / 86400000 >= 28);
  assert.ok(d2.notes.some(t => t.includes('ห่างจากเข็ม 1')), 'ควรบอกว่าปรับวัน');
});

test('เกินอายุที่ CPG แนะนำ: เริ่ม 17–18 เดือนต้องไม่เกิน 2 ปี, เริ่ม 12–14 ต้องไม่เกิน 18 เดือน (ขึ้นคำเตือน ไม่เงียบ)', () => {
  const visit = D(2026, 11, 11);
  // เริ่ม 14 เดือนเต็ม → เข็ม 2 ห่าง 8 สัปดาห์ ≈ 16 เดือน ไม่เกิน 18 → ไม่เตือน
  const ok14 = PCV.plan({ birth: addMonths(visit, -14), visit, env });
  assert.equal(ok14.doses[1].warnings.length, 0);
  // เริ่ม 14 เดือน 29 วัน → เข็ม 2 ≈ 16 เดือน 26 วัน ยังไม่เกิน 18 → ไม่เตือน
  const edge = PCV.plan({ birth: addDays(addMonths(visit, -14), -29), visit, env });
  assert.equal(edge.doses[1].warnings.length, 0);

  // ขอบเพดาน: อายุ 18 เดือน 29 วัน ยังไม่เตือน, อายุ 19 เดือนเต็ม เตือน (นับเดือนเต็มเหมือนกลุ่มอายุของแอป)
  const b3 = D(2025, 4, 2);
  const h = { dose1: D(2026, 5, 6) };
  const at18m29 = PCV.plan({ birth: b3, visit: addDays(addMonths(b3, 18), 29), history: h, env });
  assert.equal(at18m29.doses[1].state, 'due');
  assert.equal(at18m29.doses[1].warnings.length, 0, '18 เดือน 29 วัน ต้องไม่เตือน');
  const at19m = PCV.plan({ birth: b3, visit: addMonths(b3, 19), history: h, env });
  assert.ok(at19m.doses[1].warnings.some(w => w.includes('18 เดือน')), '19 เดือน ต้องเตือน');

  // มีประวัติ: ได้เข็ม 1 ตอน 13 เดือน แล้วกลับมาเมื่ออายุ 19 เดือน → เข็ม 2 ถึงกำหนดวันนี้ แต่เกิน 18 เดือน ต้องเตือน
  const birth = D(2025, 4, 2);
  const late = PCV.plan({ birth, visit: D(2026, 11, 4), history: { dose1: D(2026, 5, 6) }, env });
  assert.ok(late.ok); assert.equal(late.startMonths, 13);
  assert.equal(late.doses[1].state, 'due');
  assert.ok(late.doses[1].warnings.some(w => w.includes('18 เดือน')), 'ต้องเตือนเกิน 18 เดือน');

  // เริ่ม 18 เดือน กลับมาตอนเกิน 2 ปี → เตือนเกิน 24 เดือน
  const b2 = D(2024, 10, 1);
  const late2 = PCV.plan({ birth: b2, visit: D(2026, 11, 4), history: { dose1: D(2026, 4, 8) }, env });
  assert.equal(late2.startMonths, 18);
  assert.ok(late2.doses[1].warnings.some(w => w.includes('24 เดือน')), 'ต้องเตือนเกิน 24 เดือน');
});

test('มีประวัติ: เด็กได้เข็ม 1 ตอน 7 เดือน มาอายุ 9 เดือน → เข็ม 2 "ถึงกำหนดวันนี้" แล้วนัด booster', () => {
  const birth = D(2026, 1, 14);
  const visit = D(2026, 10, 14);                       // 9 เดือนพอดี, พุธสัปดาห์ 2 = วันเปิด MMR1
  const dose1 = D(2026, 8, 19);                        // 7 เดือน (ห่าง 8 สัปดาห์)
  const r = PCV.plan({ birth, visit, history: { dose1 }, env });
  assert.ok(r.ok);
  assert.equal(r.startMonths, 7);
  assert.equal(r.doses[0].state, 'given');
  assert.equal(r.doses[1].state, 'due');
  assert.equal(iso(r.doses[1].date), iso(visit));
  assert.equal(r.doses[2].state, 'planned');
  assert.equal(r.doses[2].withVisit, '1y');
});

test('มีประวัติ: ได้เข็ม 1 เมื่อวาน แต่ตามตารางเข็ม 2 ควรเป็นวันนี้ → ไม่ให้ฉีดเพราะห่างไม่ถึง 4 สัปดาห์ (เลื่อนไปวันถัดไป)', () => {
  const birth = D(2026, 1, 15);
  const visit = D(2026, 10, 14);
  const r = PCV.plan({ birth, visit, history: { dose1: addDays(visit, -1) }, env });
  assert.equal(r.startMonths, 8);
  assert.equal(r.doses[1].state, 'planned');
  assert.ok((r.doses[1].date - visit) / 86400000 >= 27);
});

test('มีประวัติเข็ม 1+2 → เหลือ booster อย่างเดียว', () => {
  const birth = D(2026, 1, 15);
  const visit = D(2026, 10, 14);
  const r = PCV.plan({ birth, visit, history: { dose1: D(2026, 7, 15), dose2: D(2026, 9, 16) }, env });
  assert.ok(r.ok);
  assert.deepEqual(r.doses.map(d => d.state), ['given', 'given', 'planned']);
  assert.equal(r.doses[2].withVisit, '1y');
});

test('ขอบอายุ: ต่ำกว่า 2 เดือน และตั้งแต่ 24 เดือน ไม่คำนวณ พร้อมข้อความ', () => {
  const visit = D(2026, 11, 11);
  const young = PCV.plan({ birth: addDays(visit, -40), visit, env });
  assert.equal(young.ok, false); assert.equal(young.code, 'too-young');
  const old = PCV.plan({ birth: addMonths(visit, -24), visit, env });
  assert.equal(old.ok, false); assert.equal(old.code, 'too-old');
  const edge = PCV.plan({ birth: addDays(addMonths(visit, -23), -29), visit, env });
  assert.equal(edge.ok, true, '23 เดือน 29 วัน ยังอยู่ในแถว 19–23');
});

test('ข้อมูลผิดปกติ: วันเกิดหลังวันมารับบริการ / ประวัติไม่สมเหตุสมผล ถูกปฏิเสธ', () => {
  const visit = D(2026, 11, 11);
  assert.equal(PCV.plan({ birth: addDays(visit, 1), visit, env }).ok, false);
  const birth = addMonths(visit, -8);
  assert.equal(PCV.plan({ birth, visit, history: { dose2: addDays(visit, -10) }, env }).code, 'bad-history');
  assert.equal(PCV.plan({ birth, visit, history: { dose1: addDays(visit, -10), dose2: addDays(visit, -20) }, env }).code, 'bad-history');
  assert.equal(PCV.plan({ birth, visit, history: { dose1: addDays(birth, -1) }, env }).code, 'bad-history');
});

// ---------- ประวัติแบบไม่ต้องมีวันที่: จำนวนเข็ม + อายุตอนฉีดเข็มแรก (วันที่จริงเป็นช่องเสริม) ----------
test('ประวัติแบบจำนวนเข็ม + อายุตอนเริ่ม (ไม่มีวันที่): เลือกกฎจากอายุตอนเริ่ม และแจ้งว่าไม่ได้ตรวจระยะห่าง', () => {
  const birth = D(2026, 2, 4), visit = D(2026, 11, 4);          // อายุ 9 เดือน
  // ฉีดมา 1 เข็ม เริ่ม 2 เดือน → เข็ม 2 เลยรอบ 4 เดือนแล้ว = ถึงกำหนดวันนี้ (ไม่ติดป้ายรอบ ไม่ติดช่วงเช้า)
  const r1 = PCV.plan({ birth, visit, history: { count: 1, startAge: 2 }, env });
  assert.ok(r1.ok); assert.equal(r1.startMonths, 2);
  assert.equal(r1.doses[0].state, 'given'); assert.equal(r1.doses[0].date, null);
  assert.equal(r1.doses[1].state, 'due');
  assert.equal(iso(r1.doses[1].date), iso(visit));
  assert.equal(r1.doses[1].withVisit, null); assert.equal(r1.doses[1].label, null); assert.equal(r1.doses[1].session, null);
  assert.equal(r1.doses[2].withVisit, '1y');
  assert.equal(r1.unverifiedGap, true);
  assert.ok(r1.doses[1].notes.some(t => t.includes('ไม่ได้ตรวจระยะห่างจากเข็มก่อน')));
  // ฉีดมา 2 เข็ม เริ่ม 2 เดือน → เหลือ booster พร้อม JE ตอน 12 เดือน (10 ก.พ. 2570)
  const r2 = PCV.plan({ birth, visit, history: { count: 2, startAge: 2 }, env });
  assert.deepEqual(r2.doses.map(d => d.state), ['given', 'given', 'planned']);
  assert.equal(iso(r2.doses[2].date), '2027-02-10');
  assert.equal(r2.doses[2].withVisit, '1y');
  assert.equal(r2.unverifiedGap, true);
  assert.ok(r2.doses[2].notes.some(t => t.includes('ไม่ได้ตรวจระยะห่างจากเข็มก่อน')));
});

test('เริ่ม 2 เดือน แต่เข็ม 2 ฉีดช้าตอน 11 เดือน → booster เลื่อนให้ห่างเข็ม 2 ครบ 8 สัปดาห์ (เดิมห่างแค่ 6)', () => {
  const birth = D(2026, 1, 4), visit = D(2026, 12, 2);          // 11 เดือน
  const r = PCV.plan({ birth, visit, history: { count: 1, startAge: 2 }, env });
  assert.equal(r.doses[1].state, 'due');
  const gap = Math.round((r.doses[2].date - r.doses[1].date) / 86400000);
  assert.ok(gap >= 56, 'ห่าง ' + gap + ' วัน');
  assert.equal(iso(r.doses[2].date), '2027-01-27');             // พุธสัปดาห์ 4 (13 ม.ค. ห่าง 42 วัน ไม่พอ)
  assert.ok(r.doses[2].notes.some(t => t.includes('8 สัปดาห์')));
  assert.ok(!r.doses[2].notes.some(t => t.includes('7–11')), 'กลุ่มเริ่ม 2–6 เดือนไม่อ้างหมายเหตุ 7–11 เดือน');
});

test('ประวัติแบบไม่มีวันที่: วันนัดในอนาคตตรงกับแบบมีวันที่ที่ห่างครบ; มีวันที่ครบ → ไม่ขึ้นข้อความ "ไม่ได้ตรวจ"', () => {
  const birth = D(2026, 8, 4), visit = D(2026, 11, 4);          // อายุ 3 เดือน
  const noDate = PCV.plan({ birth, visit, history: { count: 1, startAge: 2 }, env });
  const withDate = PCV.plan({ birth, visit, history: { count: 1, dose1: D(2026, 10, 7) }, env });
  assert.equal(noDate.startMonths, 2); assert.equal(withDate.startMonths, 2);
  assert.equal(iso(noDate.doses[1].date), iso(withDate.doses[1].date));
  assert.equal(noDate.unverifiedGap, true);
  assert.equal(withDate.unverifiedGap, false);
  assert.ok(!withDate.doses[1].notes.some(t => t.includes('ไม่ได้ตรวจ')));
});

test('ครบแล้ว: เริ่มตั้งแต่ 12 เดือนครบ 2 เข็ม / เจ้าหน้าที่เลือก "ครบแล้ว" → ไม่นัด ไม่ตรวจอายุ', () => {
  const birth = D(2025, 5, 4), visit = D(2026, 11, 4);          // 18 เดือน
  const two = PCV.plan({ birth, visit, history: { count: 2, startAge: 13 }, env });
  assert.equal(two.complete, true);
  assert.deepEqual(two.doses.map(d => d.state), ['given', 'given']);
  const done = PCV.plan({ birth, visit, history: { complete: true }, env });
  assert.equal(done.ok, true); assert.equal(done.complete, true); assert.equal(done.doses.length, 0);
  const old = PCV.plan({ birth: D(2023, 1, 1), visit, history: { complete: true }, env });   // 3 ปี: ปกติ too-old แต่ครบแล้วไม่ต้องคำนวณ
  assert.equal(old.ok, true); assert.equal(old.complete, true);
  assert.equal(PCV.plan({ birth, visit, env }).complete, false);
});

test('ประวัติแบบจำนวนเข็ม: ข้อมูลไม่ครบ/ไม่สมเหตุสมผลถูกปฏิเสธ', () => {
  const birth = D(2026, 2, 4), visit = D(2026, 11, 4);          // 9 เดือน
  const code = h => PCV.plan({ birth, visit, history: h, env }).code;
  assert.equal(code({ count: 1 }), 'bad-history');              // ไม่ระบุอายุตอนเริ่ม
  assert.equal(code({ count: 1, startAge: 10 }), 'bad-history'); // เริ่มตอนอายุมากกว่าปัจจุบัน
  assert.equal(code({ count: 3, startAge: 2 }), 'bad-history');
  assert.equal(code({ count: 1, startAge: 1 }), 'too-young');   // เริ่มก่อน 2 เดือน
  assert.equal(code({ count: 1, dose1: D(2026, 4, 8), dose2: D(2026, 6, 10) }), 'bad-history'); // วันที่เข็ม 2 แต่ count = 1
});

test('แก้ PCV_WEEKS ได้ที่เดียว: ถ้าเปลี่ยนเป็นเว้นสัปดาห์ เข็มเดี่ยวต้องตามสัปดาห์ใหม่', () => {
  const visit = D(2026, 11, 11);
  const r = PCV.plan({ birth: addMonths(visit, -9), visit, env: { ...env, pcvWeeks: [2, 4] } });
  assert.deepEqual([2, 4].includes(weekOfMonth(r.doses[1].date)), true);
});
