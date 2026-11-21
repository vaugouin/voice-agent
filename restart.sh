#!/usr/bin/env bash
# Owner instance of voice-agent (/voice-agent/, behind basic auth). The demo is restart-demo.sh.
# Returns once the container is started, with its last log lines (2026-11-15): follow them with
# docker logs -f voice-agent when needed.
docker ps --filter "name=voice-agent"

docker stop voice-agent

cd /home/debian/docker/voice-agent

docker build -t voice-agent:latest .

docker rm -f voice-agent 2>/dev/null || true

# VOICE-AGENT-280: runtime/text2sql-url holds the API base URL, re-read on every call, so the
# API instance is switched by editing that file, with no restart. Seeded once from the .env.
mkdir -p runtime
if [[ ! -s runtime/text2sql-url ]]; then
  grep -E '^TEXT2SQL_BASE_URL=' .env | tail -n 1 | cut -d= -f2- > runtime/text2sql-url
fi

docker run -d \
  --name voice-agent \
  --restart unless-stopped \
  --network reverseproxy \
  --env-file /home/debian/docker/voice-agent/.env \
  -v /home/debian/docker/voice-agent/logs:/app/logs \
  -v /home/debian/docker/voice-agent/runtime:/app/runtime:ro \
  -e TEXT2SQL_BASE_URL_FILE=/app/runtime/text2sql-url \
  voice-agent:latest

sleep 3
docker logs --tail 20 voice-agent
