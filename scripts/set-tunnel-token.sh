#!/bin/sh
# ใส่ TUNNEL_TOKEN ลงใน .env โดยไม่ให้โทเคนแสดงบนจอหรือค้างในประวัติคำสั่ง
# ใช้: sh scripts/set-tunnel-token.sh   (วางได้ทั้งโทเคนเปล่าๆ หรือทั้งคำสั่ง "... --token xxxx" ที่ Cloudflare ให้มา)
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env

printf 'วางโทเคน Cloudflare Tunnel แล้วกด Enter (ตัวอักษรจะไม่แสดง): '
stty -echo 2>/dev/null || true
read -r token
stty echo 2>/dev/null || true
echo

token=$(printf '%s' "$token" | sed 's/.*--token[ =]*//' | tr -d ' \r\n')
case "$token" in
  '' | *[!A-Za-z0-9+/=_-]*) echo 'โทเคนไม่ถูกต้อง ไม่ได้บันทึก'; exit 1 ;;
esac

tmp=$(mktemp)
grep -v -e '^TUNNEL_TOKEN=' -e '^#* *COMPOSE_PROFILES=' .env > "$tmp" || true
printf 'COMPOSE_PROFILES=tunnel\nTUNNEL_TOKEN=%s\n' "$token" >> "$tmp"
mv "$tmp" .env
chmod 600 .env
echo 'บันทึกโทเคนใน .env แล้ว  เริ่ม tunnel ด้วย: docker compose up -d'
