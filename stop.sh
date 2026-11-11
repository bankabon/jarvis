#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose down
if [ -f bridge/bridge.pid ]; then kill "$(cat bridge/bridge.pid)" 2>/dev/null || true; rm -f bridge/bridge.pid; fi
echo "✔ 停止しました"
