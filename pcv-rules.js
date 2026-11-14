'use strict';
/**
 * กฎการให้วัคซีน PCV ตาม CPG "คำแนะนำการให้บริการวัคซีนนิวโมค็อกคัส" ตารางที่ 2
 * (คำแนะนำตาม "อายุที่เริ่มรับ PCV เข็มแรก" รวมกรณีล่าช้า)
 *
 * ไฟล์นี้เป็นตรรกะล้วน ไม่แตะ DOM — ใช้ได้ทั้งในเบราว์เซอร์ (window.PCV) และ Node (require) เพื่อให้เทสต์ได้
 * ตัวเลือกที่ CPG ให้หลายทาง ผู้ใช้เลือกหลักการ "ไปพร้อมวัคซีนอื่น มาน้อยครั้งที่สุด" (ดู cpgAlt เก็บทางที่ไม่ได้ใช้ไว้อ้างอิง)
 *
 * วิธีใช้:
 *   PCV.plan({ birth, visit, history, env })
 *   history (ไม่ใส่ = ยังไม่เคยฉีด):
 *     { count: 1|2, startAge: เดือนเต็มตอนฉีดเข็มแรก }   ช่องบังคับเมื่อเคยฉีดแล้ว
 *     + { dose1?: Date, dose2?: Date }                  ช่องเสริม: ถ้ากรอก ตรวจระยะห่างจากวันจริง (เข็ม 1 กรอกแล้ว startAge ไม่ต้อง)
 *     { complete: true }                                 เจ้าหน้าที่ระบุว่าครบแล้ว → ไม่นัด
 *   (ใส่แค่ dose1/dose2 โดยไม่มี count ก็ใช้ได้ — นับจำนวนจากวันที่)
 *   env = {
 *     findDate(startDate, weeks) -> Date|null   // วันพุธแรกที่ >= startDate, สัปดาห์ของเดือนอยู่ใน weeks, ไม่ใช่วันหยุด (= findNextApptDate ใน index.html)
 *     weeksFor(visitCode)        -> number[]    // สัปดาห์ที่คลินิกเปิดของรอบนั้น (จาก vaccineSchedules[code].weeks)
 *     pcvWeeks                   -> number[]    // สัปดาห์ที่ PCV เดี่ยว ๆ เปิด (ช่วงแรก = ทุกสัปดาห์ [1,2,3,4,5])
 *   }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCV = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // รอบวัคซีนปกติของคลินิก (รหัสตรงกับ AgeCode ใน vaccines.csv) → อายุเป้าหมาย (เดือน)
  const VISIT_AGE = { '2m': 2, '4m': 4, '6m': 6, '9m': 9, '1y': 12, '18m': 18 };
  // เดือนที่หมดช่วงของรอบ (ตาม determineVaccineAge ใน index.html: 2m=2–<4, 4m=4–<6, 6m=6–<9, 9m=9–<12, 1y=12–<18, 18m=18–<30)
  const VISIT_BAND_END = { '2m': 4, '4m': 6, '6m': 9, '9m': 12, '1y': 18, '18m': 30 };
  const VISIT_LABEL = {
    '2m': 'รอบ 2 เดือน (DTP-HB-Hib1 + IPV1 + Rota1)',
    '4m': 'รอบ 4 เดือน (DTP-HB-Hib2 + IPV2 + Rota2)',
    '6m': 'รอบ 6 เดือน (DTP-HB-Hib3 + OPV3 + Rota3)',
    '9m': 'MMR1 ตอน 9 เดือน',
    '1y': 'LAJE1 ตอน 12 เดือน',
    '18m': 'รอบ 18 เดือน (DTP4 + OPV4 + MMR2)',
  };

  // เข็มที่ "ถึงกำหนดวันนี้" แต่ช้ากว่าอายุที่ตารางกำหนด ≥ ค่านี้ (เดือน) → คำเตือนให้แพทย์พิจารณา (ปรับได้ค่าเดียว)
  const LATE_WARN_MONTHS = 6;
  const MIN_START_MONTHS = 2;   // ต่ำกว่านี้ ตาราง CPG ไม่ครอบคลุม
  const MAX_START_MONTHS = 23;  // 24 เดือนขึ้นไป: "พิจารณาตามชนิดวัคซีนและช่วงอายุที่ได้รับการรับรอง"

  // เด็กกลุ่มเสี่ยงสูง (ภูมิคุ้มกันบกพร่อง ไม่มีม้าม โรคเรื้อรัง เช่น โรคปอด โรคหัวใจ): CPG หน้า 8 ข้อ 6 แนะนำสูตร 3p+1
  //   ชุดเบื้องต้น 3 เข็มที่อายุ 2, 4, 6 เดือน + เข็มกระตุ้น 1 เข็มที่อายุ 12–15 เดือน และให้ปรึกษากุมารแพทย์รายบุคคล
  // CPG "ไม่มีตารางล่าช้า" ของสูตรนี้ ระบบจึงคำนวณจริงเฉพาะเด็กที่เริ่มทันชุดเบื้องต้น (เริ่ม 2–3 เดือน → เข็ม 2, 3 ไปพร้อมรอบ 4, 6 เดือน)
  // เด็กที่เริ่มหลัง 3 เดือน: แสดงแผนสูตรปกติ (2p+1) พร้อมคำเตือนว่า "อาจไม่พอ" ให้กุมารแพทย์กำหนด — ไม่คิดเลขสูตร 3p+1 เองโดยไม่มีแหล่งอ้างอิง
  const HR_STANDARD = 'เด็กกลุ่มเสี่ยงสูง: CPG แนะนำสูตร 3p+1 คือชุดเบื้องต้น 3 เข็มที่อายุ 2, 4, 6 เดือน และเข็มกระตุ้น 1 เข็มที่อายุ 12–15 เดือน — ควรปรึกษากุมารแพทย์ประเมินประวัติ อายุ และความเสี่ยงเป็นรายบุคคล และอาจต้องพิจารณาวัคซีนนิวโมค็อกคัสชนิดอื่นเพิ่มเติม';
  const HR_SPECIALIST = 'เด็กกลุ่มเสี่ยงสูงที่เริ่ม PCV หลังอายุ 3 เดือน: CPG ไม่มีตารางล่าช้าของสูตร 3p+1 — แผนด้านล่างคำนวณตามสูตรปกติ (2p+1) ซึ่งอาจ "ไม่พอ" สำหรับเด็กกลุ่มนี้ กรุณาให้กุมารแพทย์กำหนดจำนวนเข็มและวันนัด';
  const HR_COMPLETE = 'เจ้าหน้าที่ระบุว่าครบแล้ว — เด็กกลุ่มเสี่ยงสูงควรตรวจว่าครบตามสูตรที่กุมารแพทย์กำหนด (CPG แนะนำ 3p+1) ระบบไม่ได้ตรวจย้อนหลัง';

  // วัคซีน PCV ของแผนงานปัจจุบัน และอายุสูงสุดที่ทะเบียนรับรอง (เดือน, "ก่อนครบ 2 ปี" = 24) — ดูการใช้ใน plan(); index.html ส่งค่าจริงมาทาง env.product
  // advice = สิ่งที่เจ้าหน้าที่ต้องบอกผู้ปกครองเมื่อเข็มนั้นให้ที่คลินิกไม่ได้ (14 พ.ย. 2569: คลินิกไม่มี PCV ชนิดอื่น แนะนำไปฉีดที่อื่น ไม่มีการส่งต่อ — ถ้าอนาคตมีชนิดอื่น แก้ข้อความนี้ที่เดียว)
  const DEFAULT_PRODUCT = { name: 'SII PNEUMOSIL', maxAgeMonths: 24, advice: 'แนะนำผู้ปกครองไปฉีดเข็มนี้ที่อื่นด้วย PCV ชนิดอื่น (คลินิกไม่มี PCV ชนิดอื่น และไม่มีการส่งต่อ)' };

  const NOW = { how: 'now' };
  const WITH = (visit, fallback) => (fallback ? { how: 'with', visit, fallback } : { how: 'with', visit });
  const AGE = months => ({ how: 'age', months });                       // เดี่ยว ๆ ตามอายุ (PCV เปิดทุกพุธ)
  const GAP = (weeks, maxAge) => ({ how: 'gap', weeks, maxAge });       // เดี่ยว ๆ ห่างเข็มแรกอย่างน้อย N สัปดาห์

  // RULES[อายุที่เริ่มเข็ม 1 (เดือนเต็ม)] = { d1, d2, d3, cpgAlt, d3MinGapDays?, d3MaxAge? }
  //  d3MinGapDays = 56: booster ห่างจากเข็ม 2 อย่างน้อย 8 สัปดาห์ — ตัวเลขมาจากหมายเหตุ WHO ใน CPG สำหรับผู้เริ่ม 7–11 เดือน
  //                 ผู้ใช้ตัดสินใจขยายใช้กับผู้เริ่ม 2–6 เดือนด้วย (ไม่มีแหล่งอ้างอิงตรง) กรณีมาตามกำหนดห่างเกิน 8 สัปดาห์อยู่แล้ว ผลเปลี่ยนเฉพาะเด็กมาช้า
  //  d3MaxAge     = ปลายช่วงอายุ booster ที่ CPG ให้ (เริ่ม 7–9 เดือน: 12–15 ด., เริ่ม 11 เดือน: 15–18 ด.) เตือนเมื่อเลยช่วง
  const RULES = {
    2:  { d1: WITH('2m'),  d2: WITH('4m'),  d3: WITH('1y'), d3MinGapDays: 56,  cpgAlt: {} },
    3:  { d1: NOW,         d2: WITH('4m', '6m'), d3: WITH('1y'), d3MinGapDays: 56, cpgAlt: { d2: 'หรือพร้อมรอบ 6 เดือน (ใช้เป็นทางสำรองเมื่อรอบ 4 เดือนห่างเข็ม 1 ไม่ถึง 4 สัปดาห์)' } },
    4:  { d1: WITH('4m'),  d2: WITH('6m'),  d3: WITH('1y'), d3MinGapDays: 56,  cpgAlt: {} },
    5:  { d1: NOW,         d2: WITH('6m'),  d3: WITH('1y'), d3MinGapDays: 56,  cpgAlt: {} },
    6:  { d1: WITH('6m'),  d2: WITH('9m'),  d3: WITH('1y'), d3MinGapDays: 56,  cpgAlt: { d2: 'หรืออายุ 7 หรือ 8 เดือน (เดี่ยว)' } },
    7:  { d1: NOW,         d2: WITH('9m'),  d3: WITH('1y'),  cpgAlt: { d2: 'หรืออายุ 8 เดือน (เดี่ยว)', d3: 'ช่วง 12–15 เดือน (เลือก 12 เดือน)' }, d3MinGapDays: 56, d3MaxAge: 15 },
    8:  { d1: NOW,         d2: WITH('9m'),  d3: WITH('1y'),  cpgAlt: { d3: 'ช่วง 12–15 เดือน (เลือก 12 เดือน)' }, d3MinGapDays: 56, d3MaxAge: 15 },
    9:  { d1: WITH('9m'),  d2: AGE(10),     d3: WITH('1y'),  cpgAlt: { d3: 'ช่วง 12–15 เดือน (เลือก 12 เดือน)' }, d3MinGapDays: 56, d3MaxAge: 15 },
    10: { d1: NOW,         d2: WITH('1y'),  d3: AGE(15),     cpgAlt: { d2: 'หรืออายุ 11 เดือน (เดี่ยว)' }, d3MinGapDays: 56 },
    11: { d1: NOW,         d2: WITH('1y'),  d3: WITH('18m'), cpgAlt: { d3: 'ช่วง 15–18 เดือน (เลือก 18 เดือน)' }, d3MinGapDays: 56, d3MaxAge: 18 },
    12: { d1: WITH('1y'),  d2: GAP(8, 18),  d3: null,        cpgAlt: {} },
    13: { d1: NOW,         d2: GAP(8, 18),  d3: null,        cpgAlt: {} },
    14: { d1: NOW,         d2: GAP(8, 18),  d3: null,        cpgAlt: {} },
    15: { d1: NOW,         d2: WITH('18m'), d3: null,        cpgAlt: { d2: 'หรือห่างเข็ม 1 อย่างน้อย 8 สัปดาห์ (เดี่ยว)' } },
    16: { d1: NOW,         d2: WITH('18m'), d3: null,        cpgAlt: {} },
    17: { d1: NOW,         d2: GAP(8, 24),  d3: null,        cpgAlt: {} },
    18: { d1: WITH('18m'), d2: GAP(8, 24),  d3: null,        cpgAlt: {} },
  };
  for (let m = 19; m <= 23; m++) RULES[m] = { d1: NOW, d2: GAP(8), d3: null, cpgAlt: {} };

  // ---------- ตัวช่วยวันที่ (ตรงกับวิธีที่ index.html ใช้: setMonth / ตัดเวลา) ----------
  const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const maxDate = (a, b) => (a >= b ? a : b);
  /** อายุเป็นเดือนเต็ม ณ วันที่ at — เหมือน calculateDetailedAge ใน index.html */
  function ageMonths(birth, at) {
    let y = at.getFullYear() - birth.getFullYear(), m = at.getMonth() - birth.getMonth(), d = at.getDate() - birth.getDate();
    if (d < 0) m--;
    if (m < 0) { y--; m += 12; }
    return y * 12 + m;
  }
  /** ระยะห่างขั้นต่ำเข็ม 1→2 (วัน): เริ่มก่อน 12 เดือน = 4 สัปดาห์, เริ่ม 12–23 เดือน = 8 สัปดาห์ (หมายเหตุ CPG ข้อ 1–2) */
  const minGapDays = startM => (startM < 12 ? 28 : 56);

  function plan(opts) {
    const env = opts.env;
    const birth = day(opts.birth), visit = day(opts.visit);
    const hist = opts.history || {};
    const given1 = hist.dose1 ? day(hist.dose1) : null;
    const given2 = hist.dose2 ? day(hist.dose2) : null;
    // จำนวนเข็มที่ฉีดแล้ว: ระบุตรง ๆ (hist.count) หรือนับจากวันที่ที่กรอก (วิธีเดิม)
    const count = hist.count != null ? hist.count : (given2 ? 2 : given1 ? 1 : 0);

    const highRisk = !!opts.highRisk;   // เด็กกลุ่มเสี่ยงสูง → ดู HR_* ด้านบน
    const fail = (code, message) => ({ ok: false, code, message });
    if (isNaN(birth) || isNaN(visit)) return fail('bad-input', 'วันเกิดหรือวันที่มารับบริการไม่ถูกต้อง');
    if (visit < birth) return fail('bad-input', 'วันที่มารับบริการต้องไม่ก่อนวันเกิด');
    // เจ้าหน้าที่ระบุว่า "ครบแล้ว": ไม่ต้องนัด ไม่ตรวจอายุ/วันที่ย้อนหลัง
    if (hist.complete) return { ok: true, complete: true, startMonths: null, gapDays: null, doses: [], cpgAlt: {}, highRisk: highRisk ? { schedule: '3p+1', mode: 'complete', message: HR_COMPLETE } : null };
    if (!Number.isInteger(count) || count < 0 || count > 2) return fail('bad-history', 'จำนวนเข็มที่ฉีดแล้วต้องเป็น 0, 1 หรือ 2 (ครบแล้วให้เลือก "ครบแล้ว")');
    if (given2 && !given1) return fail('bad-history', 'ระบุวันที่เข็ม 2 แล้ว ต้องระบุวันที่เข็ม 1 ด้วย');
    if ((given1 && count < 1) || (given2 && count < 2)) return fail('bad-history', 'จำนวนเข็มไม่ตรงกับวันที่ที่กรอก');
    if (given1 && (given1 < birth || given1 > visit)) return fail('bad-history', 'วันที่เข็ม 1 ต้องอยู่ระหว่างวันเกิดกับวันที่มารับบริการ');
    if (given2 && (given2 <= given1 || given2 > visit)) return fail('bad-history', 'วันที่เข็ม 2 ต้องอยู่หลังเข็ม 1 และไม่เกินวันที่มารับบริการ');

    // อายุตอนฉีดเข็มแรก: มีวันที่เข็ม 1 → คำนวณจากวันที่ ไม่มี → ใช้อายุ (เดือน) ที่ระบุ
    const visitAgeM = ageMonths(birth, visit);
    let startM;
    if (count >= 1 && !given1) {
      const sa = hist.startAge;
      if (!Number.isInteger(sa) || sa < 0) return fail('bad-history', 'ระบุอายุตอนฉีดเข็มแรก (เดือน)');
      if (sa > visitAgeM) return fail('bad-history', 'อายุตอนฉีดเข็มแรกต้องไม่มากกว่าอายุปัจจุบัน');
      startM = sa;
    } else {
      startM = ageMonths(birth, given1 || visit);
    }
    if (startM < MIN_START_MONTHS) {
      return fail('too-young', 'อายุต่ำกว่า 2 เดือน ยังไม่ถึงเกณฑ์เริ่ม PCV (เริ่มเข็มแรกตอน 2 เดือน)');
    }
    if (startM > MAX_START_MONTHS) {
      return fail('too-old', 'อายุ 24 เดือนขึ้นไป: พิจารณาตามชนิดวัคซีนและช่วงอายุที่ได้รับการรับรอง (ไม่มีตารางให้คำนวณ)');
    }

    const rule = RULES[startM];
    const gapDays = minGapDays(startM);
    const hrStandard = highRisk && startM <= 3;   // เริ่มทันชุดเบื้องต้นของสูตร 3p+1 → คำนวณครบ 4 เข็ม

    // หาวันของเข็มหนึ่ง โดยไม่ให้ก่อน notBefore
    function resolve(spec, notBefore, gapNote) {
      const warnings = [], notes = [];
      let date = null, visitCode = null, fellBack = false;
      if (spec.how === 'with') {
        const list = [spec.visit].concat(spec.fallback ? [spec.fallback] : []);
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          const natural = addMonths(birth, VISIT_AGE[v]);
          const from = maxDate(natural, notBefore);
          const found = env.findDate(from, env.weeksFor(v));
          if (!found) continue;
          const beyondBand = ageMonths(birth, found) >= VISIT_BAND_END[v];
          if (beyondBand && i < list.length - 1) continue; // ลองทางสำรอง
          if (beyondBand) warnings.push('เด็กอายุเลยช่วงของรอบนี้แล้ว — ตรวจสอบกับแพทย์/พยาบาลก่อนนัด');
          date = found; visitCode = v; fellBack = i > 0;
          if (gapNote && notBefore > natural) notes.push(gapNote);
          break;
        }
      } else if (spec.how === 'age') {
        const natural = addMonths(birth, spec.months);
        date = env.findDate(maxDate(natural, notBefore), env.pcvWeeks);
        if (date && gapNote && notBefore > natural) notes.push(gapNote);
      } else if (spec.how === 'gap') {
        date = env.findDate(notBefore, env.pcvWeeks);
      }
      return { date, visitCode, fellBack, notes, warnings };
    }

    // เข็มที่ต้องกำหนดวัน (n = 2 หรือ 3)
    function schedule(n, spec, notBefore, gapNote) {
      let r = resolve(spec, notBefore, gapNote);
      let state = 'planned';
      // เข็มที่ "ไปพร้อมรอบ" และวันที่มารับบริการอยู่ในช่วงอายุของรอบนั้นอยู่แล้ว (เช่น อายุ 12–<18 เดือน = รอบ 1 ปี)
      // → ถือว่าถึงกำหนดวันนี้ พร้อมวัคซีนของรอบ เหมือนที่การ์ด "ต้องฉีดวันนี้" ถือกับวัคซีนอื่นของรอบ
      // (ไม่ดูว่าวันนี้เป็นสัปดาห์ที่คลินิกเปิดหรือไม่ — แอปเดิมก็ไม่ดูกับวัคซีนอื่น)
      const visitAge = ageMonths(birth, visit);
      const inBand = !!(spec.how === 'with' && r.visitCode && visitAge >= VISIT_AGE[r.visitCode] && visitAge < VISIT_BAND_END[r.visitCode]);
      // เด็กที่มีประวัติและเลยกำหนดแล้ว หรืออยู่ในช่วงอายุของรอบ → "ถึงกำหนดวันนี้" ถ้าห่างเข็มก่อนเพียงพอ
      let keepRound = false;
      if (count >= 1 && r.date && (r.date <= visit || inBand) && notBefore <= visit) {
        r.date = visit; state = 'due'; r.fellBack = r.fellBack && inBand;
        if (inBand) keepRound = true; else r.visitCode = null;
        r.notes.push('ถึงกำหนดแล้ว ฉีดได้ในวันที่มารับบริการ');
        // ล่าช้ากว่าอายุที่ตารางกำหนดไว้มาก → เตือนให้แพทย์พิจารณา (CPG ไม่ได้ระบุกรณีล่าช้าระหว่างทาง ผู้ใช้ให้เตือน)
        const target = spec.how === 'with' ? VISIT_AGE[spec.visit] : spec.how === 'age' ? spec.months : startM + Math.round(spec.weeks / 4.345);
        const late = visitAge - target;
        if (late >= LATE_WARN_MONTHS) r.warnings.push('ล่าช้ากว่ากำหนดประมาณ ' + late + ' เดือน (ตามตารางควรได้เมื่ออายุ ' + target + ' เดือน) — ให้แพทย์พิจารณาก่อนฉีด');
      }
      if (!r.date) return { n, state: 'unavailable', date: null, warnings: ['หาวันให้บริการไม่พบ — ตรวจสอบตารางสัปดาห์/วันหยุด'].concat(r.warnings), notes: r.notes };
      // เพดานอายุของ CPG (เช่น "ไม่ควรเกิน 18 เดือน") ตรวจกับวันสุดท้ายที่เลือกจริง รวมกรณี "ถึงกำหนดวันนี้"
      // นับอายุเป็น "เดือนเต็ม" แบบเดียวกับกลุ่มอายุของแอป (18 เดือน 29 วัน ยังถือว่าอายุ 18 เดือน ไม่เตือน — เตือนตั้งแต่ 19 เดือนขึ้นไป)
      if (spec.how === 'gap' && spec.maxAge && ageMonths(birth, r.date) > spec.maxAge) {
        r.warnings.push('เกินอายุ ' + spec.maxAge + ' เดือนที่ CPG แนะนำ — ตรวจสอบก่อนฉีด/นัด');
      }
      // "ถึงกำหนดวันนี้" = ฉีดวันที่มารับบริการเลย ไม่ผูกกับรอบวัคซีนอื่น/ช่วงเช้า (วันนี้อาจไม่ใช่วันของรอบนั้น)
      const withRound = spec.how === 'with' && (state !== 'due' || keepRound);
      return {
        n, state, date: r.date, withVisit: withRound ? r.visitCode : null, fellBack: r.fellBack,
        label: withRound ? VISIT_LABEL[r.visitCode] : null,
        // PCV เดี่ยว ๆ (ไม่ไปพร้อมวัคซีนอื่น): วันพุธใดก็ได้ ช่วงเช้า
        session: (spec.how === 'with' || state === 'due') ? null : 'เช้า',
        warnings: r.warnings, notes: r.notes,
      };
    }

    const doses = [];
    // เข็ม 1
    if (count >= 1) doses.push({ n: 1, state: 'given', date: given1, warnings: [], notes: [] }); // date = null ถ้าไม่ได้กรอกวันที่
    else doses.push({
      n: 1, state: 'today', date: visit, withVisit: rule.d1.how === 'with' ? rule.d1.visit : null,
      label: rule.d1.how === 'with' ? VISIT_LABEL[rule.d1.visit] : null, warnings: [], notes: [],
    });
    // เข็ม 2
    if (count >= 2) doses.push({ n: 2, state: 'given', date: given2, warnings: [], notes: [] });
    else {
      // ไม่รู้วันที่เข็ม 1 → ไม่บังคับระยะห่าง (notBefore = วันเกิด) แล้วแจ้งว่าไม่ได้ตรวจ
      const notBefore2 = doses[0].date ? addDays(doses[0].date, gapDays) : birth;
      const d2 = schedule(2, rule.d2, notBefore2,
        'ปรับวันให้ห่างจากเข็ม 1 อย่างน้อย ' + (gapDays / 7) + ' สัปดาห์');
      // เริ่มก่อน 12 เดือน: ถ้าห่างเข็ม 1 < 8 สัปดาห์ = ใช้ "กรณีจำเป็นต้องลดระยะห่าง (≥ 4 สัปดาห์)" ตามหมายเหตุข้อ 1 ของ CPG / WHO — แจ้งให้เห็น ไม่ใช่ข้อผิดพลาด
      if (d2.date && doses[0].date && startM < 12) {
        const gapDaysActual = Math.round((d2.date - doses[0].date) / 86400000);
        if (gapDaysActual < 56) {
          d2.notes.push('ใช้ระยะห่างที่ลดลง (ขั้นต่ำ 4 สัปดาห์) ตามหมายเหตุข้อ 1 ของ CPG / WHO กรณีจำเป็นต้องลดระยะห่าง');   // ตัวเลขสัปดาห์ UI แสดงเป็นการ์ดแยก
        }
      }
      doses.push(d2);
    }
    // เข็ม 3 (booster) — มีเฉพาะผู้เริ่มก่อน 12 เดือน
    if (rule.d3) {
      const prev = doses[1];
      const prevUndated = prev.state === 'given' && !prev.date; // เข็ม 2 ฉีดแล้วแต่ไม่ทราบวันที่
      if (prev.date || prevUndated) {
        const minGap = rule.d3MinGapDays || 1; // 1 = แค่ให้เรียงลำดับ (CPG ไม่กำหนดระยะห่างของ booster ในกลุ่มที่เริ่ม 2–6 เดือน)
        const d3 = schedule(3, rule.d3, prevUndated ? birth : addDays(prev.date, minGap),
          rule.d3MinGapDays ? 'ปรับวันให้ห่างจากเข็ม 2 อย่างน้อย 8 สัปดาห์' + (startM >= 7 ? ' (CPG/WHO: เริ่ม PCV 7–11 เดือน)' : '') : null);
        if (d3.date && rule.d3MaxAge && ageMonths(birth, d3.date) > rule.d3MaxAge) {
          d3.warnings.push('booster เลยช่วงอายุ ' + rule.d3MaxAge + ' เดือนที่ CPG ให้ — ตรวจสอบก่อนนัด');
        }
        doses.push(d3);
      }
      else doses.push({ n: 3, state: 'unavailable', date: null, warnings: ['ยังกำหนดเข็ม 2 ไม่ได้'], notes: [] });
    }

    // สูตร 3p+1 (กลุ่มเสี่ยงสูง เริ่ม 2–3 เดือน): เข็ม 1 ตามเดิม แล้วสร้างเข็ม 2 (รอบ 4 เดือน) เข็ม 3 (รอบ 6 เดือน) เข็ม 4 = กระตุ้น (รอบ 1 ปี พร้อม LAJE1)
    // ระยะห่างขั้นต่ำ: ชุดเบื้องต้น 4 สัปดาห์ (CPG: แนะนำ 8 สัปดาห์ ลดได้ถึง 4) · เข็มกระตุ้นห่างเข็ม 3 อย่างน้อย 8 สัปดาห์ (ตามที่ใช้กับสูตรปกติ — CPG ไม่ได้กำหนดสำหรับ 3p+1)
    if (hrStandard) {
      doses.length = 1;
      const hrSpecs = { 2: WITH('4m'), 3: WITH('6m'), 4: WITH('1y') };
      for (let n = 2; n <= 4; n++) {
        if (n <= count) { doses.push({ n, state: 'given', date: n === 2 ? given2 : null, warnings: [], notes: [] }); continue; }
        const prev = doses[n - 2], prevUndated = prev.state === 'given' && !prev.date;
        if (!prev.date && !prevUndated) { doses.push({ n, state: 'unavailable', date: null, warnings: ['ยังกำหนดเข็มก่อนหน้าไม่ได้'], notes: [] }); continue; }
        const gap = n < 4 ? 28 : 56;
        const dn = schedule(n, hrSpecs[n], prevUndated ? birth : addDays(prev.date, gap), 'ปรับวันให้ห่างจากเข็ม ' + (n - 1) + ' อย่างน้อย ' + (gap / 7) + ' สัปดาห์');
        if (n === 4 && dn.date && ageMonths(birth, dn.date) > 15) dn.warnings.push('เข็มกระตุ้นเลยช่วงอายุ 12–15 เดือนที่ CPG ให้ (สูตร 3p+1) — ตรวจสอบก่อนนัด');
        doses.push(dn);
      }
    }

    // เข็มก่อนหน้าฉีดแล้วแต่ไม่ทราบวันที่ → เข็มถัดไป (เข็มแรกที่ยังไม่ฉีด) ไม่ได้ตรวจระยะห่าง แจ้งให้เห็น
    let unverifiedGap = false;
    const nextIdx = doses.findIndex(d => d.state !== 'given');
    if (nextIdx > 0 && doses[nextIdx - 1].state === 'given' && !doses[nextIdx - 1].date) {
      unverifiedGap = true;
      doses[nextIdx].notes.push('ไม่ได้ตรวจระยะห่างจากเข็มก่อน (ไม่ได้ระบุวันที่ฉีด)');
    }
    // เข็มที่ตกตอนอายุ ≥ 24 เดือน (ตาราง CPG ครอบคลุมถึง 23 เดือน) → เตือนให้ปรึกษาแพทย์ (ผู้ใช้สั่ง 3 พ.ย. 2569)
    // ยกเว้นเข็ม 2 ของผู้เริ่ม 19–23 เดือน (แถว "ห่าง ≥ 8 สัปดาห์ ไม่มีเพดาน" ซึ่งตกหลัง 24 เดือนโดยธรรมชาติ ผู้ใช้สั่งไม่เตือน)
    // และไม่เตือนซ้ำถ้าเข็มนั้นมีคำเตือนอื่นอยู่แล้ว (เกินเพดาน/เลยช่วงรอบ/ล่าช้ามาก)
    const exemptD2 = !hrStandard && rule.d2.how === 'gap' && !rule.d2.maxAge;
    // วัคซีนของแผนงาน (ตอนนี้ SII PNEUMOSIL รับรอง 6 สัปดาห์ถึงก่อนครบ 2 ปี) — เข็มที่ตกตอนอายุ ≥ อายุสูงสุดที่รับรอง "ใช้วัคซีนนี้ไม่ได้"
    // (แนวทางปีงบ 2570 หน้า 7: เด็กเริ่ม 1 ปี 11 เดือน เข็ม 2 ห่าง ≥ 8 สัปดาห์ แต่ไม่ควรให้ PNEUMOSIL) ผู้ใช้ยืนยัน 14 พ.ย. 2569
    // เด็กยังต้องได้ครบจำนวนเข็ม → ยังแสดงวันที่เร็วที่สุดที่ทำได้ พร้อมคำเตือนให้ใช้ PCV ชนิดอื่นนอกแผนงานหรือปรึกษาแพทย์
    // เปลี่ยนวัคซีนของแผนงานในอนาคต → ตั้ง env.product = { name, maxAgeMonths } (ไม่ต้องแก้กฎ)
    const prod = env.product || {};
    const prodName = prod.name || DEFAULT_PRODUCT.name;
    const prodMax = Number.isFinite(prod.maxAgeMonths) ? prod.maxAgeMonths : DEFAULT_PRODUCT.maxAgeMonths;
    const prodAdvice = prod.advice || DEFAULT_PRODUCT.advice;
    doses.forEach(d => {
      if (d.state === 'given' || !d.date) return;
      if (ageMonths(birth, d.date) >= prodMax) {
        d.productBlocked = true;
        d.warnings = d.warnings.filter(w => !w.startsWith('เข็มนี้ตกตอนอายุ ≥ 24 เดือน'));   // ใช้ข้อความเฉพาะเรื่องวัคซีนแทน ไม่ซ้อนกัน
        d.warnings.push('เข็มนี้ตกตอนอายุ ≥ ' + prodMax + ' เดือน — วัคซีน ' + prodName + ' ของแผนงานรับรองให้ใช้ก่อนอายุ ' + prodMax + ' เดือนเท่านั้น จึงให้เข็มนี้ด้วยวัคซีนนี้ไม่ได้ — ' + prodAdvice + ' · เด็กยังต้องได้ครบจำนวนเข็ม');
        return;
      }
      if (d.n === 2 && exemptD2) return;
      if (ageMonths(birth, d.date) >= 24 && !d.warnings.length) d.warnings.push('เข็มนี้ตกตอนอายุ ≥ 24 เดือน (ตาราง CPG ครอบคลุมถึง 23 เดือน) — ปรึกษาแพทย์ก่อนฉีดหรือนัด');
    });
    const hrMode = !highRisk ? null : (hrStandard ? 'standard' : 'specialist');
    // กลุ่มเสี่ยงสูงที่ไม่มีตาราง 3p+1 ให้คำนวณ: ไม่บอกว่า "ครบ" เองเด็ดขาด (แผนปกติ 2p+1 อาจไม่พอ) ต้องให้กุมารแพทย์ตัดสิน
    const complete = hrMode === 'specialist' ? false : !doses.some(d => d.state !== 'given');
    return {
      ok: true, complete, unverifiedGap, startMonths: startM, gapDays, doses, cpgAlt: hrStandard ? {} : rule.cpgAlt,
      highRisk: hrMode ? { schedule: '3p+1', mode: hrMode, message: hrMode === 'standard' ? HR_STANDARD : HR_SPECIALIST } : null,
    };
  }

  return { RULES, VISIT_AGE, VISIT_LABEL, VISIT_BAND_END, MIN_START_MONTHS, MAX_START_MONTHS, LATE_WARN_MONTHS, DEFAULT_PRODUCT, minGapDays, ageMonths, plan };
});
