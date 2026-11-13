'use strict';
// สร้าง/อัปเดต tests/golden/pcv-cases.json (ผลที่ระบบคำนวณได้ ณ ตอนนี้) และ reviews.json (สถานะการตรวจ)
//   node tests/golden/make-cases.js
// - กรณีใหม่ → สถานะ "unverified"
// - กรณีที่เคยผ่านการตรวจ (verified) แต่ผลเปลี่ยนไป → สถานะ "needs-review" (ต้องตรวจใหม่) — ไม่มีการคงสถานะ "ผ่านการตรวจ" ให้ผลที่ผู้เชี่ยวชาญไม่เคยเห็น
// สถานะ "verified" ตั้งได้ด้วย mark-reviewed.js โดยผู้ตรวจเท่านั้น
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cases } = require('./cases');
const { run, describe } = require('./render');

const hash = lines => crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
const CASES_FILE = path.join(__dirname, 'pcv-cases.json'), REVIEWS_FILE = path.join(__dirname, 'reviews.json');

const out = cases.map(c => { const expected = describe(run(c.input)); return { id: c.id, title: c.title, input: c.input, expected, hash: hash(expected) }; });
let reviews = {};
try { reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8')); } catch (e) { /* ยังไม่มี */ }

const next = {};
out.forEach(c => {
  const old = reviews[c.id];
  if (!old) next[c.id] = { status: 'unverified' };
  else if (old.status === 'verified' && old.verifiedHash !== c.hash) next[c.id] = { status: 'needs-review', note: 'ผลคำนวณเปลี่ยนหลังจากที่เคยตรวจแล้ว ต้องตรวจใหม่', previous: { by: old.by, date: old.date } };
  else next[c.id] = old;
});
fs.writeFileSync(CASES_FILE, JSON.stringify({ visitNote: 'กรณีส่วนใหญ่ใช้วันที่มารับบริการ พุธ 11 พ.ย. 2569', cases: out }, null, 2) + '\n');
fs.writeFileSync(REVIEWS_FILE, JSON.stringify(next, null, 2) + '\n');

const count = s => Object.values(next).filter(r => r.status === s).length;
console.log(`บันทึก ${out.length} กรณี · ผ่านการตรวจ ${count('verified')} · ยังไม่ตรวจ ${count('unverified')} · ต้องตรวจใหม่ ${count('needs-review')} · ไม่ถูกต้อง ${count('rejected')}`);
