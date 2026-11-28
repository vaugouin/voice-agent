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

# VOICE-AGENT-280: runtime/text2sql-url-demo holds the API base URL of the demo, re-read on every
# call, so its API instance is switched by editing that file, with no restart. Seeded once.
mkdir -p "$DIR/runtime"
if [[ ! -s "$DIR/runtime/text2sql-url-demo" ]]; then
  grep -E '^TEXT2SQL_BASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- > "$DIR/runtime/text2sql-url-demo" || true
fi

docker build -t voice-agent:latest .

# No gap for the visitors: the current container serves until the new one answers (swap-container.sh).
source "$DIR/swap-container.sh"
swap_container voice-agent-demo \
  --restart unless-stopped \
  --network reverseproxy \
  --env-file "$ENV_FILE" \
  -v "$LOG_DIR":/app/logs \
  -v "$DIR/runtime":/app/runtime:ro \
  -e TEXT2SQL_BASE_URL_FILE=/app/runtime/text2sql-url-demo \
  voice-agent:latest
