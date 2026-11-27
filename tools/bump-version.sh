#!/usr/bin/env bash
# อัปเดตเลขเวอร์ชันทุกจุด เพื่อให้เครื่องผู้ใช้รีเฟรชเป็นเวอร์ชันใหม่อัตโนมัติ
# ใช้: bash tools/bump-version.sh   (รันจากโฟลเดอร์หลักของ repo ก่อน commit)
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(date +%Y.%m.%d-%H%M)
sed -i -E "s/const APP_VERSION = '[^']*'/const APP_VERSION = '$V'/" assets/app.js
sed -i -E "s/\?v=[0-9.]+-[0-9]+/?v=$V/g" index.html
printf '{ "version": "%s" }\n' "$V" > version.json
echo "version -> $V"
