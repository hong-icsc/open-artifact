#!/usr/bin/env bash
# 從乾淨狀態跑完整 POC：清空資料 → 啟動三個服務 → 第一段（連接、建立、權限、快照）→ 第二段（回饋迴圈）
set -u
cd "$(dirname "$0")"
pkill -f 'poc/enterprise-web/(mock-sso|platform).mjs' 2>/dev/null
pkill -f 'packages/host/src/node/main.ts serve' 2>/dev/null
sleep 1
rm -rf .data logs shots
mkdir -p logs shots
./start.sh &
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:4900/__open-artifact/health && curl -s -o /dev/null http://127.0.0.1:4920/ && break; sleep 1; done
node run-poc.mjs
node site-login.mjs > /dev/null
node run-feedback.mjs
echo
node -e "const r=require('./shots/results.json');const f=r.filter(x=>!x.ok);console.log(\`合計 \${r.length} 項，通過 \${r.length-f.length}，失敗 \${f.length}\`);process.exit(f.length?1:0)"
status=$?
# 保留服務繼續跑可設 KEEP=1，方便手動用瀏覽器看
if [ "${KEEP:-0}" != 1 ]; then
  pkill -f 'poc/enterprise-web/(mock-sso|platform).mjs' 2>/dev/null
  pkill -f 'packages/host/src/node/main.ts serve' 2>/dev/null
fi
exit $status
