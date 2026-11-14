'use strict';
// รัน:  node --test tests/pcv-highrisk.test.js
// เด็กกลุ่มเสี่ยงสูง (สูตร 3p+1 ตาม CPG หน้า 8) — ดู HR_* ใน pcv-rules.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PCV = require('../pcv-rules');
const { loadEnv } = require('./golden/env');

const env = loadEnv();
const D = (y, m, d) => new Date(y, m - 1, d);
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
const iso = d => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const days = (a, b) => Math.round((b - a) / 86400000);
const VISIT = D(2026, 11, 11);

test('เสี่ยงสูง เริ่ม 2 เดือน: 3p+1 = เข็ม 1–3 พร้อมรอบ 2/4/6 เดือน และกระตุ้นพร้อมรอบ 1 ปี', () => {
  const r = PCV.plan({ birth: addMonths(VISIT, -2), visit: VISIT, highRisk: true, env });
  assert.ok(r.ok);
  assert.equal(r.highRisk.mode, 'standard');
  assert.equal(r.highRisk.schedule, '3p+1');
  assert.equal(r.doses.length, 4);
  assert.deepEqual(r.doses.map(d => d.withVisit), ['2m', '4m', '6m', '1y']);
  assert.deepEqual(r.doses.map(d => iso(d.date)), ['2026-11-11', '2027-01-20', '2027-03-17', '2027-09-22']);
  assert.equal(r.complete, false);
});

test('เสี่ยงสูง เริ่ม 3 เดือน: เข็ม 1 ทันที แล้วรอบ 4/6 เดือน และ 1 ปี', () => {
  const r = PCV.plan({ birth: addMonths(VISIT, -3), visit: VISIT, highRisk: true, env });
  assert.equal(r.highRisk.mode, 'standard');
  assert.deepEqual(r.doses.map(d => d.withVisit), [null, '4m', '6m', '1y']);
  assert.deepEqual(r.doses.map(d => iso(d.date)), ['2026-11-11', '2026-12-16', '2027-02-17', '2027-08-11']);
});

test('คนปกติ (ไม่ติ๊กกลุ่มเสี่ยง) ผลเหมือนเดิม: ไม่มี highRisk และ 3 เข็ม', () => {
  const r = PCV.plan({ birth: addMonths(VISIT, -2), visit: VISIT, env });
  assert.equal(r.highRisk, null);
  assert.equal(r.doses.length, 3);
  assert.deepEqual(r.doses.map(d => iso(d.date)), ['2026-11-11', '2027-01-20', '2027-09-22']);
});

test('เสี่ยงสูงที่เริ่มหลัง 3 เดือน: แสดงแผนสูตรปกติ + คำเตือน "specialist" และไม่บอกว่าครบ', () => {
  for (const m of [4, 5, 6, 8, 11, 12, 15, 20, 23]) {
    const r = PCV.plan({ birth: addMonths(VISIT, -m), visit: VISIT, highRisk: true, env });
    assert.ok(r.ok, 'เริ่ม ' + m);
    assert.equal(r.highRisk.mode, 'specialist', 'เริ่ม ' + m);
    assert.match(r.highRisk.message, /กุมารแพทย์/);
    assert.equal(r.complete, false, 'เริ่ม ' + m);
    // แผนที่แสดงต้องเท่ากับสูตรปกติทุกประการ (ไม่คิดเลขสูตร 3p+1 เอง)
    const normal = PCV.plan({ birth: addMonths(VISIT, -m), visit: VISIT, env });
    assert.deepEqual(r.doses.map(d => iso(d.date)), normal.doses.map(d => iso(d.date)), 'เริ่ม ' + m);
  }
  // ฉีดครบ 2 เข็มตั้งแต่ 12 เดือน (แผนปกติ "ครบ") แต่เป็นกลุ่มเสี่ยง → ต้องไม่ขึ้นว่าครบ
  const r = PCV.plan({ birth: addMonths(VISIT, -20), visit: VISIT, highRisk: true, history: { count: 2, startAge: 12 }, env });
  assert.equal(PCV.plan({ birth: addMonths(VISIT, -20), visit: VISIT, history: { count: 2, startAge: 12 }, env }).complete, true);
  assert.equal(r.complete, false);
  assert.equal(r.highRisk.mode, 'specialist');
});

