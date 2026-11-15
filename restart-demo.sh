#!/usr/bin/env bash
# Bring-your-own-key demo instance (VOICE-AGENT-277), served by the reverse proxy on /voice-demo/.
#
# Same image as the owner instance (restart.sh builds it from this folder), a second container
# with its own env file and log folder. The env file is the owner's minus the OpenAI key, plus
# BYOK_REQUIRED=1: every OpenAI call is then paid with the visitor's key, typed in the page.
#
# First time, on the VPS:
#   cd /home/debian/docker/voice-agent
#   grep -v '^OPENAI_API_KEY=' .env > .env.demo && echo 'BYOK_REQUIRED=1' >> .env.demo
#   bash restart-demo.sh
set -euo pipefail

DIR=/home/debian/docker/voice-agent
ENV_FILE="$DIR/.env.demo"
LOG_DIR="$DIR/logs-demo"

cd "$DIR"

# The two mistakes that would make the owner pay for the visitors' questions.
if [[ ! -s "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE (see the head of this script)." >&2
  exit 1
fi
if ! grep -qE '^BYOK_REQUIRED=(1|true|yes|on)\s*$' "$ENV_FILE"; then
  echo "$ENV_FILE must contain BYOK_REQUIRED=1." >&2
  exit 1
fi
if grep -qE '^OPENAI_API_KEY=.+' "$ENV_FILE"; then
  echo "$ENV_FILE must not contain OPENAI_API_KEY (the demo runs on the visitor's key)." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

docker build -t voice-agent:latest .

docker rm -f voice-agent-demo 2>/dev/null || true

docker run -d \
  --name voice-agent-demo \
  --restart unless-stopped \
  --network reverseproxy \
  --env-file "$ENV_FILE" \
  -v "$LOG_DIR":/app/logs \
  voice-agent:latest

docker logs --tail 20 voice-agent-demo
