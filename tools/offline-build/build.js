'use strict';
/**
 * สร้าง CSS (Tailwind) และฟอนต์ Sarabun แล้วฝังลงใน index.html เพื่อให้หน้าเว็บทำงานได้โดยไม่ต้องมีอินเทอร์เน็ต
 * (แทนที่ <script src="cdn.tailwindcss.com"> และ <link> ของ Google Fonts)
 *
 * ทำไมฝังในไฟล์เดียว: สคริปต์ deploy ของ IT คัดลอกเข้าเว็บเฉพาะ index.html / pcv-rules.js / admin.html เท่านั้น
 * ถ้าแยก css/ฟอนต์เป็นไฟล์ใหม่ หน้าเว็บจริงจะไม่มีสไตล์
 *
 * วิธีใช้ (ต้อง `npm install` ในโฟลเดอร์นี้ครั้งแรก):
 *   node build.js           สร้างใหม่แล้วเขียนลง index.html   ← ต้องรันทุกครั้งที่เพิ่ม/เปลี่ยนคลาส Tailwind ใน index.html
 *   node build.js --check   ตรวจว่า CSS ที่ฝังอยู่ตรงกับ index.html ปัจจุบัน (ไม่แก้ไฟล์) ; exit 1 ถ้าล้าสมัย
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const INDEX = path.join(HERE, '..', '..', 'index.html');
const BEGIN = '<!-- offline-assets:begin';
const END = '<!-- offline-assets:end -->';
const WEIGHTS = [400, 500, 700, 800];            // ใช้จริง: ปกติ 400, font-medium 500, font-bold 700, font-black 900 → ใกล้สุดคือ 800 (Sarabun ไม่มี 900)
const RANGES = {
  thai: 'U+0E01-0E5B,U+200C-200D,U+25CC',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};
const CHECK = process.argv.includes('--check');

let html = fs.readFileSync(INDEX, 'utf8');
const crlf = html.includes('\r\n');
html = html.replace(/\r\n/g, '\n');

// ตัดบล็อกที่ฝังไว้เดิมออกก่อนสแกนคลาส (ไม่งั้นสแกนเจอชื่อคลาสจาก CSS ที่เคยสร้าง วนซ้ำกันเอง)
const blockRe = new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const hadBlock = blockRe.test(html);
const source = html.replace(blockRe, '');

// ---- Tailwind ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-tw-'));
const srcFile = path.join(tmp, 'index.src.html');
fs.writeFileSync(srcFile, source);
fs.writeFileSync(path.join(tmp, 'in.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
fs.writeFileSync(path.join(tmp, 'tailwind.config.js'), `module.exports = { content: [${JSON.stringify(srcFile)}] };\n`);
const cli = path.join(HERE, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
if (!fs.existsSync(cli)) { console.error('ยังไม่ได้ติดตั้ง: รัน npm install ในโฟลเดอร์ tools/offline-build ก่อน'); process.exit(2); }
execFileSync(process.execPath, [cli, '-i', path.join(tmp, 'in.css'), '-o', path.join(tmp, 'out.css'), '-c', path.join(tmp, 'tailwind.config.js'), '--minify'], { stdio: ['ignore', 'ignore', 'pipe'] });
const tailwindCss = fs.readFileSync(path.join(tmp, 'out.css'), 'utf8').trim();

// ---- ฟอนต์ ----
const fontDir = path.join(HERE, 'node_modules', '@fontsource', 'sarabun', 'files');
let fontCss = '';
for (const subset of ['thai', 'latin']) {
  for (const w of WEIGHTS) {
    const b64 = fs.readFileSync(path.join(fontDir, `sarabun-${subset}-${w}-normal.woff2`)).toString('base64');
    fontCss += `@font-face{font-family:'Sarabun';font-style:normal;font-display:swap;font-weight:${w};src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${RANGES[subset]}}\n`;
  }
}

const block = `${BEGIN} (สร้างโดย tools/offline-build/build.js — อย่าแก้ด้วยมือ ถ้าเพิ่ม/เปลี่ยนคลาส Tailwind ให้รัน node build.js ใหม่) -->\n`
  + `<style id="wcc-offline-fonts">\n${fontCss}</style>\n<style id="wcc-offline-tailwind">\n${tailwindCss}\n</style>\n${END}`;

let out;
if (hadBlock) out = html.replace(blockRe, () => block);
else {
  const cdn = /[ \t]*<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\n/;
  const gf = /[ \t]*<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Sarabun[^"]*" rel="stylesheet">\n/;
  if (!cdn.test(html) || !gf.test(html)) { console.error('ไม่พบ CDN script/Google Fonts link ใน index.html (ไม่มีบล็อกที่ฝังไว้ด้วย)'); process.exit(2); }
  out = html.replace(gf, '').replace(cdn, () => block + '\n');
}

if (CHECK) {
  if (out === html) { console.log('OK: CSS/ฟอนต์ที่ฝังตรงกับ index.html ปัจจุบัน'); process.exit(0); }
  console.error('ล้าสมัย: index.html มีการเปลี่ยนคลาส Tailwind หลังสร้าง CSS ล่าสุด → รัน: node tools/offline-build/build.js'); process.exit(1);
}
fs.writeFileSync(INDEX, crlf ? out.replace(/\n/g, '\r\n') : out);
console.log(`ฝัง CSS ${(tailwindCss.length / 1024).toFixed(0)} KB + ฟอนต์ ${(fontCss.length / 1024).toFixed(0)} KB ลง index.html (รวมไฟล์ ${(out.length / 1024).toFixed(0)} KB)`);
fs.rmSync(tmp, { recursive: true, force: true });
