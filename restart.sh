#!/usr/bin/env bash
# Owner instance of voice-agent (/voice-agent/, behind basic auth). The demo is restart-demo.sh.
# Builds the image while the current container keeps serving, then swaps containers with no gap
# for the visitors (swap-container.sh says how). Returns with the new container's last log lines:
# follow them with docker logs -f voice-agent when needed.
set -euo pipefail

DIR=/home/debian/docker/voice-agent
cd "$DIR"
source "$DIR/swap-container.sh"

docker build -t voice-agent:latest .

# VOICE-AGENT-280: runtime/text2sql-url holds the API base URL, re-read on every call, so the
# API instance is switched by editing that file, with no restart. Seeded once from the .env.
mkdir -p runtime
if [[ ! -s runtime/text2sql-url ]]; then
  grep -E '^TEXT2SQL_BASE_URL=' .env | tail -n 1 | cut -d= -f2- > runtime/text2sql-url
fi

swap_container voice-agent \
  --restart unless-stopped \
  --network reverseproxy \
  --env-file "$DIR/.env" \
  -v "$DIR/logs":/app/logs \
  -v "$DIR/runtime":/app/runtime:ro \
  -e TEXT2SQL_BASE_URL_FILE=/app/runtime/text2sql-url \
  voice-agent:latest
