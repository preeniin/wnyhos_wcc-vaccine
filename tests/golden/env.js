'use strict';
// สภาพแวดล้อมจริงสำหรับตัวคำนวณ PCV: ดึงฟังก์ชันวันหยุด/หาวันนัดจาก index.html + ข้อมูลจาก data/*.csv
// (ทำเหมือน loadEnv ใน tests/pcv.test.js — แยกไว้ให้ชุด golden ใช้ร่วมกัน ไม่แก้ไฟล์เทสต์เดิม)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

function loadEnv() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const grab = (re, n) => { const m = html.match(re); if (!m) throw new Error('ไม่พบ ' + n + ' ใน index.html'); return m[0]; };
  const code = [
    'let dynamicHolidays = {}; let dynamicHolidayYears = new Set(); let vaccineSchedules = {}; let SERVICE_DAY = 3;',
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
  // ใช้ชุดวันหยุด/ตารางที่ "ตรึงไว้" ในโฟลเดอร์ golden (ไม่ใช้ data/*.csv ที่แก้ได้) เพื่อให้ผลคงที่ — วันหยุดจริงของไทยที่ index.html คำนวณเองยังใช้ตามจริง
  ctx.applyHolidaysCsv(fs.readFileSync(path.join(__dirname, 'fixture-holidays.csv'), 'utf8'));
  ctx.applyVaccinesCsv(fs.readFileSync(path.join(__dirname, 'fixture-vaccines.csv'), 'utf8'));
  const sched = vm.runInContext('vaccineSchedules', ctx);
  return {
    findDate: ctx.findNextApptDate,
    isHoliday: d => ctx.getHolidayForDate(d),
    weeksFor: code => sched[code].weeks,
    pcvWeeks: [1, 2, 3, 4, 5],
  };
}

module.exports = { loadEnv, ROOT };
