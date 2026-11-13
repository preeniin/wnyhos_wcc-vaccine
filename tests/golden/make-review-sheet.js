'use strict';
// สร้างใบตรวจสำหรับผู้เชี่ยวชาญ (พิมพ์/บันทึกเป็น PDF จากเบราว์เซอร์ได้):  node tests/golden/make-review-sheet.js
// ผลลัพธ์: docs/pcv-review-sheet.html  — ใช้เด็กสมมติเท่านั้น ไม่มีข้อมูลบุคคลจริง
const fs = require('fs');
const path = require('path');
const PCV = require('../../pcv-rules');
const { thaiDate } = require('./render');
const { parse } = require('./cases');

const stored = JSON.parse(fs.readFileSync(path.join(__dirname, 'pcv-cases.json'), 'utf8')).cases;
const reviews = JSON.parse(fs.readFileSync(path.join(__dirname, 'reviews.json'), 'utf8'));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const spec = s => !s ? '—' : s.how === 'now' ? 'ทันที' : s.how === 'with' ? 'พร้อมรอบ ' + s.visit + (s.fallback ? ' (สำรอง ' + s.fallback + ')' : '')
  : s.how === 'age' ? `อายุ ${s.months} เดือน (เดี่ยว)` : s.how === 'gap' ? `ห่างเข็มแรก ≥ ${s.weeks} สัปดาห์ (เดี่ยว)${s.maxAge ? ` ไม่เกินอายุ ${s.maxAge} เดือน` : ''}` : JSON.stringify(s);
const ruleRows = Object.keys(PCV.RULES).map(Number).sort((a, b) => a - b).map(m => {
  const r = PCV.RULES[m];
  return `<tr><td>${m}</td><td>${esc(spec(r.d1))}</td><td>${esc(spec(r.d2))}</td><td>${esc(r.d3 ? spec(r.d3) + (r.d3MaxAge ? ` (เตือนถ้าเกินอายุ ${r.d3MaxAge} เดือน)` : '') : '—')}</td><td>${r.d3MinGapDays ? r.d3MinGapDays + ' วัน' : '—'}</td></tr>`;
}).join('');

const statusLabel = { verified: '✅ ตรวจแล้ว', unverified: 'ยังไม่ตรวจ', 'needs-review': '⚠️ ต้องตรวจใหม่ (ผลเปลี่ยนหลังตรวจ)', rejected: '❌ ไม่ถูกต้อง' };
const caseHtml = stored.map(c => {
  const rv = reviews[c.id] || { status: 'unverified' };
  const hist = c.input.history ? Object.entries(c.input.history).map(([k, v]) => `${({ count: 'จำนวนเข็มที่ฉีดแล้ว', startAge: 'อายุตอนฉีดเข็มแรก (เดือน)', dose1: 'วันที่ฉีดเข็ม 1', dose2: 'วันที่ฉีดเข็ม 2', complete: 'ครบแล้ว' }[k] || k)}: ${/^\d{4}-/.test(String(v)) ? thaiDate(parse(v)) : v === true ? 'ใช่' : v}`).join(' · ') : 'ยังไม่เคยฉีด PCV';
  return `<section class="case"><h3>${esc(c.id)} — ${esc(c.title)} <span class="st">${statusLabel[rv.status] || rv.status}</span></h3>
  <div class="in"><b>ข้อมูลเด็ก:</b> เกิด ${esc(thaiDate(parse(c.input.birth)))} · มารับบริการ ${esc(thaiDate(parse(c.input.visit)))} · ${esc(hist)}</div>
  <pre>${esc(c.expected.join('\n'))}</pre>
  <div class="tick">ผลถูกต้อง ☐ &nbsp;&nbsp; ผลไม่ถูกต้อง ☐ &nbsp;&nbsp; หมายเหตุ/ควรเป็น: ______________________________________________</div></section>`;
}).join('\n');

