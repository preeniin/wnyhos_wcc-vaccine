'use strict';
// บันทึกผลการตรวจของผู้เชี่ยวชาญ (ให้ผู้ตรวจหรือผู้ดูแลที่ได้รับคำยืนยันจากผู้ตรวจเป็นคนรันเท่านั้น)
//   node tests/golden/mark-reviewed.js verified  "ชื่อผู้ตรวจ" N02 N03 P01      ← ถูกต้อง
//   node tests/golden/mark-reviewed.js verified  "ชื่อผู้ตรวจ" all              ← ถูกต้องทุกกรณี
//   node tests/golden/mark-reviewed.js rejected  "ชื่อผู้ตรวจ" N07 "ข้อความอธิบายว่าผิดตรงไหน (ตัวสุดท้าย)"
// สถานะ verified จะผูกกับผลคำนวณ ณ ตอนนั้น (hash) ถ้าผลเปลี่ยนภายหลัง make-cases.js จะเปลี่ยนเป็น needs-review ให้เอง
const fs = require('fs');
const path = require('path');

const [status, by, ...rest] = process.argv.slice(2);
if (!['verified', 'rejected'].includes(status) || !by || !rest.length) {
  console.error('ใช้: node tests/golden/mark-reviewed.js <verified|rejected> "<ชื่อผู้ตรวจ>" <id ... | all> ["หมายเหตุ ถ้า rejected"]');
  process.exit(1);
}
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'pcv-cases.json'), 'utf8')).cases;
const file = path.join(__dirname, 'reviews.json');
const reviews = JSON.parse(fs.readFileSync(file, 'utf8'));
let ids = rest, note = '';
if (status === 'rejected') { note = rest[rest.length - 1]; ids = rest.slice(0, -1); if (!ids.length || !note) { console.error('rejected ต้องระบุ id และหมายเหตุ'); process.exit(1); } }
if (ids.length === 1 && ids[0] === 'all') ids = cases.map(c => c.id);
const date = new Date().toISOString().slice(0, 10);
for (const id of ids) {
  const c = cases.find(x => x.id === id);
  if (!c) { console.error('ไม่พบกรณี ' + id); process.exit(1); }
  reviews[id] = status === 'verified' ? { status, by, date, verifiedHash: c.hash } : { status, by, date, note };
}
fs.writeFileSync(file, JSON.stringify(reviews, null, 2) + '\n');
console.log(`บันทึก ${status} ${ids.length} กรณี โดย ${by}`);
