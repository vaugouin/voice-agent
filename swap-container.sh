#!/usr/bin/env bash
# Replace a running voice-agent container with a new one, with no gap for the visitors.
# Sourced by restart.sh (owner, "voice-agent") and restart-demo.sh (demo, "voice-agent-demo").
#
# Why: the old restart.sh stopped the container before `docker build`, so the app was down for
# the whole build (seconds with Docker's cache, minutes when the base image moved). And even a
# build-first `docker rm -f` + `docker run` cut the requests in flight and left NGINX on the old
# address for up to 30 s (`resolver 127.0.0.11 valid=30s` in reverseproxy), hence 502s.
#
# How, once the image is built:
#   1. start the new container as <name>-next, on the same network, with the same options;
#   2. wait until it answers GET / on port 3000 (gives up after 90 s, keeps the old one running);
#   3. swap the names: <name> -> <name>-old, <name>-next -> <name>. Docker's DNS follows the
#      rename, so new lookups from NGINX get the new container;
#   4. wait 35 s, past NGINX's 30 s address cache, while the old container keeps serving;
#   5. stop the old one with a 120 s grace: uvicorn stops accepting, finishes the requests in
#      flight (the longest chain an upstream call at 60 s each), then exits.
# A voice conversation itself does not go through this server: the browser talks to OpenAI over
# WebRTC once /session has relayed the SDP offer, and the server keeps no per-conversation state
# (each tool call carries what it needs). Conversations in progress therefore carry on, and their
# next tool call simply reaches the new container.
#
# Usage: swap_container <name> <docker run options...>   (the image name last, as for docker run)

swap_container() {
  local name="$1"; shift
  local next="${name}-next" old="${name}-old"

  # Leftovers of an interrupted swap.
  docker rm -f "$next" >/dev/null 2>&1 || true
  if docker inspect "$old" >/dev/null 2>&1; then
    if docker inspect "$name" >/dev/null 2>&1; then
      docker rm -f "$old" >/dev/null
    else
      # Interrupted between the two renames: the old one is still the only one serving.
      docker rename "$old" "$name"
    fi
  fi

  # First run: nothing to swap with.
  if ! docker inspect "$name" >/dev/null 2>&1; then
    docker run -d --name "$name" "$@" >/dev/null
    sleep 3
    docker logs --tail 20 "$name"
    return 0
  fi

  echo "[swap] starting $next"
  docker run -d --name "$next" "$@" >/dev/null

  local ready=0
  for _ in $(seq 1 45); do
    if docker exec "$next" python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/', timeout=3)" \
      >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  if [[ "$ready" != 1 ]]; then
    echo "[swap] $next did not answer within 90 s: $name keeps serving, $next is removed." >&2
    docker logs --tail 40 "$next" >&2 || true
    docker rm -f "$next" >/dev/null || true
    return 1
  fi
  echo "[swap] $next answers, version $(docker exec "$next" cat /app/VERSION 2>/dev/null || echo '?')"

  docker rename "$name" "$old"
  docker rename "$next" "$name"
  echo "[swap] $name is now the new container; $old drains for 35 s (NGINX address cache)"
  sleep 35

  docker stop -t 120 "$old" >/dev/null || true
  docker rm -f "$old" >/dev/null || true
  echo "[swap] $old stopped and removed"
  docker logs --tail 20 "$name"
}