const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ใบตรวจแผน PCV สำหรับผู้เชี่ยวชาญ</title>
<style>
 body{font:14px/1.5 "Sarabun","Noto Sans Thai",system-ui,sans-serif;margin:24px auto;max-width:820px;color:#111;padding:0 16px}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:17px;margin:22px 0 6px;border-bottom:2px solid #0f766e;padding-bottom:2px} h3{font-size:14px;margin:0 0 4px}
 .warn{background:#fff4d6;border:1px solid #e0b300;padding:8px 12px;border-radius:6px}
 table{border-collapse:collapse;width:100%;font-size:12.5px} th,td{border:1px solid #999;padding:3px 6px;text-align:left} th{background:#e8f3f1}
 .case{border:1px solid #888;border-radius:6px;padding:8px 12px;margin:10px 0;page-break-inside:avoid} .st{font-weight:400;font-size:12px;color:#555;margin-left:6px}
 pre{background:#f6f8f8;padding:6px 8px;border-radius:4px;white-space:pre-wrap;font:13px/1.5 inherit;margin:6px 0} .tick{margin-top:6px}
 .sig{margin-top:24px}
 @media print{body{margin:0;max-width:none} h2{page-break-after:avoid}}
</style></head><body>
<h1>ใบตรวจแผนการให้ PCV (นิวโมค็อกคัส) สำหรับผู้เชี่ยวชาญ</h1>
<p>ระบบนัดหมายวัคซีน WCC · สร้างจาก <code>pcv-rules.js</code> · จำนวน ${stored.length} กรณี (เด็กสมมติ ไม่มีข้อมูลบุคคลจริง)</p>
<div class="warn"><b>สถานะ:</b> ผลทั้งหมดในใบนี้คือสิ่งที่ <u>โปรแกรมคำนวณได้</u> ยัง<b>ไม่ใช่</b>ข้อยืนยันทางการแพทย์ จนกว่าผู้เชี่ยวชาญจะตรวจและลงนามด้านล่าง
 กรุณาตรวจว่าแต่ละกรณี "เข็มที่ควรฉีด วันนัด และคำเตือน" ถูกต้องตามแนวทางที่ใช้จริง (CPG ที่ใช้อ้างอิง) หรือไม่</div>

<h2>1) ข้อสมมติที่ผู้พัฒนาตัดสินใจเอง — ขอให้ยืนยันเป็นพิเศษ</h2>
<ol>
 <li><b>ระยะห่างเข็มกระตุ้นจากเข็ม 2 ≥ 8 สัปดาห์ (56 วัน)</b> ในผู้เริ่ม 2–6 เดือน: ตัวเลขมาจากหมายเหตุ WHO ใน CPG สำหรับผู้เริ่ม 7–11 เดือน แต่ผู้ใช้ระบบตัดสินใจ<u>ขยายไปใช้กับผู้เริ่ม 2–6 เดือนด้วย (ไม่มีแหล่งอ้างอิงตรง)</u> กรณีมาตามนัดปกติห่างเกิน 8 สัปดาห์อยู่แล้ว ผลต่างเฉพาะเด็กที่มาช้า</li>
 <li><b>ระยะห่างเข็ม 1→2:</b> เริ่มก่อน 12 เดือน = ห่างอย่างน้อย 4 สัปดาห์ · เริ่ม 12–23 เดือน = ห่างอย่างน้อย 8 สัปดาห์ (ตามหมายเหตุ CPG ข้อ 1–2)</li>
 <li><b>คำเตือน "ล่าช้ามาก"</b> เมื่อเข็มที่ถึงกำหนดช้ากว่าอายุในตาราง ≥ ${PCV.LATE_WARN_MONTHS} เดือน — เกณฑ์นี้ผู้พัฒนากำหนดเอง ไม่ได้มาจาก CPG</li>
 <li><b>ช่วงอายุที่ครอบคลุม:</b> เริ่มได้ตั้งแต่ ${PCV.MIN_START_MONTHS} ถึง ${PCV.MAX_START_MONTHS} เดือน · ตั้งแต่ 24 เดือนขึ้นไประบบเตือนให้พิจารณาตามชนิดวัคซีนและช่วงอายุที่ได้รับการรับรอง ไม่คำนวณแผนให้</li>
 <li><b>การนัด:</b> PCV เข็มเดี่ยวเปิดทุกวันพุธ ช่วงเช้า (เงื่อนไขของคลินิก ไม่ใช่เกณฑ์ทางการแพทย์)</li>
</ol>

<h2>2) ตารางกฎตามอายุที่เริ่มเข็มแรก (เดือนเต็ม)</h2>
<table><thead><tr><th>เริ่มตอนอายุ (เดือน)</th><th>เข็ม 1</th><th>เข็ม 2</th><th>เข็ม 3 (กระตุ้น)</th><th>เข็ม 3 ห่างเข็ม 2 อย่างน้อย</th></tr></thead><tbody>${ruleRows}</tbody></table>

<h2>3) กรณีตัวอย่าง</h2>
${caseHtml}

<h2>4) ผลการตรวจ</h2>
<p>ภาพรวม: ถูกต้องทุกกรณี ☐ &nbsp; มีกรณีที่ต้องแก้ ☐ (ระบุรหัสกรณีและสิ่งที่ควรเป็นด้านบน)</p>
<p>ข้อสมมติในหัวข้อ 1 ยอมรับได้ ☐ &nbsp; ต้องปรับ ☐ : ________________________________________________</p>
<div class="sig">ชื่อผู้ตรวจ: ______________________ ตำแหน่ง: ______________________ วันที่: ____/____/________ ลายมือชื่อ: ______________________</div>
<p style="font-size:12px;color:#555">เมื่อผู้ตรวจยืนยันแล้ว ผู้ดูแลระบบบันทึกผลด้วย <code>node tests/golden/mark-reviewed.js verified "ชื่อผู้ตรวจ" all</code> (หรือระบุเฉพาะรหัสกรณี) หากผลคำนวณเปลี่ยนภายหลัง สถานะจะกลับเป็น "ต้องตรวจใหม่" อัตโนมัติ</p>
</body></html>`;

const out = path.join(__dirname, '..', '..', 'docs', 'pcv-review-sheet.html');
fs.writeFileSync(out, html);
console.log('สร้างใบตรวจ ' + path.relative(process.cwd(), out) + ' (' + stored.length + ' กรณี)');
