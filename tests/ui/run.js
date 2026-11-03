'use strict';
/**
 * รันชุดทดสอบหน้าเว็บ (เบราว์เซอร์แบบไม่มีหน้าจอ) — ไม่ต้องติดตั้งแพ็กเกจเพิ่ม ต้องมี Google Chrome หรือ Microsoft Edge ในเครื่อง
 *
 *   node tests/ui/run.js                 กวาดเร็ว (~2,200 กรณี)
 *   node tests/ui/run.js --full          กวาดละเอียด (~10,000 กรณี ใช้เวลาหลายนาที)
 *   node tests/ui/run.js --mobile        ทดสอบที่ความกว้างมือถือ (390 พิกเซล)
 *   CHROME_PATH="C:\path\to\chrome.exe" node tests/ui/run.js    ระบุตัวเบราว์เซอร์เอง
 *
 * ทำงาน: เปิดเว็บเซิร์ฟเวอร์ชั่วคราวที่เสิร์ฟโฟลเดอร์โปรเจกต์ → เปิด tests/ui/harness.html ในเบราว์เซอร์ → อ่านผลที่ harness เขียนลงหน้า
 * exit code 0 = ผ่านทั้งหมด, 1 = มีข้อผิดพลาด, 2 = ไม่พบเบราว์เซอร์/รันไม่สำเร็จ
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const FULL = args.includes('--full'), MOBILE = args.includes('--mobile');
const STEP = FULL ? 3 : 11, WIDTH = MOBILE ? 390 : 1000;

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = CANDIDATES.find(p => fs.existsSync(p));
if (!chrome) { console.error('ไม่พบ Chrome/Edge — ตั้งค่า CHROME_PATH ให้ชี้ไปที่ตัวเบราว์เซอร์'); process.exit(2); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const file = u === '/__ui/harness.html' ? path.join(__dirname, 'harness.html') : path.join(ROOT, u);
  if (!file.startsWith(ROOT) && file !== path.join(__dirname, 'harness.html')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-ui-'));
  const url = `http://127.0.0.1:${port}/__ui/harness.html?step=${STEP}&width=${WIDTH}`;
  console.log(`เบราว์เซอร์: ${chrome}\nโหมด: ${FULL ? 'ละเอียด' : 'เร็ว'}${MOBILE ? ' + มือถือ' : ''} (step=${STEP}, width=${WIDTH})\nกำลังรัน...`);
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`,
    `--virtual-time-budget=${FULL ? 400000 : 200000}`, '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const timer = setTimeout(() => child.kill(), FULL ? 900000 : 400000);
  child.on('close', () => {
    clearTimeout(timer); server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ลบไม่ได้ก็ข้าม */ }
    const m = out.match(/<pre id="result">([\s\S]*?)<\/pre>/);
    if (!m) { console.error('ไม่ได้รับผลจากเบราว์เซอร์ (หมดเวลา หรือหน้าเว็บพัง)'); process.exit(2); }
    const json = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    let r; try { r = JSON.parse(json); } catch (e) { console.error('อ่านผลไม่ได้: ' + json.slice(0, 300)); process.exit(2); }
    if (!r.done) { console.error('ชุดทดสอบทำงานไม่จบ: ' + json.slice(0, 300)); process.exit(2); }
    console.log('\nสถิติ:', JSON.stringify(r.stats));
    if (r.failures.length) {
      console.log(`\n❌ พบข้อผิดพลาด ${r.failures.length}+ รายการ (แสดงสูงสุด 60):`);
      r.failures.forEach(f => console.log(' - ' + f));
      process.exit(1);
    }
    console.log('\n✅ ผ่านทั้งหมด');
    process.exit(0);
  });
});
