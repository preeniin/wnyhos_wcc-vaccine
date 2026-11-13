'use strict';
// รัน:  node --test tests/offline.test.js
// กันไม่ให้หน้าเว็บกลับไปพึ่งอินเทอร์เน็ต และกัน CSS ที่ฝังไว้ล้าสมัย (ลืมรัน tools/offline-build/build.js หลังเพิ่มคลาส Tailwind)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const noEmbedded = html.replace(/<!-- offline-assets:begin[\s\S]*?<!-- offline-assets:end -->/, '');

test('index.html ไม่โหลดอะไรจากภายนอก (script/link/@import/รูป/ฟอนต์/fetch ไปโฮสต์อื่น)', () => {
  const bad = [];
  for (const m of html.matchAll(/<(script|link|img|iframe|source)\b[^>]*\b(?:src|href)\s*=\s*["']\s*(https?:)?\/\//gi)) bad.push(m[0].slice(0, 90));
  for (const m of html.matchAll(/@import\s+(?:url\()?["']?https?:/gi)) bad.push(m[0]);
  for (const m of html.matchAll(/url\(\s*["']?https?:/gi)) bad.push(m[0]);
  for (const m of html.matchAll(/\bfetch\(\s*['"`]https?:/gi)) bad.push(m[0]);
  assert.deepEqual(bad, [], 'พบการโหลดจากภายนอก — ต้องใช้ได้โดยไม่มีอินเทอร์เน็ต');
  assert.doesNotMatch(html, /docs\.google\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com/);
});

test('มี CSS และฟอนต์ฝังอยู่ในไฟล์ (index.html ไฟล์เดียวพอ เพราะสคริปต์ deploy คัดลอกแค่ 3 ไฟล์)', () => {
  assert.match(html, /<style id="wcc-offline-fonts">/);
  assert.match(html, /<style id="wcc-offline-tailwind">/);
  assert.match(html, /font-family:'Sarabun'[^}]*font-weight:700/);
  assert.ok(noEmbedded.length < html.length);
});

test('CSS ที่ฝังตรงกับคลาสที่ใช้ใน index.html ปัจจุบัน (ไม่ล้าสมัย)', (t) => {
  const tool = path.join(ROOT, 'tools', 'offline-build');
  if (!fs.existsSync(path.join(tool, 'node_modules', 'tailwindcss'))) return t.skip('ยังไม่ได้ npm install ใน tools/offline-build (ข้ามการตรวจนี้)');
  try { execFileSync(process.execPath, [path.join(tool, 'build.js'), '--check'], { stdio: 'pipe' }); }
  catch (e) { assert.fail('CSS ที่ฝังล้าสมัย → รัน: node tools/offline-build/build.js\n' + (e.stderr || e.stdout || '')); }
});
