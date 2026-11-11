#!/usr/bin/env bash
# JARVIS 起動: ホストの bridge + Docker(backend/frontend)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
  sed -i.bak "s/^BRIDGE_TOKEN=.*/BRIDGE_TOKEN=${TOKEN}/" .env && rm -f .env.bak
  chmod 600 .env
  echo "✔ .env を生成しました (トークン自動生成)"
fi
set -a; . ./.env; set +a
export BRIDGE_WORKDIR="${BRIDGE_WORKDIR/#\~/$HOME}"

# 既存の bridge を止めて起動し直す
if [ -f bridge/bridge.pid ] && kill -0 "$(cat bridge/bridge.pid)" 2>/dev/null; then
  kill "$(cat bridge/bridge.pid)" || true; sleep 0.5
fi
echo "▶ bridge 起動 (ホスト: ${BRIDGE_HOST}:${BRIDGE_PORT})"
nohup python3 bridge/bridge.py > bridge/bridge.log 2>&1 &
echo $! > bridge/bridge.pid
for _ in $(seq 1 20); do
  curl -fs -H "Authorization: Bearer ${BRIDGE_TOKEN}" "http://127.0.0.1:${BRIDGE_PORT}/providers" >/dev/null && break
  sleep 0.3
done || { echo "bridge が起動しません: bridge/bridge.log を確認"; exit 1; }

echo "▶ Docker 起動"
docker compose up -d --build

echo "▶ バックエンドの起動待ち…"
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null && break
  sleep 1
done || echo "⚠ バックエンドが応答しません: docker compose logs backend を確認"

URL="http://localhost:${WEB_PORT}"
echo "✔ JARVIS: ${URL}  (停止は ./stop.sh)"
if command -v open >/dev/null; then open "$URL"; elif command -v xdg-open >/dev/null; then xdg-open "$URL"; fi
