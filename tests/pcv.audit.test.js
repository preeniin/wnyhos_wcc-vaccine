'use strict';
// ตรวจ "ความสอดคล้องภายใน" ของแผน PCV แบบกวาดกรณีจำนวนมาก (ไม่ใช่การเทียบกับ CPG — การเทียบกับ CPG ใช้ docs/PCV-CHECKLIST.md ให้คนตรวจ)
// รัน: node --test tests/pcv.audit.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PCV = require('../pcv-rules');
const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const grab = re => { const m = html.match(re); assert.ok(m, 'ไม่พบฟังก์ชันใน index.html'); return m[0]; };
  const code = [
    'let dynamicHolidays = {}; let dynamicHolidayYears = new Set(); let vaccineSchedules = {};',
    grab(/function parseCsvRow\(row\) \{[\s\S]*?\n        \}\n/), grab(/function applyVaccinesCsv\(data\) \{[\s\S]*?\n        \}\n/),
    grab(/function applyHolidaysCsv\(data\) \{[\s\S]*?\n        \}\n/), grab(/const fixedHolidays = \{.*\};\n/),
    grab(/const buddhistHolidayOffsets = \{[\s\S]*?\n        \};\n/), grab(/function getHolidayForDate\(date\) \{[\s\S]*?\n        \}\n/),
    grab(/function findNextApptDate\(start, weeks\) \{[\s\S]*?\n        \}\n/),
  ].join('\n');
  const ctx = { Date, Math, Set, parseInt, isNaN, console };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  ctx.applyHolidaysCsv(fs.readFileSync(path.join(ROOT, 'data/holidays.csv'), 'utf8'));
  ctx.applyVaccinesCsv(fs.readFileSync(path.join(ROOT, 'data/vaccines.csv'), 'utf8'));
  const sched = vm.runInContext('vaccineSchedules', ctx);
  return { ctx, env: { findDate: ctx.findNextApptDate, weeksFor: c => sched[c].weeks, pcvWeeks: [1, 2, 3, 4, 5] }, sched };
}
const { ctx, env, sched } = loadEnv();
const D = (y, m, d) => new Date(y, m - 1, d);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const ROUND_AGE = { '2m': 2, '4m': 4, '6m': 6, '9m': 9, '1y': 12, '18m': 18 };

