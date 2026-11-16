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

const DAY_NAMES = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
// เวลาให้บริการของวัคซีนแต่ละช่วงอายุ: เว้นว่าง (= ตามเวลาของคลินิก) หรือรูปแบบ "8:00-11:30น." เท่านั้น — กันพิมพ์มั่ว
const TIME_RANGE_RE = /^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)\s*(?:น\.?)?$/;   // รับรูปแบบใกล้เคียงแล้วปรับให้เป็นมาตรฐานเดียว
// ข้อความรอบที่ "ระบบสร้างให้" (วัน… สัปดาห์ที่ … [เวลา …]) — ประกอบใหม่ทุกครั้งที่บันทึกตามวัน/เวลาปัจจุบัน; ข้อความที่แอดมินเขียนเองไม่ตรงรูปแบบนี้ จึงไม่ถูกแตะ
const AUTO_SCHEDULE_RE = /^วัน(?:อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์|เสาร์) สัปดาห์ที่ [\d,]+(?: เวลา \d{1,2}:\d{2}-\d{1,2}:\d{2}น\.)?$/;
function defaultScheduleText(weeks, time, weekday) {
  return `วัน${DAY_NAMES[Number.isInteger(weekday) ? weekday : 3]} สัปดาห์ที่ ${weeks.join(',')}${time ? ' เวลา ' + time : ''}`;
}

