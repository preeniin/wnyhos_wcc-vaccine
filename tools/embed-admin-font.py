# -*- coding: utf-8 -*-
"""ฝังฟอนต์ TH Sarabun New (ตัวปกติ + ตัวหนา) ลงใน server/admin.html แบบย่อเฉพาะอักษรไทย + ละติน (woff2 base64)
ใช้เมื่อต้องการเปลี่ยน/อัปเดตฟอนต์ของหน้าแอดมิน (หน้าที่ฝังแล้วไม่ต้องรันซ้ำ)

  pip install fonttools brotli
  python tools/embed-admin-font.py                       # ใช้ฟอนต์ที่ติดตั้งในเครื่อง (C:\\Windows\\Fonts)
  python tools/embed-admin-font.py <regular.ttf> <bold.ttf>

จะแทนข้อความระหว่าง  /*FONT-START*/ ... /*FONT-END*/  ใน server/admin.html
ก่อนใช้ฟอนต์นี้ในงานจริง ตรวจเงื่อนไขการใช้งาน/แจกจ่ายฟอนต์ TH Sarabun New ด้วย (ผู้เผยแพร่: สำนักงานส่งเสริมเศรษฐกิจดิจิทัล / SIPA)
"""
import base64, io, os, re, sys
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ADMIN = os.path.join(ROOT, 'server', 'admin.html')
FONTS = r'C:\Windows\Fonts'
reg = sys.argv[1] if len(sys.argv) > 2 else os.path.join(FONTS, 'THSarabunNew.ttf')
bold = sys.argv[2] if len(sys.argv) > 2 else os.path.join(FONTS, 'THSarabunNew Bold.ttf')

# อักษรที่หน้าแอดมินใช้: ละติน/ตัวเลข, ไทย, เครื่องหมายทั่วไป (· … – — ' " • ← → ↑ ↓ ½)
UNICODES = list(range(0x20, 0x7F)) + [0xA0, 0xB7, 0xBD] + list(range(0x0E00, 0x0E80)) + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2190, 0x2191, 0x2192, 0x2193]

def woff2_b64(path):
    opts = subset.Options(); opts.flavor = 'woff2'; opts.layout_features = ['*']; opts.notdef_outline = True
    f = TTFont(path)
    s = subset.Subsetter(opts); s.populate(unicodes=UNICODES); s.subset(f)
    f.flavor = 'woff2'
    buf = io.BytesIO(); f.save(buf)
    return base64.b64encode(buf.getvalue()).decode('ascii'), len(buf.getvalue())

css = ''
for path, weight in ((reg, 400), (bold, 700)):
    b64, n = woff2_b64(path)
    print(f'{os.path.basename(path)} -> {n} bytes (woff2)')
    css += f"@font-face{{font-family:'TH Sarabun New';font-style:normal;font-weight:{weight};font-display:swap;src:url(data:font/woff2;base64,{b64}) format('woff2')}}\n"

html = open(ADMIN, encoding='utf-8').read()
new, k = re.subn(r'/\*FONT-START\*/.*?/\*FONT-END\*/', lambda m: '/*FONT-START*/\n' + css + '/*FONT-END*/', html, flags=re.S)
if k != 1: sys.exit('ไม่พบเครื่องหมาย /*FONT-START*/ ... /*FONT-END*/ ใน server/admin.html')
open(ADMIN, 'w', encoding='utf-8', newline='').write(new)
print('อัปเดต server/admin.html แล้ว')