test('กวาดแผน PCV (อายุ × วันที่มา × ประวัติ): ลำดับ ระยะห่าง วันพุธ/วันหยุด/สัปดาห์ของรอบ จำนวนเข็ม', () => {
  let plans = 0;
  const bad = [];
  const report = (k, tag) => { if (bad.length < 12) bad.push(k + ' :: ' + tag); };
  for (const vd of [D(2026, 11, 4), D(2026, 11, 5), D(2027, 1, 6), D(2027, 6, 9)]) {
    for (let days = 60; days <= 760; days += 3) {
      const b = addDays(vd, -days), ageM = PCV.ageMonths(b, vd);
      const hs = [{}];
      for (let sa = 2; sa <= Math.min(23, ageM); sa++) { hs.push({ count: 1, startAge: sa }); hs.push({ count: 2, startAge: sa }); }
      for (const h of hs) {
        const r = PCV.plan({ birth: b, visit: vd, history: h, env });
        if (!r.ok) continue;
        plans++;
        const tag = 'เกิด ' + iso(b) + ' มา ' + iso(vd) + ' ประวัติ ' + JSON.stringify(h);
        const ds = r.doses;
        // จำนวนเข็ม: เริ่มก่อน 12 เดือน = 3, ตั้งแต่ 12 เดือน = 2
        if (ds.length !== (r.startMonths < 12 ? 3 : 2)) report('จำนวนเข็ม', tag);
        // เรียงลำดับและห่างกันอย่างน้อยตามกฎ
        const dated = ds.filter(d => d.date && d.state !== 'given');
        for (let i = 1; i < dated.length; i++) if (dated[i].date <= dated[i - 1].date) report('ลำดับ/ซ้ำวัน', tag);
        for (let i = 1; i < ds.length; i++) {
          const a = ds[i - 1], c = ds[i];
          if (!a.date || !c.date || c.state === 'given') continue;
          const gap = Math.round((c.date - a.date) / 864e5);
          if (gap < (i === 1 ? PCV.minGapDays(r.startMonths) : 56)) report('ระยะห่างต่ำกว่าขั้นต่ำ ' + gap + ' วัน', tag);
        }
        for (const d of ds) {
          if (d.state === 'given' || !d.date) continue;
          if (d.state === 'due' && iso(d.date) !== iso(vd)) report('due ไม่ใช่วันนี้', tag);
          if (d.state === 'today' && iso(d.date) !== iso(vd)) report('today ไม่ใช่วันนี้', tag);
          if (d.state === 'planned') {
            if (d.date <= vd) report('planned ไม่ใช่อนาคต', tag);
            if (d.date.getDay() !== 3) report('ไม่ใช่วันพุธ', tag);
            if (ctx.getHolidayForDate(d.date)) report('ตรงวันหยุด', tag);
            const weeks = d.withVisit ? sched[d.withVisit].weeks : [1, 2, 3, 4, 5];
            if (!weeks.includes(Math.ceil(d.date.getDate() / 7))) report('สัปดาห์ไม่ตรงรอบ ' + d.withVisit, tag);
            if (d.withVisit && PCV.ageMonths(b, d.date) < ROUND_AGE[d.withVisit]) report('ฉีดก่อนอายุของรอบ ' + d.withVisit, tag);
            if (d.withVisit && PCV.ageMonths(b, d.date) >= PCV.VISIT_BAND_END[d.withVisit] && !d.warnings.length) report('เลยช่วงอายุรอบแต่ไม่มีคำเตือน', tag);
          }
        }
        // เข็ม 1 ที่ติดป้ายรอบ ต้องอยู่ในช่วงอายุของรอบนั้นจริง
        if (ds[0].state === 'today' && ds[0].withVisit) {
          const a = PCV.ageMonths(b, vd), v = ds[0].withVisit;
          if (!(a >= ROUND_AGE[v] && a < PCV.VISIT_BAND_END[v])) report('เข็ม 1 ติดป้ายรอบแต่อายุไม่อยู่ในช่วง', tag);
        }
      }
    }
  }
  assert.ok(plans > 20000, 'ควรตรวจหลายกรณี: ' + plans);
  assert.deepEqual(bad, [], 'พบความผิดปกติ:\n' + bad.join('\n'));
});

test('ตารางอายุตอนฉีดของเด็กที่ยังไม่เคยฉีด (มาตรงอายุ) ตรงกับที่ตกลงกับ CPG — ดู docs/PCV-CHECKLIST.md', () => {
  // [เริ่มตอน, อายุที่ควรได้ของเข็ม 2 (เดือนเต็ม), เข็ม 3 (หรือ null)] ช่วงยอมรับ = ตัวเลขเดือนเต็มของวันฉีดจริง
  const EXPECT = {
    2: [4, 12], 3: [4, 12], 4: [6, 12], 5: [6, 12], 6: [9, 12], 7: [9, 12], 8: [9, 12], 9: [10, 12], 10: [12, 15], 11: [12, 18],
    12: [13, null], 13: [14, null], 14: [15, null], 15: [18, null], 16: [18, null], 17: [18, null], 18: [19, null],
    19: [20, null], 20: [21, null], 21: [22, null], 22: [23, null], 23: [24, null],
  };
  const vd = D(2026, 11, 4);
  for (const S of Object.keys(EXPECT)) {
    const b = new Date(vd); b.setMonth(b.getMonth() - Number(S));
    const r = PCV.plan({ birth: b, visit: vd, env });
    const [a2, a3] = EXPECT[S];
    assert.equal(PCV.ageMonths(b, r.doses[1].date), a2, 'เริ่ม ' + S + ' เดือน เข็ม 2');
    if (a3 === null) assert.equal(r.doses.length, 2, 'เริ่ม ' + S + ' เดือน ต้องมี 2 เข็ม');
    else assert.equal(PCV.ageMonths(b, r.doses[2].date), a3, 'เริ่ม ' + S + ' เดือน เข็ม 3');
  }
});
