'use strict';
// ตรรกะล้วน (ไม่แตะ network/disk) — แยกไว้เพื่อให้เทสต์ง่าย
// ข้อมูลทั้งหมดต้องสร้าง CSV รูปแบบเดียวกับที่ index.html ใช้ parseCsvRow อ่าน:
//  - parser ของหน้าเว็บสลับโหมด quote ทุกครั้งที่เจอ " และตัดทิ้ง จึง **ห้ามมี " ในค่า**
//  - คอมมาในค่าต้องครอบด้วย "..."

const TYPES = ['injection', 'oral'];
const FORBIDDEN = /[<>"`\\\r\n\t]/;           // กัน XSS (หน้าเว็บใช้ innerHTML) และ CSV พัง
const FORBIDDEN_ITEM = /[<>"`\\\r\n\t/|]/;     // ชื่อวัคซีนห้ามมี / และ | เพราะเป็นตัวแบ่งในคอลัมน์

class ValidationError extends Error {}

function str(v, field, max, { allowEmpty = true, item = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new ValidationError(`${field}: ต้องเป็นข้อความ`);
  v = v.trim();
  if (!allowEmpty && !v) throw new ValidationError(`${field}: ห้ามเว้นว่าง`);
  if (v.length > max) throw new ValidationError(`${field}: ยาวเกิน ${max} ตัวอักษร`);
  if ((item ? FORBIDDEN_ITEM : FORBIDDEN).test(v)) {
    throw new ValidationError(`${field}: มีอักขระที่ไม่อนุญาต (< > " \` \\ ${item ? '/ | ' : ''}หรือขึ้นบรรทัดใหม่)`);
  }
  return v;
}

function defaultScheduleText(weeks, time) {
  return `วันพุธ สัปดาห์ที่ ${weeks.join(',')}${time ? ' เวลา ' + time : ''}`;
}

function validateVaccines(input) {
  if (!Array.isArray(input)) throw new ValidationError('vaccines ต้องเป็นรายการ');
  if (input.length === 0) throw new ValidationError('ต้องมีอย่างน้อย 1 ช่วงอายุ (กันลบทั้งตารางโดยไม่ตั้งใจ)');
  if (input.length > 100) throw new ValidationError('มีช่วงอายุได้ไม่เกิน 100 แถว');
  const seen = new Set();
  const out = input.map((r, i) => {
    const at = `แถว ${i + 1}`;
    if (!r || typeof r !== 'object') throw new ValidationError(`${at}: รูปแบบไม่ถูกต้อง`);
    const code = str(r.code, `${at} รหัสอายุ`, 12, { allowEmpty: false });
    if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new ValidationError(`${at} รหัสอายุ: ใช้ได้เฉพาะ a-z 0-9 _ -`);
    if (seen.has(code)) throw new ValidationError(`${at}: รหัสอายุ "${code}" ซ้ำ`);
    seen.add(code);
    const name = str(r.name, `${at} ชื่ออายุ`, 40, { allowEmpty: false });
    if (!Array.isArray(r.vaccines) || r.vaccines.length === 0) throw new ValidationError(`${at}: ต้องมีวัคซีนอย่างน้อย 1 รายการ`);
    if (r.vaccines.length > 20) throw new ValidationError(`${at}: วัคซีนต่อช่วงอายุไม่เกิน 20 รายการ`);
    const vaccines = r.vaccines.map((v, j) => {
      const vat = `${at} วัคซีน ${j + 1}`;
      const type = v && v.type ? String(v.type) : 'injection';
      if (!TYPES.includes(type)) throw new ValidationError(`${vat}: ชนิดต้องเป็น injection หรือ oral`);
      return {
        name: str(v && v.name, `${vat} ชื่อ`, 80, { allowEmpty: false, item: true }),
        thai: str(v && v.thai, `${vat} ชื่อไทย`, 120, { item: true }),
        type,
      };
    });
    const weeksIn = Array.isArray(r.weeks) ? r.weeks : [];
    const weeks = [...new Set(weeksIn.map(Number))].sort((a, b) => a - b);
    if (weeks.length === 0 || weeks.some(w => !Number.isInteger(w) || w < 1 || w > 5)) {
      throw new ValidationError(`${at} สัปดาห์ที่เปิด: เลือก 1–5 อย่างน้อย 1 สัปดาห์`);
    }
    const time = str(r.time, `${at} เวลา`, 40);
    let schedule = str(r.schedule, `${at} ข้อความรอบ`, 120);
    if (!schedule) schedule = defaultScheduleText(weeks, time);
    return {
      code, name, vaccines, schedule, weeks, time,
      nextAge: str(r.nextAge, `${at} อายุถัดไป`, 12),
      special: str(r.special, `${at} หมายเหตุ`, 300),
    };
  });
  out.forEach((r, i) => {
    if (r.nextAge && !seen.has(r.nextAge)) throw new ValidationError(`แถว ${i + 1}: อายุถัดไป "${r.nextAge}" ไม่มีในตาราง`);
    if (r.nextAge === r.code) throw new ValidationError(`แถว ${i + 1}: อายุถัดไปห้ามเป็นรหัสตัวเอง`);
  });
  return out;
}

function validateHolidays(input) {
  if (!Array.isArray(input)) throw new ValidationError('holidays ต้องเป็นรายการ');
  if (input.length > 3000) throw new ValidationError('มีวันหยุดได้ไม่เกิน 3000 แถว');
  return input.map((r, i) => {
    const at = `แถว ${i + 1}`;
    const date = str(r && r.date, `${at} วันที่`, 10, { allowEmpty: false });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError(`${at} วันที่: รูปแบบต้องเป็น ปปปป-ดด-วว (ค.ศ.)`);
    const d = new Date(date + 'T00:00:00Z');
    if (isNaN(d) || d.toISOString().slice(0, 10) !== date) throw new ValidationError(`${at} วันที่: ไม่มีวันนี้จริง`);
    const y = +date.slice(0, 4);
    if (y < 2020 || y > 2100) throw new ValidationError(`${at} วันที่: ปีต้องอยู่ระหว่าง 2020–2100 (ค.ศ.)`);
    return { date, name: str(r.name, `${at} ชื่อ`, 100, { allowEmpty: false }) };
  });
}

// ---------- CSV ----------
function csvCell(v) { return /,/.test(v) ? `"${v}"` : v; }

function vaccinesToCsv(rows) {
  const lines = ['AgeCode,AgeName,VaccineList,ScheduleText,Weeks,Time,NextAge,SpecialNote'];
  rows.forEach(r => {
    const list = r.vaccines.map(v => `${v.name}/${v.thai}/${v.type}`).join(' | ');
    lines.push([r.code, r.name, list, r.schedule, r.weeks.join(','), r.time, r.nextAge, r.special].map(csvCell).join(','));
  });
  return lines.join('\n') + '\n';
}

function holidaysToCsv(rows) {
  return ['Date,Name', ...rows.map(r => `${r.date},${csvCell(r.name)}`)].join('\n') + '\n';
}

// parser เดียวกับ index.html (parseCsvRow) เพื่อให้นำเข้า CSV เดิมได้ตรงกับที่หน้าเว็บเข้าใจ
function parseCsvRow(row) {
  const cols = []; let inQ = false, cur = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '"') inQ = !inQ;
    else if (row[i] === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else cur += row[i];
  }
  cols.push(cur.trim());
  return cols;
}

function parseVaccinesCsv(text) {
  const rows = String(text).replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(r => r.trim());
  const parsed = rows.map(row => {
    const c = parseCsvRow(row).map(x => x.replace(/['"]/g, ''));
    if (c.length < 6) throw new ValidationError(`CSV วัคซีน: แถว "${row.slice(0, 40)}" คอลัมน์ไม่ครบ (ต้องมีอย่างน้อย 6)`);
    const vaccines = c[2].split('|').map(v => {
      const p = v.split('/');
      return { name: (p[0] || '').trim(), thai: (p[1] || '').trim(), type: (p[2] || 'injection').trim() };
    }).filter(v => v.name);
    return {
      code: c[0], name: c[1], vaccines, schedule: c[3],
      weeks: c[4].split(',').map(w => parseInt(w.trim(), 10)).filter(w => !isNaN(w)),
      time: c[5], nextAge: c[6] || '', special: c[7] || '',
    };
  });
  return validateVaccines(parsed);
}

function parseHolidaysCsv(text) {
  const rows = String(text).replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(r => r.trim());
  const parsed = rows.map(row => {
    const c = parseCsvRow(row);
    if (c.length < 2) throw new ValidationError(`CSV วันหยุด: แถว "${row.slice(0, 40)}" คอลัมน์ไม่ครบ`);
    let date = c[0].replace(/['"]/g, '').trim();
    if (date.includes('/')) { // รองรับ วว/ดด/ปปปป (พ.ศ./ค.ศ.) เหมือนที่ Google Sheets เคยส่งมา
      const p = date.split('/');
      if (p.length === 3) {
        let a = parseInt(p[0], 10), b = parseInt(p[1], 10), y = parseInt(p[2], 10);
        if (y > 2500) y -= 543;
        let d = a, m = b;
        if (a <= 12 && b > 12) { d = b; m = a; }
        date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
    return { date, name: c.slice(1).join(',').replace(/['"]/g, '').trim() };
  });
  return validateHolidays(parsed);
}

// ---------- ข้อมูลคลินิก (แสดงบนหน้าเว็บ) ----------
// ค่าตั้งต้น = ค่าที่เคยฝังใน index.html — หน้าเว็บมีค่าเดียวกันฝังไว้เป็น fallback เสมอ (เช่น GitHub Pages ที่ไม่มี server)
const DEFAULT_SETTINGS = { hospitalName: 'โรงพยาบาลวังน้ำเย็น', appTitle: 'ระบบนัดหมายวัคซีน WCC', clinicShort: 'WCC' };
function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('settings: รูปแบบไม่ถูกต้อง');
  return {
    hospitalName: str(input.hospitalName, 'ชื่อโรงพยาบาล', 80, { allowEmpty: false }),
    appTitle: str(input.appTitle, 'ชื่อระบบ (หัวหน้าเว็บ)', 80, { allowEmpty: false }),
    clinicShort: str(input.clinicShort, 'ชื่อย่อคลินิก', 20, { allowEmpty: false }),
  };
}

module.exports = {
  ValidationError, validateVaccines, validateHolidays, validateSettings, DEFAULT_SETTINGS,
  vaccinesToCsv, holidaysToCsv, parseVaccinesCsv, parseHolidaysCsv, parseCsvRow,
};
