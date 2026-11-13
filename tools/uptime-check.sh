#!/usr/bin/env bash
# ตรวจว่าเว็บนัดวัคซีน (WCC) ทำงานครบ — ออกแบบให้ IT ตั้งเวลารัน (cron/systemd timer) เช่นทุก 5 นาที แล้วส่งแจ้งเตือนเมื่อ exit code ≠ 0
#
#   tools/uptime-check.sh                          ตรวจที่ http://127.0.0.1:8100  (บน server โดยตรง)
#   tools/uptime-check.sh https://<โดเมนของเว็บ>    ตรวจผ่านโดเมนจริง (ผ่าน Cloudflare)
#
# exit 0 = ปกติ (พิมพ์ "OK ...")  ·  exit 1 = ผิดปกติ (พิมพ์ "FAIL: ..." บอกข้อที่ล้ม ทุกข้อ)
# ไม่มีการเขียนไฟล์/แก้ข้อมูลใด ๆ ใช้ได้เฉพาะ GET ที่เปิดสาธารณะ + ตรวจว่า API แอดมินยัง "ไม่" เปิดโล่ง
set -u
BASE="${1:-http://127.0.0.1:8100}"; BASE="${BASE%/}"
T=12   # timeout ต่อคำขอ (วินาที)
fails=()

get() { local c; c="$(curl -sS -m "$T" -o "$TMP" -w '%{http_code}' "$BASE$1" 2>/dev/null)" || true; echo "${c:-000}"; }   # curl ล้มเหลวจะพิมพ์ 000 เองอยู่แล้ว
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

expect() {  # expect <ชื่อ> <path> <http ที่คาด> [<ข้อความที่ต้องมีในเนื้อหา> ...]
  local name="$1" path="$2" want="$3"; shift 3
  local code; code="$(get "$path")"
  if [ "$code" != "$want" ]; then fails+=("$name: $path ตอบ $code (คาด $want)"); return; fi
  local needle
  for needle in "$@"; do grep -q -- "$needle" "$TMP" || fails+=("$name: เนื้อหาของ $path ไม่มี \"$needle\""); done
}

expect "healthz"        /healthz              200 '"ok":true'
expect "หน้าเว็บ"        /                     200 'id="appTitle"' 'wcc-offline-tailwind'   # มี CSS ฝังอยู่ = ใช้ได้โดยไม่ต้องมีอินเทอร์เน็ต
expect "ตัวคำนวณ PCV"   /pcv-rules.js        200 'PCV'
expect "ตารางวัคซีน"     /data/vaccines.csv    200 'AgeCode'
expect "วันหยุด"         /data/holidays.csv    200
expect "ข้อมูลคลินิก"    /data/settings.json   200 '"appTitle"'

# ตารางวัคซีนต้องมีข้อมูลจริง (ไม่ใช่มีแค่หัวตาราง)
lines="$(get /data/vaccines.csv >/dev/null; wc -l < "$TMP" | tr -d ' ')"
[ "${lines:-0}" -ge 2 ] || fails+=("ตารางวัคซีนว่าง (มี ${lines:-0} บรรทัด)")

# API แอดมินต้องไม่เปิดโล่งโดยไม่ login (คาด 401 ที่ server โดยตรง หรือ 302/403 เมื่อผ่าน Cloudflare Access) — 200 = ผิดปกติร้ายแรง
code="$(get /api/admin/store)"
case "$code" in 200) fails+=("ความปลอดภัย: /api/admin/store ตอบ 200 โดยไม่ login!");; 000) fails+=("API แอดมิน: เชื่อมต่อไม่ได้");; esac

if [ "${#fails[@]}" -eq 0 ]; then echo "OK $BASE ($(date '+%F %T'))"; exit 0; fi
echo "FAIL: $BASE ($(date '+%F %T'))"; printf ' - %s\n' "${fails[@]}"; exit 1
