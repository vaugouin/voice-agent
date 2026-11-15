#!/usr/bin/env bash
# Owner instance of voice-agent (/voice-agent/, behind basic auth). The demo is restart-demo.sh.
# Returns once the container is started, with its last log lines (2026-11-15): follow them with
# docker logs -f voice-agent when needed.
docker ps --filter "name=voice-agent"

docker stop voice-agent

cd /home/debian/docker/voice-agent

docker build -t voice-agent:latest .

docker rm -f voice-agent 2>/dev/null || true

docker run -d \
  --name voice-agent \
  --restart unless-stopped \
  --network reverseproxy \
  --env-file /home/debian/docker/voice-agent/.env \
  -v /home/debian/docker/voice-agent/logs:/app/logs \
  voice-agent:latest

sleep 3
docker logs --tail 20 voice-agent
