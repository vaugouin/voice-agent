#!/usr/bin/env bash
#
# Smoke test: voice-agent -> API /search localization (FASTAPI-TEXT2SQL-162).
#
# Validates that the voice-agent search proxy (POST /tool/text2sql, no auth) forwards
# ui_language to the text2sql API and returns LOCALIZED movie/serie rows (title +
# poster) when the language is French, with per-field English fallback.
#
# It exercises three things:
#   1. Explicit fr vs en  -> side-by-side title/poster diff (movies, then series).
#   2. Auto-detection     -> a French query with NO ui_language must resolve to "fr"
#                            (voice-agent's detect_ui_language_from_text).
#   3. Mixed movie+serie   -> a UNION result gets both entity types localized.
#
# Requirements: curl, jq.
# Usage:  ./test-localization.sh [VOICE_AGENT_URL]
#         VOICE_AGENT_URL=http://my-host:3000 ./test-localization.sh
#         (default: http://127.0.0.1:3000)
#
set -euo pipefail

BASE="${1:-${VOICE_AGENT_URL:-http://127.0.0.1:3000}}"
EP="$BASE/tool/text2sql"

command -v jq   >/dev/null 2>&1 || { echo "jq is required";   exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }

hr(){ printf '%.0s-' $(seq 1 74); echo; }

# call <query> [ui_language]  -> prints the JSON response, or exits on a non-JSON reply.
# Omitting ui_language lets voice-agent auto-detect the language from the query text.
call() {
  local q="$1" lang="${2:-}" body resp
  if [ -n "$lang" ]; then
    body=$(jq -n --arg q "$q" --arg l "$lang" '{query:$q, ui_language:$l}')
  else
    body=$(jq -n --arg q "$q" '{query:$q}')
  fi
  resp=$(curl -s --max-time 60 -X POST "$EP" -H 'Content-Type: application/json' -d "$body") || true
  if ! printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then
    echo "ERROR: non-JSON / empty response from $EP" >&2
    printf '%s\n' "$resp" | head -3 >&2
    exit 1
  fi
  printf '%s' "$resp"
}

# compare <query>  -> run the query in fr and en, join rows by id, print EN -> FR per row.
# Auto-picks the id/title fields so it works for movies, series and movie+serie UNIONs.
compare() {
  local q="$1" fr en
  fr=$(call "$q" fr)
  en=$(call "$q" en)
  echo "  resolved ui_language: fr=$(jq -r '.ui_language // "?"' <<<"$fr")  en=$(jq -r '.ui_language // "?"' <<<"$en")"
  echo "  rows: fr=$(jq -r '.rows|length' <<<"$fr")  en=$(jq -r '.rows|length' <<<"$en")"
  jq -rn --argjson fr "$fr" --argjson en "$en" '
    def idof:    (.ID_MOVIE // .ID_SERIE // .ID_CONTENT // "?");
    def titleof: (.MOVIE_TITLE // .SERIE_TITLE // .CONTENT_TITLE // "?");
    ($en.rows | map(.data) | map({key:(idof|tostring), value:.}) | from_entries) as $enmap
    | ($fr.rows[:8] | map(.data))[]
    | . as $d | ($enmap[($d|idof|tostring)] // {}) as $e
    | "    " + ($e|titleof) + "  ->  " + ($d|titleof)
      + (if ($d|titleof) == ($e|titleof) then "   [title: EN fallback]" else "   [title: FR OK]" end)
      + (if $d.POSTER_PATH == $e.POSTER_PATH then "   [poster: same]"      else "   [poster: FR OK]"  end)
  '
}

echo "Voice-agent localization smoke test"
echo "Endpoint: $EP"
hr

echo "[1/4] MOVIES - explicit fr vs en  (query: films realises par Alfred Hitchcock)"
compare "films realises par Alfred Hitchcock"
hr

echo "[2/4] AUTO-DETECT - French query, NO ui_language sent (must resolve to fr)"
auto=$(call "les meilleurs films de Stanley Kubrick")
detected=$(jq -r '.ui_language // "?"' <<<"$auto")
echo "  resolved ui_language: $detected"
if [ "$detected" = "fr" ]; then
  echo "  PASS: voice-agent auto-detected French."
else
  echo "  FAIL: expected fr, got '$detected'."
fi
jq -r '.rows[:5][].data | "    - " + (.MOVIE_TITLE // .SERIE_TITLE // "?") + "   [" + (.POSTER_PATH // "-") + "]"' <<<"$auto"
hr

echo "[3/4] SERIES - explicit fr vs en  (query: meilleures series policieres britanniques)"
compare "meilleures series policieres britanniques"
hr

echo "[4/4] MIXED movie+serie - fr only  (query: films et series de science-fiction)"
mix=$(call "films et series de science-fiction" fr)
echo "  resolved ui_language: $(jq -r '.ui_language // "?"' <<<"$mix")"
jq -r '.rows[:8][].data
  | "    - [" + (.CONTENT_TYPE // "?") + "] "
    + (.CONTENT_TITLE // .MOVIE_TITLE // .SERIE_TITLE // "?")
    + "   [" + (.POSTER_PATH // "-") + "]"' <<<"$mix"
hr

echo "Done. Read each block: FR title != EN title => localization is applied;"
echo "'EN fallback' rows simply have no MOVIE_TITLE_FR (expected for some titles)."
