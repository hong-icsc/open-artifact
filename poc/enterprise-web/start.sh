#!/usr/bin/env bash
# 啟動 POC 三個服務：模擬 SSO(4910)、Open Artifact Site(4900)、Agent 平台(4920)
set -e
cd "$(dirname "$0")/../.."
export OA_DATA_DIR="${OA_DATA_DIR:-$PWD/poc/enterprise-web/.data}"
export NODE_OPTIONS=--disable-warning=ExperimentalWarning
export OA_AUTH='[{"kind":"owner-key"},{"kind":"oidc","id":"sso","name":"公司 SSO","issuer":"http://localhost:4910","clientId":"open-artifact","clientSecret":"poc-secret","scopes":["openid","email","profile","groups"]}]'
export OA_SIGNUP='domain:corp.example'
export OA_PUBLIC_ACCESS=false
export OA_OAUTH_CLIENTS='[{"client_id":"enterprise-agent-platform","client_name":"企業 AI Agent 平台","redirect_uris":["http://127.0.0.1:4920/callback"]}]'
mkdir -p "$OA_DATA_DIR" poc/enterprise-web/logs
node poc/enterprise-web/mock-sso.mjs > poc/enterprise-web/logs/sso.log 2>&1 &
node packages/host/src/node/main.ts serve > poc/enterprise-web/logs/site.log 2>&1 &
node poc/enterprise-web/platform.mjs > poc/enterprise-web/logs/platform.log 2>&1 &
wait
