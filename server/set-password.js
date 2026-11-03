'use strict';
// Set/change the admin password. Run on the server:  node set-password.js   (inside an interactive terminal)
// Typing shows one * per character. The password is stored only as a scrypt hash in data/admin.json (mode 600).
// Automated test: echo "pw" | node set-password.js --stdin
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function save(pw) {
  if (pw.length < 10) { console.error('Password must be at least 10 characters. Nothing was saved.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  const file = path.join(DATA_DIR, 'admin.json');
  fs.writeFileSync(file, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex'), algo: 'scrypt', setAt: new Date().toISOString() }), { mode: 0o600 });
  console.log('OK: admin password saved (effective immediately, no restart needed).');
}

const CR = String.fromCharCode(13), LF = String.fromCharCode(10), CTRL_C = String.fromCharCode(3);
const DEL = String.fromCharCode(127), BS = String.fromCharCode(8);

function askHidden(q) {
  // Raw-mode reader: prints one * per typed character so you can see that typing works.
  return new Promise(resolve => {
    let buf = '';
    process.stdout.write(q);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const finish = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(LF);
      resolve(buf);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === CR || ch === LF) return finish();
        if (ch === CTRL_C) { process.stdout.write(LF + 'Cancelled.' + LF); process.exit(1); }
        if (ch === DEL || ch === BS) { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write(BS + ' ' + BS); } continue; }
        if (ch < ' ') continue;
        buf += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

(async () => {
  if (process.argv.includes('--stdin')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return save(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, ''));
  }
  if (!process.stdin.isTTY) { console.error('Run this in an interactive terminal.'); process.exit(1); }
  const a = await askHidden('New admin password (min 10 chars, shows * while typing): ');
  const b = await askHidden('Type it again: ');
  if (a !== b) { console.error('Passwords do not match. Nothing was saved.'); process.exit(1); }
  save(a);
})();
