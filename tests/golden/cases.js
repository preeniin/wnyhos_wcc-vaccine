'use strict';
// กรณีตัวอย่าง (เด็กสมมติ ไม่มีข้อมูลบุคคลจริง) สำหรับให้ผู้เชี่ยวชาญตรวจแผน PCV
// ทุกกรณีใช้วันที่มารับบริการ พุธ 11 พ.ย. 2026 (ค.ศ.) = 11 พ.ย. 2569 เพื่อให้ผลคงที่ — ถ้าจะเพิ่มกรณี เพิ่มที่นี่แล้วรัน make-cases.js
const VISIT = '2026-11-11';

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const monthsBefore = (iso, n) => { const x = parse(iso); x.setMonth(x.getMonth() - n); return fmt(x); };
const daysBefore = (iso, n) => { const x = parse(iso); x.setDate(x.getDate() - n); return fmt(x); };

const cases = [];
const add = (id, title, input) => cases.push({ id, title, input: Object.assign({ visit: VISIT }, input) });

// 1) ยังไม่เคยฉีด PCV: อายุตอนมารับบริการ 1–24 เดือน
for (let m = 1; m <= 24; m++) {
  add('N' + pad(m), `ยังไม่เคยฉีด PCV · อายุ ${m} เดือน`, { birth: monthsBefore(VISIT, m) });
}

// 2) เคยฉีดแล้วบางเข็ม (ระบุจำนวนเข็ม + อายุตอนฉีดเข็มแรก ไม่ระบุวันที่)
const partial = [
  ['P01', 5, 1, 2], ['P02', 7, 1, 4], ['P03', 11, 1, 6], ['P04', 14, 1, 9], ['P05', 16, 1, 12],
  ['P06', 8, 2, 2], ['P07', 13, 2, 4], ['P08', 15, 2, 7], ['P09', 20, 2, 12],
];
partial.forEach(([id, age, count, startAge]) =>
  add(id, `เคยฉีดแล้ว ${count} เข็ม (เริ่มตอน ${startAge} เดือน) · อายุตอนนี้ ${age} เดือน`, { birth: monthsBefore(VISIT, age), history: { count, startAge } }));

// 3) เจ้าหน้าที่ระบุว่าครบแล้ว
add('C01', 'ครบทุกเข็มแล้ว (เจ้าหน้าที่ระบุ) · อายุ 10 เดือน', { birth: monthsBefore(VISIT, 10), history: { complete: true } });

// 4) ระบุวันที่ฉีดจริง → ตรวจระยะห่างระหว่างเข็ม
add('D01', 'เข็ม 1 ฉีดเมื่อ 20 วันก่อน (ห่างไม่ถึง 4 สัปดาห์) · อายุ 5 เดือน · เริ่มตอน 4 เดือน', { birth: monthsBefore(VISIT, 5), history: { count: 1, startAge: 4, dose1: daysBefore(VISIT, 20) } });
add('D02', 'เข็ม 1 ฉีดเมื่อ 40 วันก่อน (ห่างเกิน 4 สัปดาห์) · อายุ 5 เดือน · เริ่มตอน 4 เดือน', { birth: monthsBefore(VISIT, 5), history: { count: 1, startAge: 4, dose1: daysBefore(VISIT, 40) } });
add('D03', 'ฉีดแล้ว 2 เข็ม (วันที่ 150 และ 100 วันก่อน) · อายุ 8 เดือน · เริ่มตอน 3 เดือน', { birth: monthsBefore(VISIT, 8), history: { count: 2, startAge: 3, dose1: daysBefore(VISIT, 150), dose2: daysBefore(VISIT, 100) } });
add('D04', 'เข็ม 1 ฉีดเมื่อ 30 วันก่อน (เริ่มตอน 12 เดือนขึ้นไปต้องห่าง 8 สัปดาห์) · อายุ 14 เดือน', { birth: monthsBefore(VISIT, 14), history: { count: 1, startAge: 12, dose1: daysBefore(VISIT, 30) } });

// 5) ใกล้วันหยุดปลายปี (วันนัดต้องเลี่ยงวันหยุด)
add('H01', 'มารับบริการ พุธ 23 ธ.ค. 2569 อายุ 2 เดือน (นัดถัดไปคาบเกี่ยวช่วงปีใหม่)', { visit: '2026-12-23', birth: monthsBefore('2026-12-23', 2) });

// 6) เด็กกลุ่มเสี่ยงสูง (สูตร 3p+1 ตาม CPG หน้า 8) — เพิ่ม 14 พ.ย. 2569
add('R01', 'กลุ่มเสี่ยงสูง · ยังไม่เคยฉีด · อายุ 2 เดือน (ได้ครบ 4 เข็ม: รอบ 2, 4, 6 เดือน + กระตุ้น 1 ปี)', { birth: monthsBefore(VISIT, 2), highRisk: true });
add('R02', 'กลุ่มเสี่ยงสูง · ยังไม่เคยฉีด · อายุ 3 เดือน', { birth: monthsBefore(VISIT, 3), highRisk: true });
add('R03', 'กลุ่มเสี่ยงสูง · ยังไม่เคยฉีด · อายุ 5 เดือน (CPG ไม่มีตาราง 3p+1 ล่าช้า → แสดงแผนปกติ + ต้องให้กุมารแพทย์กำหนด)', { birth: monthsBefore(VISIT, 5), highRisk: true });
add('R04', 'กลุ่มเสี่ยงสูง · เคยฉีด 1 เข็ม (เริ่มตอน 2 เดือน) · อายุ 5 เดือน', { birth: monthsBefore(VISIT, 5), highRisk: true, history: { count: 1, startAge: 2 } });
add('R05', 'กลุ่มเสี่ยงสูง · เคยฉีด 2 เข็ม (เริ่มตอน 12 เดือน) · อายุ 20 เดือน (แผนปกติ "ครบ" แต่ต้องไม่ขึ้นว่าครบ)', { birth: monthsBefore(VISIT, 20), highRisk: true, history: { count: 2, startAge: 12 } });
add('R06', 'กลุ่มเสี่ยงสูง · เจ้าหน้าที่ระบุว่าครบแล้ว · อายุ 10 เดือน', { birth: monthsBefore(VISIT, 10), highRisk: true, history: { complete: true } });

module.exports = { cases, VISIT, parse };