function validateVaccines(input, opts) {
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
    let time = str(r.time, `${at} เวลา`, 40);
    if (time) {
      const m = TIME_RANGE_RE.exec(time);
      if (!m) throw new ValidationError(`${at} เวลา: ต้องเลือกจากรายการ (รูปแบบ 8:00-11:30น.) หรือเว้นว่างเพื่อใช้เวลาของคลินิก`);
      if (Number(m[1]) * 60 + Number(m[2]) >= Number(m[3]) * 60 + Number(m[4])) throw new ValidationError(`${at} เวลา: เวลาเริ่มต้องน้อยกว่าเวลาเลิก`);
      time = `${Number(m[1])}:${m[2]}-${Number(m[3])}:${m[4]}น.`;
    }
    let schedule = str(r.schedule, `${at} ข้อความรอบ`, 120);
    // มี opts.serviceWeekday (= บันทึกผ่าน server) → ข้อความรอบแบบอัตโนมัติถูกปรับให้ตรงวันที่ตั้งไว้ · ไม่มี opts (เรียกจากที่อื่น/เทสต์) → คงข้อความเดิม
    const wd = opts && Number.isInteger(opts.serviceWeekday) ? opts.serviceWeekday : undefined;
    if (!schedule || (wd !== undefined && AUTO_SCHEDULE_RE.test(schedule))) schedule = defaultScheduleText(weeks, time, wd);
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

function parseVaccinesCsv(text, opts) {
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
  return validateVaccines(parsed, opts);
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
const DEFAULT_SETTINGS = {
  hospitalName: 'โรงพยาบาลวังน้ำเย็น', appTitle: 'ระบบนัดหมายวัคซีน WCC', clinicShort: 'WCC',
  // PCV: สัปดาห์ของเดือนที่ "PCV เข็มเดี่ยว" (ไม่ไปพร้อมวัคซีนอื่น) เปิดให้บริการ (ทุกวันพุธ = 1–5) + วัคซีนที่ใช้ + อายุสูงสุดที่ทะเบียนรับรอง (เดือน)
  // วัน/เวลาเปิดให้บริการของคลินิก (0=อาทิตย์ … 6=เสาร์) + เวลาตั้งต้นของทุกช่วงอายุที่ไม่ได้ตั้งเวลาเฉพาะ
  serviceWeekday: 3, serviceStart: '8:00', serviceEnd: '11:30',
  // วัคซีนโรต้า (การ์ดเตือนอายุ): auto = ตรวจจากชื่อ (rota/โรต้า) · ปิด auto แล้วเลือกชื่อจากตารางวัคซีนเอง · rotaFirst = ชื่อเข็มแรก ('' = ดูจากเลขท้ายชื่อ)
  rotaAuto: true, rotaNames: [], rotaFirst: '', rotaDoses: 3,   // rotaDoses = จำนวนเข็มของสูตร (2 หรือ 3) — เข็มสุดท้ายคือเข็มที่ N ต้องครบก่อน 32 สัปดาห์
  pcvWeeks: [1, 2, 3, 4, 5], pcvSession: 'เช้า', pcvTime: '', pcvProduct: 'SII PNEUMOSIL', pcvMaxAgeMonths: 24,
  pcvAdvice: 'แนะนำผู้ปกครองไปฉีดเข็มนี้ที่อื่นด้วย PCV ชนิดอื่น (คลินิกไม่มี PCV ชนิดอื่น และไม่มีการส่งต่อ)',
};
function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('settings: รูปแบบไม่ถูกต้อง');
  const D = DEFAULT_SETTINGS;
  // ฟิลด์ PCV เป็นของใหม่: ไม่ส่งมา (ไคลเอนต์/สำรองรุ่นเก่า) = ใช้ค่าตั้งต้น แต่ถ้าส่งมาต้องถูกต้อง
  let weeks = input.pcvWeeks === undefined ? D.pcvWeeks : input.pcvWeeks;
  if (!Array.isArray(weeks) || !weeks.length || weeks.some(w => !Number.isInteger(w) || w < 1 || w > 5)) throw new ValidationError('สัปดาห์ที่ PCV เปิด: เลือกอย่างน้อย 1 สัปดาห์ (สัปดาห์ที่ 1–5 ของเดือน)');
  weeks = [...new Set(weeks)].sort((x, y) => x - y);
  const sess = input.pcvSession === undefined ? D.pcvSession : input.pcvSession;
  if (sess !== 'เช้า' && sess !== 'บ่าย') throw new ValidationError('ช่วงเวลา PCV เข็มเดี่ยว: เลือกเช้า หรือ บ่าย');
  let ptime = input.pcvTime === undefined ? D.pcvTime : input.pcvTime;
  if (typeof ptime !== 'string') throw new ValidationError('เวลา PCV เข็มเดี่ยว: ต้องเลือกจากรายการ');
  ptime = ptime.trim();
  if (ptime) {
    const m = TIME_RANGE_RE.exec(ptime);
    if (!m) throw new ValidationError('เวลา PCV เข็มเดี่ยว: ต้องเลือกจากรายการ (รูปแบบ 13:00-15:00น.) หรือเว้นว่าง');
    if (Number(m[1]) * 60 + Number(m[2]) >= Number(m[3]) * 60 + Number(m[4])) throw new ValidationError('เวลา PCV เข็มเดี่ยว: เวลาเริ่มต้องน้อยกว่าเวลาเลิก');
    ptime = `${Number(m[1])}:${m[2]}-${Number(m[3])}:${m[4]}น.`;
  }
  const rotaAuto = input.rotaAuto === undefined ? D.rotaAuto : input.rotaAuto;
  if (typeof rotaAuto !== 'boolean') throw new ValidationError('โรต้า: โหมดตรวจจับอัตโนมัติต้องเป็นจริง/เท็จ');
  const rn = input.rotaNames === undefined ? D.rotaNames : input.rotaNames;
  if (!Array.isArray(rn) || rn.length > 10) throw new ValidationError('โรต้า: เลือกชื่อวัคซีนได้ไม่เกิน 10 รายการ');
  const rotaNames = [...new Set(rn.map(x => str(x, 'ชื่อวัคซีนโรต้า', 80, { allowEmpty: false, item: true })))];
  const rotaFirst = input.rotaFirst === undefined ? D.rotaFirst : str(input.rotaFirst, 'ชื่อโรต้าเข็มแรก', 80, { item: true });
  if (!rotaAuto && rotaFirst && !rotaNames.includes(rotaFirst)) throw new ValidationError('โรต้าเข็มแรก: ต้องเป็นหนึ่งในวัคซีนโรต้าที่เลือกไว้');
  const rotaDoses = input.rotaDoses === undefined ? D.rotaDoses : input.rotaDoses;
  if (rotaDoses !== 2 && rotaDoses !== 3) throw new ValidationError('โรต้า: สูตรต้องเป็น 2 เข็ม หรือ 3 เข็ม');
  const maxAge = input.pcvMaxAgeMonths === undefined ? D.pcvMaxAgeMonths : input.pcvMaxAgeMonths;
  if (!Number.isInteger(maxAge) || maxAge < 6 || maxAge > 120) throw new ValidationError('อายุสูงสุดของวัคซีน PCV: ต้องเป็นจำนวนเดือน 6–120');
  const wd = input.serviceWeekday === undefined ? D.serviceWeekday : input.serviceWeekday;
  if (!Number.isInteger(wd) || wd < 1 || wd > 6) throw new ValidationError('วันที่เปิดให้บริการ: เลือกจันทร์–เสาร์');
  const tm = (v, def, label) => {
    const x = v === undefined ? def : v;
    const m = typeof x === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(x.trim()) : null;
    if (!m) throw new ValidationError(`${label}: ต้องเลือกเวลาจากรายการ`);
    return Number(m[1]) + ':' + m[2];
  };
  const st = tm(input.serviceStart, D.serviceStart, 'เวลาเปิดให้บริการ'), en = tm(input.serviceEnd, D.serviceEnd, 'เวลาปิดให้บริการ');
  const mins = t => { const [a, b] = t.split(':'); return Number(a) * 60 + Number(b); };
  if (mins(st) >= mins(en)) throw new ValidationError('เวลาเปิดต้องน้อยกว่าเวลาปิด');
  return {
    serviceWeekday: wd, serviceStart: st, serviceEnd: en,
    hospitalName: str(input.hospitalName, 'ชื่อโรงพยาบาล', 80, { allowEmpty: false }),
    appTitle: str(input.appTitle, 'ชื่อระบบ (หัวหน้าเว็บ)', 80, { allowEmpty: false }),
    clinicShort: str(input.clinicShort, 'ชื่อย่อคลินิก', 20, { allowEmpty: false }),
    rotaAuto, rotaNames, rotaFirst, rotaDoses,
    pcvWeeks: weeks, pcvSession: sess, pcvTime: ptime,
    pcvProduct: input.pcvProduct === undefined ? D.pcvProduct : str(input.pcvProduct, 'ชื่อวัคซีน PCV', 60, { allowEmpty: false }),
    pcvMaxAgeMonths: maxAge,
    pcvAdvice: input.pcvAdvice === undefined ? D.pcvAdvice : str(input.pcvAdvice, 'ข้อความแนะนำเมื่อฉีด PCV ที่คลินิกไม่ได้', 200, { allowEmpty: false }),
  };
}

module.exports = {
  ValidationError, DAY_NAMES, TIME_RANGE_RE, validateVaccines, validateHolidays, validateSettings, DEFAULT_SETTINGS,
  vaccinesToCsv, holidaysToCsv, parseVaccinesCsv, parseHolidaysCsv, parseCsvRow,
};
