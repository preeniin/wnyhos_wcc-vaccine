'use strict';
// แปลงผลของ PCV.plan() เป็นข้อความภาษาไทยอ่านง่าย (ใช้เป็นทั้ง "ผลที่คาดไว้" ในชุด golden และข้อความในใบตรวจ)
const PCV = require('../../pcv-rules');
const { loadEnv } = require('./env');
const { parse } = require('./cases');

const DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thaiDate = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
const STATE = { given: 'ฉีดแล้ว', today: 'ฉีดวันนี้', due: 'ถึงกำหนด ฉีดวันนี้ได้', planned: 'นัด', unavailable: 'ยังกำหนดวันไม่ได้' };

let env = null;
function run(input) {
  env = env || loadEnv();
  const history = input.history ? Object.assign({}, input.history) : undefined;
  if (history) { if (history.dose1) history.dose1 = parse(history.dose1); if (history.dose2) history.dose2 = parse(history.dose2); }
  return PCV.plan({ birth: parse(input.birth), visit: parse(input.visit), history, env });
}

function describe(r) {
  if (!r.ok) return [`คำนวณไม่ได้ (${r.code}): ${r.message}`];
  const lines = [`เริ่มเข็มแรกตอนอายุ ${r.startMonths} เดือน` + (r.complete ? ' · ครบทุกเข็มแล้ว' : '')];
  r.doses.forEach(d => {
    let s = `เข็ม ${d.n}: ${STATE[d.state] || d.state}`;
    if (d.date) s += ` ${thaiDate(new Date(d.date))}`;
    if (d.label) s += ` · ${d.label}`;
    if (d.session) s += ` (ช่วง${d.session})`;
    lines.push(s);
    (d.notes || []).forEach(n => lines.push(`   - หมายเหตุ: ${n}`));
    (d.warnings || []).forEach(w => lines.push(`   - ⚠️ คำเตือน: ${w}`));
  });
  return lines;
}

module.exports = { run, describe, thaiDate };