test('เสี่ยงสูง + "ครบแล้ว" (เจ้าหน้าที่ระบุ): ไม่นัด แต่มีข้อความเตือนให้ตรวจว่าครบตามสูตร', () => {
  const r = PCV.plan({ birth: addMonths(VISIT, -10), visit: VISIT, highRisk: true, history: { complete: true }, env });
  assert.equal(r.complete, true);
  assert.equal(r.highRisk.mode, 'complete');
  assert.equal(PCV.plan({ birth: addMonths(VISIT, -10), visit: VISIT, history: { complete: true }, env }).highRisk, null);
});

test('เสี่ยงสูง: อายุต่ำกว่า 2 เดือน / ตั้งแต่ 24 เดือน ยังไม่คำนวณเหมือนเดิม', () => {
  assert.equal(PCV.plan({ birth: addMonths(VISIT, -1), visit: VISIT, highRisk: true, env }).code, 'too-young');
  assert.equal(PCV.plan({ birth: addMonths(VISIT, -24), visit: VISIT, highRisk: true, env }).code, 'too-old');
});

test('เสี่ยงสูง เริ่ม 2–3 เดือน มีประวัติบางเข็ม: เข็มที่ฉีดแล้วคงไว้ เข็มที่เหลือครบ 4 เข็ม', () => {
  const r1 = PCV.plan({ birth: addMonths(VISIT, -5), visit: VISIT, highRisk: true, history: { count: 1, startAge: 2 }, env });
  assert.equal(r1.highRisk.mode, 'standard');
  assert.deepEqual(r1.doses.map(d => d.state === 'given'), [true, false, false, false]);
  const r2 = PCV.plan({ birth: addMonths(VISIT, -7), visit: VISIT, highRisk: true, history: { count: 2, startAge: 2 }, env });
  assert.deepEqual(r2.doses.map(d => d.state === 'given'), [true, true, false, false]);
});

// ---------- เงื่อนไขที่ต้องเป็นจริงเสมอ (กวาดหลายกรณี) ----------
test('กวาด: ระยะห่างขั้นต่ำ, ลำดับวัน, วันพุธ ของสูตร 3p+1 ทุกกรณีที่คำนวณได้', () => {
  let checked = 0;
  for (const startAge of [2, 3]) {
    for (let ageNow = startAge; ageNow <= 23; ageNow += 1) {
      for (const count of [0, 1, 2]) {
        if (count > 0 && ageNow < startAge) continue;
        for (let off = 0; off < 14; off += 3) {                      // หลายวันที่มารับบริการ
          const visit = new Date(VISIT.getFullYear(), VISIT.getMonth(), VISIT.getDate() + off);
          const birth = addMonths(visit, -ageNow);
          const history = count ? { count, startAge } : undefined;
          const r = PCV.plan({ birth, visit, highRisk: true, history, env });
          if (!r.ok) continue;                                          // เช่น ยังไม่ถึง 2 เดือน (ไม่ใช่เรื่องของกฎนี้)
          if (r.highRisk.mode !== 'standard') continue;
          checked++;
          assert.equal(r.doses.length, 4);
          const ctx = `เริ่ม ${startAge} อายุ ${ageNow} ประวัติ ${count} วันที่ ${iso(visit)}`;
          const dated = r.doses.filter(d => d.date);
          dated.forEach((d, i) => { if (i) assert.ok(d.date > dated[i - 1].date, 'ลำดับวันต้องเพิ่มขึ้น ' + ctx); });
          r.doses.forEach(d => { if (d.state === 'planned') assert.equal(d.date.getDay(), 3, 'นัดต้องเป็นวันพุธ ' + ctx); });
          for (let n = 1; n < 4; n++) {
            const a = r.doses[n - 1], b = r.doses[n];
            if (b.state === 'given' || !a.date || !b.date) continue;
            assert.ok(days(a.date, b.date) >= (n < 3 ? 28 : 56), `ระยะห่างเข็ม ${n}→${n + 1} ไม่ถึงขั้นต่ำ ${ctx}`);
          }
          assert.equal(r.complete, false, 'ยังไม่ครบ ' + ctx);
        }
      }
    }
  }
  assert.ok(checked > 100, 'ต้องกวาดอย่างน้อย 100 กรณี (ได้ ' + checked + ')');
});
