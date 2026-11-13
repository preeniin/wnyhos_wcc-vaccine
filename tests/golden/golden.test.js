'use strict';
// รัน:  node --test tests/golden/golden.test.js
// ล็อกผลของตัวคำนวณ PCV ให้ตรงกับชุดตัวอย่างที่เก็บไว้ (pcv-cases.json)
// ถ้ากฎเปลี่ยนจนผลต่างจากที่เก็บไว้ เทสต์นี้จะล้ม → ต้องตั้งใจรัน make-cases.js แล้วให้ผู้เชี่ยวชาญตรวจใหม่ (สถานะจะกลับเป็น needs-review)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cases } = require('./cases');
const { run, describe } = require('./render');

const stored = JSON.parse(fs.readFileSync(path.join(__dirname, 'pcv-cases.json'), 'utf8')).cases;
const reviews = JSON.parse(fs.readFileSync(path.join(__dirname, 'reviews.json'), 'utf8'));

test('รายการกรณีใน cases.js ตรงกับ pcv-cases.json (ไม่ลืมรัน make-cases.js)', () => {
  assert.deepEqual(stored.map(c => c.id), cases.map(c => c.id));
  stored.forEach((c, i) => assert.deepEqual(c.input, cases[i].input, c.id));
});

for (const c of stored) {
  test(`golden ${c.id}: ${c.title}`, () => {
    assert.deepEqual(describe(run(c.input)), c.expected, 'ผลคำนวณต่างจากที่เก็บไว้ — ถ้าตั้งใจเปลี่ยนกฎ ให้รัน make-cases.js และให้ผู้เชี่ยวชาญตรวจใหม่');
  });
}

test('ทุกกรณีมีสถานะการตรวจ และ verified ต้องผูกกับผลคำนวณปัจจุบัน', () => {
  for (const c of stored) {
    const r = reviews[c.id];
    assert.ok(r, `ไม่มีสถานะการตรวจของ ${c.id} (รัน make-cases.js)`);
    assert.ok(['unverified', 'verified', 'needs-review', 'rejected'].includes(r.status), c.id);
    if (r.status === 'verified') assert.equal(r.verifiedHash, c.hash, `${c.id}: ผลเปลี่ยนหลังตรวจแล้ว ต้องรัน make-cases.js เพื่อเปลี่ยนเป็น needs-review`);
    if (r.status === 'rejected') assert.fail(`${c.id}: ผู้เชี่ยวชาญระบุว่าผลไม่ถูกต้อง — ${r.note}`);
  }
});

test('สรุปสถานะการตรวจ (ข้อมูลประกอบ)', () => {
  const n = s => stored.filter(c => reviews[c.id].status === s).length;
  console.log(`   golden: ${stored.length} กรณี · ผ่านการตรวจโดยผู้เชี่ยวชาญ ${n('verified')} · ยังไม่ตรวจ ${n('unverified')} · ต้องตรวจใหม่ ${n('needs-review')}`);
});
