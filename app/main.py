import asyncio
import json
import logging
import os
import re
import unicodedata
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
# Client log is rotated per (UTC) day: logs/client-YYYYMMDD.log (dated at write time in
# write_client_log, matching each entry's UTC `ts`).
CLIENT_LOG_DIR = ROOT.parent / "logs"


def _read_app_version() -> str:
    """Single source of truth for the app version: the repo-root ``VERSION`` file.

    Bump it on every app update (see AGENTS.md). One string drives four surfaces:
    the About page, the JS/CSS cache-busting query strings (the ``/`` route swaps the
    ``__APP_VERSION__`` placeholder), every ``logs/client.log`` entry, and the startup
    banner in ``docker logs``. Read once at import, so a bump takes effect on restart
    (which every deploy does). Falls back to ``0.0.0`` if the file is missing.
    """
    try:
        return (ROOT.parent / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0"
    except Exception:
        return "0.0.0"


APP_VERSION = _read_app_version()


def _read_lexicons() -> tuple[dict, str]:
    """VOICE-AGENT-126: single source of the vocabulary shared by the voice (app.js) and
    text (main.py) paths -- French markers/phrases, section families, intent stopwords,
    background-topic words. Python reads it here; the browser gets the SAME data via
    window.__LEXICONS__ injected into index.html by the / route. Returns (parsed, raw text)
    so the route injects the exact bytes. Fails loud if missing/invalid: a deploy without
    lexicons.json must not silently lose language detection or deep-dive grounding."""
    raw = (ROOT / "lexicons.json").read_text(encoding="utf-8")
    return json.loads(raw), raw


LEXICONS, LEXICONS_JSON = _read_lexicons()


# VOICE-AGENT-103 gave the agent ONE persona file (repo-root ``SOUL.md``), read once at
# import and prepended by both prompt builders. VOICE-AGENT-118 splits that file in two and
# makes the persona half swappable:
#   * ``souls/_core.md``  — the NON-NEGOTIABLE core (factual grounding, staying on subject,
#     the comparison guardrail, grounded recommendations). Injected with EVERY persona.
#   * the persona layer   — character only. ``SOUL.md`` at the repo root is the ``default``
#     persona; ``souls/<slug>.md`` are the alternates, selected per request.
# Splitting them is what makes alternates safe: without it, every new persona file would have
# to restate the grounding rules (and drift), or silently drop them.
SOULS_DIR = ROOT.parent / "souls"
SOUL_CORE_FILE = "_core.md"
DEFAULT_SOUL_SLUG = "default"
# Slugs are the ONLY thing a request controls, and they are matched against already-loaded
# personas — a path is never built from user input.
SOUL_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DEFAULT_SOUL_BREVITY = "concise"
# The one dial a persona file may turn: it overrides the per-surface length delta that used to
# be hardcoded in both builders ("Keep spoken answers concise" / "You reply as concise text").
# Without it an expansive persona (the VOICE-AGENT-118 barge-in test) could never speak.
SPOKEN_LENGTH_DIRECTIVES = {
    "concise": "Keep spoken answers concise.",
    "expansive": (
        "Speak at length: develop your answers over several sentences, and expect to be "
        "interrupted rather than cutting yourself short."
    ),
}
TEXT_LENGTH_DIRECTIVES = {
    "concise": "You reply as concise text.",
    "expansive": "You reply as text, and you may run several sentences.",
}
# Dropped for an expansive persona, kept verbatim for every other one.
TEXT_SUBTITLE_BREVITY = (
    "Keep the response short enough to be readable as subtitles unless the user explicitly "
    "asks for detail. "
)


class Soul(NamedTuple):
    """One loaded persona: its slug, its display label, its length dial, the Realtime voice it
    speaks with, and its injectable prose.

    ``voice`` is stored as declared and validated at request time, not here: ``REALTIME_VOICES``
    is defined further down the module, after these loaders have already run at import.
    """

    slug: str
    label: str
    brevity: str
    voice: str
    prose: str


def _split_soul_file(raw: str) -> tuple[dict[str, str], str]:
    """Split a soul file into its optional ``---`` front matter and its injectable prose.

    Front matter is flat ``key: value`` lines (no nesting, no lists), parsed here rather than
    with a YAML dependency — and, crucially, NEVER injected: without this step the ``---``
    block would land verbatim in the model's instructions. HTML comments and markdown headings
    are dropped and inner whitespace collapsed, so a file can be human-formatted while the
    injected text is exactly the prose.
    """
    meta: dict[str, str] = {}
    text = raw.lstrip("﻿").lstrip()
    # Comments FIRST: every soul file opens with an HTML comment explaining itself, so the
    # front matter is almost never the literal first byte. Looking for `---` before stripping
    # comments would miss it and inject `name:` / `brevity:` straight into the prompt.
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.DOTALL).lstrip()
    if text.startswith("---"):
        lines = text.splitlines()
        closing = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if closing is not None:
            for line in lines[1:closing]:
                key, delim, value = line.partition(":")
                if delim and key.strip():
                    meta[key.strip().lower()] = value.strip()
            text = "\n".join(lines[closing + 1:])
    body = "\n".join(
        line
        for line in text.splitlines()
        # Headings and any leftover rule line are structure for the human reader, not prose.
        if not line.lstrip().startswith("#") and line.strip() != "---"
    )
    return meta, re.sub(r"\s+", " ", body).strip()


def _read_soul(path: Path, slug: str) -> Soul | None:
    """Load one soul file, or ``None`` if it is missing or has no prose (a missing file must
    degrade, never crash — same contract as ``VERSION``)."""
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception:
        return None
    meta, prose = _split_soul_file(raw)
    if not prose:
        return None
    brevity = meta.get("brevity", DEFAULT_SOUL_BREVITY).strip().lower()
    if brevity not in SPOKEN_LENGTH_DIRECTIVES:
        brevity = DEFAULT_SOUL_BREVITY
    return Soul(
        slug=slug,
        label=meta.get("name") or slug,
        brevity=brevity,
        voice=meta.get("voice", "").strip().lower(),
        prose=prose,
    )


def _read_agent_souls() -> dict[str, Soul]:
    """Every persona this build can serve: ``default`` (repo-root ``SOUL.md``) plus each
    ``souls/<slug>.md``. Loaded once at import, like ``VERSION`` and the persona before it, so
    selection at request time is a dict lookup and never a filesystem read. ``_core.md`` is
    skipped here: its leading underscore fails ``SOUL_SLUG_RE``, so it can never be selected
    as a persona.
    """
    souls: dict[str, Soul] = {}
    default = _read_soul(ROOT.parent / "SOUL.md", DEFAULT_SOUL_SLUG)
    if default:
        souls[DEFAULT_SOUL_SLUG] = default
    try:
        candidates = sorted(SOULS_DIR.glob("*.md"))
    except Exception:
        candidates = []
    for path in candidates:
        slug = path.stem.strip().lower()
        if slug in souls or not SOUL_SLUG_RE.match(slug):
            continue
        soul = _read_soul(path, slug)
        if soul:
            souls[slug] = soul
    return souls


AGENT_SOUL_CORE_SOUL = _read_soul(SOULS_DIR / SOUL_CORE_FILE, "core")
AGENT_SOUL_CORE = AGENT_SOUL_CORE_SOUL.prose if AGENT_SOUL_CORE_SOUL else ""
AGENT_SOULS = _read_agent_souls()
FALLBACK_SOUL = Soul(DEFAULT_SOUL_SLUG, DEFAULT_SOUL_SLUG, DEFAULT_SOUL_BREVITY, "", "")


def resolve_soul(value: Any = None) -> Soul:
    """Pick the persona for one request: an explicit slug (``?soul=`` on the voice path, the
    ``soul`` payload field on the text path), else the ``AGENT_SOUL`` env default, else
    ``default``. An unknown or malformed slug falls back silently instead of erroring: a bad
    URL must never cost a session.
    """
    for candidate in (value, os.getenv("AGENT_SOUL")):
        slug = str(candidate or "").strip().lower()
        if slug and SOUL_SLUG_RE.match(slug) and slug in AGENT_SOULS:
            return AGENT_SOULS[slug]
    return AGENT_SOULS.get(DEFAULT_SOUL_SLUG) or FALLBACK_SOUL


def request_soul(request: Request) -> Soul:
    return resolve_soul(request.query_params.get("soul") or request.query_params.get("soul_slug"))


def request_voice(request: Request, soul: Soul | None = None) -> str:
    """The Realtime voice for one session, in order of precedence (VOICE-AGENT-118):

    1. ``?voice=<name>`` — an explicit choice always wins, so a voice can be A/B'd on a persona.
    2. the persona's own ``voice:`` — the character owns its voice: a face, a prose and a timbre
       are one artifact, and the pairing must not depend on what a `.env` says.
    3. ``AGENT_VOICE`` — the deployment default, for personas that declare no voice.
    4. the built-in default.

    Deliberately asymmetric with ``agent_voice()``: a bad **env** value is a misconfiguration
    and still raises, but a bad **URL** or a bad persona declaration falls back instead of
    costing the user a session.
    """
    override = str(request.query_params.get("voice") or "").strip().lower()
    if override in REALTIME_VOICES:
        return override
    if soul and soul.voice in REALTIME_VOICES:
        return soul.voice
    return agent_voice()


def soul_instructions(soul: Soul) -> str:
    """What actually reaches the model: the persona (who you are) then the core (what never
    bends), in that order. The core comes last so it has the final word on any tension with
    the character above it.
    """
    return " ".join(part for part in (soul.prose, AGENT_SOUL_CORE) if part)
# Startup banner so `docker logs -f voice-agent` shows the running version.
print(f"[voice-agent] version {APP_VERSION}", flush=True)
REALTIME_VOICES = {
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar",
}
DEFAULT_REALTIME_VOICE = "ash"
DEFAULT_REALTIME_MODEL = "gpt-realtime-2"
DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe"

# VOICE-AGENT-102. The session used to pin transcription to English. Speaking French to a
# transcriber locked on "en" does not degrade gracefully: it returns a fluent, plausible,
# wrong English-shaped sentence ("Le Ciel qui appartient a la Britannia" for "les films qui
# appartiennent a la Criterion Collection", measured 2026-08-02). Empty means auto-detect,
# which is the default because a demo mixes languages inside one session and must not need a
# gesture between two turns. The variable stays as the way back: if auto-detection turns out
# to mangle short English turns, pin it to "en" without touching code or shipping a build.
REALTIME_TRANSCRIPTION_LANGUAGE = (os.getenv("REALTIME_TRANSCRIPTION_LANGUAGE") or "").strip()

# VOICE-AGENT-128. A generic language model hears "back surface" for "box office" and "the
# titan song list" for "Sight and Sound": 4 turns lost out of 12 in one rehearsal, and twice
# the agent then INVENTED a proper noun from the garbage and queried it (VOICE-AGENT-150).
# The transcription `prompt` field is the documented place to bias the decoder toward the
# vocabulary it is about to hear. The lists live in lexicons.json (VOICE-AGENT-126), never
# here, so a shoot's proper nouns can be updated without a code change.
ASR_PROMPT_INTRO = tuple(LEXICONS["asr_prompt_intro"])
ASR_DOMAIN_TERMS = tuple(LEXICONS["asr_domain_terms"])
ASR_PROPER_NOUNS = tuple(LEXICONS["asr_proper_nouns"])


def transcription_prompt() -> str:
    """Domain bias handed to the speech-to-text step (VOICE-AGENT-128).

    A short framing, then the vocabulary. The framing used to carry a French sentence, so
    that removing the language lock (VOICE-AGENT-102) would not be undone by an English-only
    prompt. Measured on the 2026-08-04 recording session, that reasoning was wrong in a way
    worth remembering: a prompt is a text SAMPLE, not an instruction, so a French sample made
    a French output plausible for English audio and the transcriber started TRANSLATING.
    "Ok, show me the movies in the Criterion Collection" came back as "Ok, montre-moi les
    films de la collection Criterion", twice. The framing is now language-neutral and says so
    in as many words; the proper nouns do the domain work by themselves, being spelled the
    same in both languages.
    """
    return " ".join(ASR_PROMPT_INTRO) + " " + ", ".join(ASR_DOMAIN_TERMS + ASR_PROPER_NOUNS) + "."


def realtime_transcription_config() -> dict[str, Any]:
    """The `audio.input.transcription` block of the Realtime session.

    `language` is omitted entirely when REALTIME_TRANSCRIPTION_LANGUAGE is empty: the API
    treats an absent key as auto-detect, and sending an empty string is not the same thing.
    """
    config: dict[str, Any] = {
        "model": DEFAULT_TRANSCRIPTION_MODEL,
        "prompt": transcription_prompt(),
    }
    if REALTIME_TRANSCRIPTION_LANGUAGE:
        config["language"] = REALTIME_TRANSCRIPTION_LANGUAGE
    return config


def _log_soul_startup() -> None:
    """Second startup line: which character this container actually answers as (VOICE-AGENT-118).

    Lives here, after ``REALTIME_VOICES``, because it resolves the effective voice and the soul
    loaders run earlier in the module.

    It exists for three failure modes that are otherwise silent:
    * a typo in ``AGENT_SOUL`` — a persona slug falls back rather than raising (a bad URL must
      not cost a session), so an unknown *env* value would go unnoticed without this warning;
    * a missing ``souls/_core.md`` — the loaders degrade to an empty string, which would ship an
      agent with no grounding rules at all (exactly what the Dockerfile was about to do);
    * the voice precedence — a persona's own ``voice:`` beats ``AGENT_VOICE``, so editing the
      env can look like it does nothing. Printing the resolved pair settles it at a glance.
    """
    declared = str(os.getenv("AGENT_SOUL") or "").strip().lower()
    if declared and declared not in AGENT_SOULS:
        print(
            f"[voice-agent] WARNING: AGENT_SOUL={declared!r} is not a known persona, "
            f"falling back to {DEFAULT_SOUL_SLUG!r}. Known: {', '.join(sorted(AGENT_SOULS))}",
            flush=True,
        )
    active = resolve_soul()
    if active.voice in REALTIME_VOICES:
        voice, source = active.voice, "persona"
    else:
        env_voice = str(os.getenv("AGENT_VOICE") or "").strip().lower()
        if env_voice in REALTIME_VOICES:
            voice, source = env_voice, "AGENT_VOICE"
        else:
            voice, source = DEFAULT_REALTIME_VOICE, "built-in default"
    print(
        f"[voice-agent] persona {active.slug!r}, voice {voice!r} (from {source}), "
        f"{len(AGENT_SOULS)} loaded, core {'ok' if AGENT_SOUL_CORE else 'MISSING'}",
        flush=True,
    )


_log_soul_startup()
STRUCTURED_CARD_FOCUS_TOOL = "focus_result_card"
BOOLEAN_TRUE_VALUES = {"1", "true", "yes", "on"}
BOOLEAN_FALSE_VALUES = {"0", "false", "no", "off"}
DEFAULT_WIKIPEDIA_MAX_SECTIONS = 4
DEFAULT_WIKIPEDIA_MAX_CHARS = 1200
VERBOSE_WIKIPEDIA_MAX_SECTIONS = 10
VERBOSE_WIKIPEDIA_MAX_CHARS = 3000
VERBOSE_DETAIL_TRIGGER_PHRASES = (
    "tell me more",
    "more detail",
    "more details",
    "in detail",
    "full story",
    "whole story",
    "go deeper",
    "longer answer",
    "more complete",
    "more verbose",
    "elaborate",
    "dis m en plus",
    "raconte m en plus",
    "plus de detail",
    "plus de details",
    "en detail",
    "histoire complete",
    "reponse plus longue",
)
GENERIC_VERBOSE_DETAIL_PATTERNS = (
    r"^(?:please\s+)?(?:tell me more|more details?|in detail|the full story|full story|go deeper|elaborate)(?:\s+please)?[.!?]*$",
    r"^(?:can you\s+)?(?:tell me more|go deeper|elaborate)(?:\s+on (?:it|this|that|this one|that one))?(?:\s+please)?[.!?]*$",
    r"^(?:peux tu\s+)?(?:dis m en plus|raconte m en plus|plus de details?|en detail|histoire complete)(?:\s+sur (?:ca|cela|ceci|lui|elle))?(?:\s+s il te plait)?[.!?]*$",
)
# VOICE-AGENT-104. A rich background question about the entity already on screen
# ("how was the production done", "the release and reception") must pull that entity's
# verbose wikipedia_content into context, exactly like a terse "tell me more". The
# anchored GENERIC_VERBOSE_DETAIL_PATTERNS only fire on a short whole-message phrase, so a
# long, specific question falls through and the model answers from the barebones
# forced-search shell — and even claims the background is absent (Backrooms 2026,
# 2026-07-17). These markers cover four SAFE background dimensions only: production,
# release, reception, writing. Deliberately NARROW for now — no broad "story"/"plot"
# (too many false positives), no cast/actors (that routing is VOICE-AGENT-044). Widen
# later if recall proves too low. Matched as whole tokens (single words) or substrings
# (multi-word phrases) against normalized_intent_text (diacritics folded, lowercased).
BACKGROUND_DETAIL_TOPIC_WORDS = frozenset(LEXICONS["background_detail_topic_words"])  # VOICE-AGENT-126: from lexicons.json
BACKGROUND_DETAIL_TOPIC_PHRASES = tuple(LEXICONS["background_detail_topic_phrases"])  # VOICE-AGENT-126: from lexicons.json
FRENCH_MARKERS = frozenset(LEXICONS["french_markers"])  # VOICE-AGENT-126: from lexicons.json
FRENCH_PHRASES = tuple(LEXICONS["french_phrases"])  # VOICE-AGENT-126: from lexicons.json
WORD_RE = re.compile(r"[a-z']+")
MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024
TRANSCRIPTION_MIME_EXTENSIONS = {
    "audio/mp3": "mp3",
    "audio/mpeg": "mp3",
    "audio/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-wav": "wav",
    "application/ogg": "ogg",
    "video/webm": "webm",
}

# VOICE-AGENT-115: the browser POSTs /client-log several times per turn, so uvicorn's access
# log drowns everything useful ("POST /client-log HTTP/1.1 200 OK" x hundreds in `docker logs`).
# Filter these high-frequency, low-signal endpoints out of the ACCESS log only -- the log file
# they carry (client-YYYYMMDD.log) is untouched, and errors on these routes still surface because
# uvicorn.error is a separate logger. uvicorn formats access records with
# record.args = (client_addr, method, path, http_version, status_code); we match on the path.
class _AccessLogPathFilter(logging.Filter):
    def __init__(self, muted_paths: tuple[str, ...]) -> None:
        super().__init__()
        self._muted_paths = muted_paths

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            path = str(args[2]).split("?", 1)[0]
            if path in self._muted_paths:
                return False
        return True


logging.getLogger("uvicorn.access").addFilter(_AccessLogPathFilter(("/client-log", "/health")))

app = FastAPI(title="Minimal Realtime WebRTC Voice Agent")


@app.get("/static", include_in_schema=False)
@app.get("/static/", include_in_schema=False)
async def static_root_redirect() -> RedirectResponse:
    return RedirectResponse(url="../", status_code=307)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class Text2SqlRequest(BaseModel):
    query: str
    ui_language: str | None = None
    page: int = 1
    question_hashed: str | None = None


class TextChatRequest(BaseModel):
    message: str
    context: list[dict[str, Any]] = Field(default_factory=list)
    # VOICE-AGENT-118: persona slug for this turn (see resolve_soul). Optional and
    # self-healing — an unknown slug falls back to the default rather than failing the turn.
    soul: str | None = None


class ClientLogRequest(BaseModel):
    level: str = "info"
    event: str
    data: dict[str, Any] | None = None


DETAIL_ENTITY_CONFIG = {
    "movie": {
        "tool_name": "get_movie_detail",
        "path": "movies",
        "id_name": "ID_MOVIE",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a movie by TMDb ID_MOVIE, including plot, "
            "IMDb/Wikidata IDs, ratings, technical flags, technicals, cast, "
            "crew, genre codes, companies, production countries, spoken "
            "languages, topics, lists, collections, movements, awards, "
            "nominations, posters, and backdrops."
        ),
    },
    "serie": {
        "tool_name": "get_series_detail",
        "path": "series",
        "id_name": "ID_SERIE",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a TV series by TMDb ID_SERIE, including first "
            "and last air dates, season and episode counts, ratings, status, "
            "Wikidata/IMDb IDs, cast, crew, genre codes, companies, networks, "
            "production countries, spoken languages, topics, lists, collections, "
            "movements, awards, nominations, posters, and backdrops. It lists the "
            "SEASONS but NOT the individual episodes: for anything about a specific "
            "episode, call get_season_detail."
        ),
    },
    "season": {
        "tool_name": "get_season_detail",
        "path": "seasons",
        "id_name": "(ID_SERIE, SEASON_NUMBER)",
        "path_params": [
            {"name": "id_serie", "id_name": "ID_SERIE", "type": "integer"},
            {"name": "season_number", "id_name": "SEASON_NUMBER", "type": "integer"},
        ],
        # VOICE-AGENT-154: this description is the fix. The tool always returned the full
        # episode list, but said only "parent series, cast, crew, posters, backdrops" — so on
        # 2026-08-06 the model read it, saw nothing about episodes, and declined three
        # questions in a row whose answer was one call away. A tool nobody knows how to use
        # is a tool that does not exist.
        "description": (
            "Get one season of a TV series by ID_SERIE and SEASON_NUMBER. Returns the "
            "FULL EPISODE LIST for that season: every episode's number, title, overview, "
            "air date (DAT_AIR), runtime and rating, plus the season's own air date and "
            "episode count, its parent series, cast, crew, posters and Wikipedia detail. "
            "This is the tool to call for any episode-level question, such as which "
            "episode aired most recently, when a season starts or ends, how many "
            "episodes are left, or how the episodes compare to each other. Season 0 "
            "represents specials."
        ),
    },
    "episode": {
        "tool_name": "get_episode_detail",
        "path": "episodes",
        "id_name": "(ID_SERIE, SEASON_NUMBER, EPISODE_NUMBER)",
        "path_params": [
            {"name": "id_serie", "id_name": "ID_SERIE", "type": "integer"},
            {"name": "season_number", "id_name": "SEASON_NUMBER", "type": "integer"},
            {"name": "episode_number", "id_name": "EPISODE_NUMBER", "type": "integer"},
        ],
        "description": (
            "Get one episode of a TV series by ID_SERIE, SEASON_NUMBER and "
            "EPISODE_NUMBER, including its title, overview, air date (DAT_AIR), "
            "runtime and rating, its parent season and series, cast, crew, still "
            "images, and Wikipedia detail when available. Use it when the user names "
            "one episode; to browse or compare the episodes of a season, call "
            "get_season_detail instead, which returns them all in one call."
        ),
    },
    "person": {
        "tool_name": "get_person_detail",
        "path": "persons",
        "id_name": "ID_PERSON",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a person by TMDb ID_PERSON, including name, "
            "biography, birth/death dates, gender, country of birth, known-for "
            "department, IMDb/Wikidata IDs, popularity, movie_cast, movie_crew, "
            "series_cast, series_crew, groups, deaths, awards, and nominations."
        ),
    },
    "company": {
        "tool_name": "get_company_detail",
        "path": "companies",
        "id_name": "ID_COMPANY",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a production company by ID_COMPANY, including "
            "description, logo, headquarters, origin country, and associated "
            "movies and TV series ordered by weighted IMDb rating."
        ),
    },
    "network": {
        "tool_name": "get_network_detail",
        "path": "networks",
        "id_name": "ID_NETWORK",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a TV network by ID_NETWORK, including logo, "
            "origin country, and associated TV series ordered by weighted IMDb rating."
        ),
    },
    "collection": {
        "tool_name": "get_collection_detail",
        "path": "collections",
        "id_name": "ID_T2S_COLLECTION",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a named collection, trilogy, saga, universe, "
            "or franchise by ID_T2S_COLLECTION, plus member movies and TV "
            "series ordered by display order."
        ),
    },
    "topic": {
        "tool_name": "get_topic_detail",
        "path": "topics",
        "id_name": "ID_TOPIC",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a topic by ID_TOPIC, plus linked movies and "
            "TV series ordered by display order."
        ),
    },
    "list": {
        "tool_name": "get_list_detail",
        "path": "lists",
        "id_name": "ID_T2S_LIST",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a named curated list by ID_T2S_LIST, plus "
            "member movies and TV series ordered by display order."
        ),
    },
    "movement": {
        "tool_name": "get_movement_detail",
        "path": "movements",
        "id_name": "ID_MOVEMENT",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a film movement or style by ID_MOVEMENT, plus "
            "associated movies and TV series ordered by display order."
        ),
    },
    "technical": {
        "tool_name": "get_technical_detail",
        "path": "technicals",
        "id_name": "ID_TECHNICAL",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a technical format by ID_TECHNICAL, including "
            "sound systems, color/film/sound technologies, film formats, "
            "Wikipedia image data, associated movies, and sibling technicals "
            "sharing the same technical type."
        ),
    },
    "genre": {
        "tool_name": "get_genre_detail",
        "path": "genres",
        "id_name": "ID_GENRE",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get a movie / TV genre by ID_GENRE (the TMDb genre code, e.g. "
            "28 = Action, 878 = Science Fiction, 18 = Drama), including its name "
            "and its best-rated member movies and TV series."
        ),
    },
    "group": {
        "tool_name": "get_group_detail",
        "path": "groups",
        "id_name": "ID_GROUP",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a person group by ID_GROUP, including "
            "organization, club, or musical group details, plus associated "
            "persons ordered by display order."
        ),
    },
    "death": {
        "tool_name": "get_death_detail",
        "path": "deaths",
        "id_name": "ID_DEATH",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for a cause or circumstance of death by ID_DEATH, "
            "plus associated persons ordered by display order."
        ),
    },
    "award": {
        "tool_name": "get_award_detail",
        "path": "awards",
        "id_name": "ID_AWARD",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for an award by ID_AWARD, plus associated movies, "
            "TV series, and persons ordered by display order."
        ),
    },
    "nomination": {
        "tool_name": "get_nomination_detail",
        "path": "nominations",
        "id_name": "ID_NOMINATION",
        "id_param": "id",
        "id_type": "integer",
        "description": (
            "Get all fields for an award nomination by ID_NOMINATION, plus "
            "associated movies, TV series, and persons ordered by display order."
        ),
    },
    "location": {
        "tool_name": "get_location_detail",
        "path": "locations",
        "id_name": "ID_WIKIDATA",
        "id_param": "wikidata_id",
        "id_type": "string",
        "description": (
            "Get all fields for a location by Wikidata ID, such as Q90 for "
            "Paris, plus movies and TV series where it is a narrative location "
            "(P840) or filming location (P915)."
        ),
    },
}

DETAIL_TOOL_BY_NAME = {
    config["tool_name"]: entity for entity, config in DETAIL_ENTITY_CONFIG.items()
}


def text2sql_headers() -> dict[str, str]:
    api_key_name = os.getenv("TEXT2SQL_API_KEY_NAME", "X-API-Key")
    api_key_value = os.getenv("TEXT2SQL_API_KEY_VALUE")
    headers = {"Content-Type": "application/json"}
    if api_key_value:
        headers[api_key_name] = api_key_value
    return headers


def text2sql_base_url() -> str:
    return os.getenv("TEXT2SQL_BASE_URL", "http://www.vaugouin.com:8186").rstrip("/")


def normalize_ui_language(value: Any) -> str:
    clean = str(value or "en").strip().lower().replace("_", "-")
    clean = clean.split("-", 1)[0]
    return "fr" if clean == "fr" else "en"


def strip_diacritics(value: str) -> str:
    clean = unicodedata.normalize("NFKD", value)
    clean = "".join(char for char in clean if not unicodedata.combining(char))
    return clean.replace("\u0153", "oe").replace("\u00e6", "ae")


def normalized_intent_text(value: Any) -> str:
    folded = strip_diacritics(str(value or "").lower())
    return re.sub(r"[^a-z0-9]+", " ", folded).strip()


def is_verbose_detail_request(value: Any) -> bool:
    clean = normalized_intent_text(value)
    return any(phrase in clean for phrase in VERBOSE_DETAIL_TRIGGER_PHRASES)


def is_generic_verbose_detail_request(value: Any) -> bool:
    clean = normalized_intent_text(value)
    return any(re.search(pattern, clean) for pattern in GENERIC_VERBOSE_DETAIL_PATTERNS)


def is_background_detail_request(value: Any) -> bool:
    # VOICE-AGENT-104: true when the message asks about a safe background dimension
    # (production / release / reception / writing) of the active entity. Multi-word
    # phrases match as substrings; single words match as whole tokens so "script" does
    # not fire inside "prescription".
    clean = normalized_intent_text(value)
    if any(phrase in clean for phrase in BACKGROUND_DETAIL_TOPIC_PHRASES):
        return True
    if set(clean.split()) & BACKGROUND_DETAIL_TOPIC_WORDS:
        return True
    # VOICE-AGENT-114: also fire whenever the -106 families would surface sections, so the gate
    # and the reorder can never drift apart again (see app.js isBackgroundDetailRequest). Additive
    # on top of the exact-token set, so nothing it already caught regresses.
    return bool(_relevant_section_keywords(clean))


def detect_ui_language_from_text(text: Any) -> str:
    raw = str(text or "").strip().lower()
    if not raw:
        return "en"

    folded = strip_diacritics(raw)
    spaced = re.sub(r"[^a-z']+", " ", folded)
    score = 0
    if folded != raw:
        score += 1
    if re.search(r"\b[ldjmntsqc]'[a-z]", folded):
        score += 1
    if any(phrase in spaced for phrase in FRENCH_PHRASES):
        score += 2

    tokens = WORD_RE.findall(folded)
    score += min(3, len({token for token in tokens if token in FRENCH_MARKERS}))
    return "fr" if score >= 2 else "en"


def resolve_ui_language(value: Any, text: Any = "") -> str:
    if value is not None and str(value).strip():
        return normalize_ui_language(value)
    return detect_ui_language_from_text(text)


def agent_voice() -> str:
    voice = os.getenv("AGENT_VOICE", DEFAULT_REALTIME_VOICE).strip()
    if not voice:
        voice = DEFAULT_REALTIME_VOICE
    if voice not in REALTIME_VOICES:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Unsupported AGENT_VOICE: {voice}. "
                f"Supported voices: {', '.join(sorted(REALTIME_VOICES))}"
            ),
        )
    return voice


def parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    clean = value.strip().lower()
    if clean in BOOLEAN_TRUE_VALUES:
        return True
    if clean in BOOLEAN_FALSE_VALUES:
        return False
    return None


def env_bool(name: str, default: bool) -> bool:
    parsed = parse_bool(os.getenv(name))
    return default if parsed is None else parsed


def structured_card_focus_enabled(request: Request) -> bool:
    if not env_bool("ENABLE_STRUCTURED_CARD_FOCUS", True):
        return False
    override = parse_bool(
        request.query_params.get("structured_card_focus")
        or request.query_params.get("structuredCardFocus")
    )
    return True if override is None else override


def spoken_subtitles_enabled(request: Request) -> bool:
    enabled = env_bool("ENABLE_SPOKEN_SUBTITLES", False)
    override = parse_bool(
        request.query_params.get("spoken_subtitles")
        or request.query_params.get("spokenSubtitles")
    )
    return enabled if override is None else override


def user_transcript_subtitles_enabled(request: Request) -> bool:
    enabled = env_bool("ENABLE_USER_TRANSCRIPT_SUBTITLES", False)
    override = parse_bool(
        request.query_params.get("user_transcript_subtitles")
        or request.query_params.get("userTranscriptSubtitles")
    )
    return enabled if override is None else override


def focus_result_card_tool_definition() -> dict[str, Any]:
    return {
        "type": "function",
        "name": STRUCTURED_CARD_FOCUS_TOOL,
        "description": (
            "Highlight one currently visible search result card by its 1-based "
            "visible_results index before speaking about that card."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The 1-based visible result card index to highlight.",
                },
                "label": {
                    "type": "string",
                    "description": "Optional visible title of the card being highlighted.",
                },
                "reason": {
                    "type": "string",
                    "description": "Optional short reason for this focus change.",
                },
            },
            "required": ["index"],
            "additionalProperties": False,
        },
    }


def detail_tool_definitions() -> list[dict[str, Any]]:
    tools = []
    for config in DETAIL_ENTITY_CONFIG.values():
        path_params = config.get("path_params") or [
            {
                "name": config["id_param"],
                "id_name": config["id_name"],
                "type": config["id_type"],
            }
        ]
        properties = {
            param["name"]: {
                "type": param["type"],
                "description": f"The {param['id_name']} value to retrieve.",
            }
            for param in path_params
        }
        properties["ui_language"] = {
            "type": "string",
            "description": (
                "Language code for localized detail fields, such as en or fr. "
                "Use fr for French questions; otherwise use en."
            ),
        }
        tools.append(
            {
                "type": "function",
                "name": config["tool_name"],
                "description": config["description"],
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": [param["name"] for param in path_params],
                    "additionalProperties": False,
                },
            }
        )
    return tools


def detail_endpoint(entity: str, args: dict[str, Any]) -> tuple[str, Any]:
    config = DETAIL_ENTITY_CONFIG[entity]
    path_params = config.get("path_params") or [
        {
            "name": config["id_param"],
            "id_name": config["id_name"],
            "type": config["id_type"],
        }
    ]
    values: list[str] = []
    identifier: dict[str, Any] = {}
    for param in path_params:
        value = args.get(param["name"])
        if value is None:
            value = args.get(param["id_name"])
        if value is None and len(path_params) == 1:
            value = args.get("id")
        if value is None or str(value).strip() == "":
            raise ValueError(f"Missing {param['name']} for {config['tool_name']}")
        if param["type"] == "integer":
            try:
                value = int(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Invalid {param['name']} for {config['tool_name']}") from exc
        else:
            value = str(value).strip()
        identifier[param["name"]] = value
        values.append(quote(str(value), safe=""))

    relative_endpoint = f"/{config['path']}/{'/'.join(values)}"
    output_id: Any = next(iter(identifier.values())) if len(identifier) == 1 else identifier
    return relative_endpoint, output_id


def detail_query_params(args: dict[str, Any], ui_language: str) -> dict[str, Any]:
    params: dict[str, Any] = {"ui_language": ui_language}
    collection = str(args.get("collection") or "").strip()
    rows_per_page = args.get("rows_per_page")

    if collection:
        params["collection"] = collection
        try:
            params["page"] = max(1, int(args.get("page") or 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid page for detail collection") from exc

    if rows_per_page is not None and str(rows_per_page).strip() != "":
        try:
            params["rows_per_page"] = min(200, max(1, int(rows_per_page)))
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid rows_per_page for detail collection") from exc

    return params


# VOICE-AGENT-106: keep the Wikipedia sections whose composite title matches the user's
# background topic (production / release / reception+critics / writing), so e.g.
# "Reception - Critical response" survives the max-sections cap even when it sits late in
# the page (fine sections from WIKIPEDIA-CRAWLER-016). Substring-matched (normalized)
# against both the question and the section titles. Mirrors the app.js constant.
BACKGROUND_FAMILY_KEYWORDS = {k: list(v) for k, v in LEXICONS["background_family_keywords"].items()}  # VOICE-AGENT-126: from lexicons.json


# VOICE-AGENT-113: words too generic to say anything about which SECTION is wanted -- either
# conversational filler or the entity type itself.
INTENT_STOPWORDS = frozenset(LEXICONS["intent_stopwords"])  # VOICE-AGENT-126: from lexicons.json


def _intent_tokens(value: Any) -> list[str]:
    seen: dict[str, None] = {}
    for token in normalized_intent_text(value).split(" "):
        if len(token) >= 4 and token not in INTENT_STOPWORDS:
            seen[token] = None
    return list(seen)


def _title_intent_score(title: Any, question_tokens: list[str]) -> int:
    """How specifically does this section title answer THIS question?

    The family match (VOICE-AGENT-106) says "reception" or "production"; this says "the Music
    one, not the Casting one". Prefix comparison runs both ways so "languages" (question)
    reaches "Language" (title).
    """
    if not question_tokens:
        return 0
    title_tokens = _intent_tokens(title)
    if not title_tokens:
        return 0
    return sum(
        1
        for q in question_tokens
        if any(t.startswith(q) or q.startswith(t) for t in title_tokens)
    )


def _relevant_section_keywords(value: Any) -> list[str]:
    clean = normalized_intent_text(value)
    if not clean:
        return []
    keywords: list[str] = []
    for family in BACKGROUND_FAMILY_KEYWORDS.values():
        if any(kw in clean for kw in family):
            keywords.extend(family)
    return keywords


def compact_wikipedia_content(
    detail: Any,
    *,
    verbose: bool = False,
    intent_text: Any = None,
) -> list[dict[str, str]]:
    if not isinstance(detail, dict):
        return []
    sections = detail.get("wikipedia_content")
    if not isinstance(sections, list):
        return []

    # VOICE-AGENT-106: prioritise the sections whose title matches the background topic
    # asked about, keeping the first section (Intro) as a grounding anchor. Only when a
    # topic is detected; otherwise keep the original "first N" order.
    relevant = _relevant_section_keywords(intent_text)
    if relevant and sections:
        def _title_matches(section: Any) -> bool:
            if not isinstance(section, dict):
                return False
            title = normalized_intent_text(section.get("title") or section.get("TITLE") or "")
            return any(kw in title for kw in relevant)
        anchor = sections[0]
        matched = [s for s in sections if s is not anchor and _title_matches(s)]
        rest = [s for s in sections if s is not anchor and not _title_matches(s)]
        # VOICE-AGENT-113: order the matched sections by how well their title answers THIS
        # question, not by their position in the article. Ranking by article order left
        # "Production - Music" and "Production - Language" at the end of a 9-section family,
        # so they were the first dropped. sorted() is stable: equal scores keep article order.
        question_tokens = _intent_tokens(intent_text)
        matched = sorted(
            matched,
            key=lambda s: -_title_intent_score(s.get("title") or s.get("TITLE") or "", question_tokens),
        )
        sections = [anchor, *matched, *rest]

    max_sections = VERBOSE_WIKIPEDIA_MAX_SECTIONS if verbose else DEFAULT_WIKIPEDIA_MAX_SECTIONS
    max_chars = VERBOSE_WIKIPEDIA_MAX_CHARS if verbose else DEFAULT_WIKIPEDIA_MAX_CHARS
    compact_sections: list[dict[str, str]] = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        title = str(section.get("title") or section.get("TITLE") or "").strip()
        content = str(section.get("content") or section.get("CONTENT") or "").strip()
        if not content:
            continue
        if len(content) > max_chars:
            content = content[:max_chars].rstrip() + "..."
        compact_sections.append({"title": title, "content": content})
        if len(compact_sections) >= max_sections:
            break
    return compact_sections


def compact_detail_for_model(
    output: dict[str, Any], *, verbose: bool = False, intent_text: Any = None
) -> dict[str, Any]:
    detail = output.get("detail")
    if not isinstance(detail, dict):
        return output
    compact_detail = {
        key: value for key, value in detail.items()
        if key not in {"wikipedia_content"}
    }

    return {
        "error": output.get("error", ""),
        "entity": output.get("entity", ""),
        "id_name": output.get("id_name", ""),
        "id": output.get("id", ""),
        "endpoint": output.get("endpoint", ""),
        "ui_language": output.get("ui_language", ""),
        "detail": compact_detail,
        "wikipedia_content": compact_wikipedia_content(detail, verbose=verbose, intent_text=intent_text),
        "wikipedia_content_mode": "verbose" if verbose else "compact",
    }


# Bounded, grounded recovery guidance shared by the Realtime and /text-chat
# prompts. Every query_text2sql result carries a `diagnostic` (reason +
# unresolved_entities); this invites the agent to re-query on recoverable failures
# instead of passively reporting an empty result — while staying grounded (re-query,
# never answer from pretraining) and bounded (so voice latency stays acceptable).
RECOVERY_INSTRUCTIONS = (
    "Recovering from empty or failed results: every query_text2sql result includes a "
    "diagnostic object with a reason. When the result is empty or does not answer the "
    "question, you MUST attempt the fix yourself by calling query_text2sql again BEFORE "
    "reporting an empty result or asking the user a clarifying question. Recovery is "
    "always grounded — re-query the database; never answer from your own knowledge and "
    "never fabricate a result. "
    "If reason is empty_result, the query was probably over-constrained or matched the "
    "wrong entity: re-query with the offending condition relaxed (for example drop a "
    "filter the user did not explicitly ask for) OR with a corrected, broader reading of "
    "an entity (for example a more general award, title, or category). "
    # VOICE-AGENT-150, second pass: recovery made it worse twice on 2026-08-06 by padding
    # the question further each time. Shortest path first, and it is the cheapest to try.
    "Before anything else, if what you sent was not the user's exact words, retry with "
    "their question VERBATIM: padding a question is itself a common cause of an empty "
    "result, and shortening back is the first recovery to attempt, never widening again. "
    "If reason is entity_unresolved, an entity listed in diagnostic.unresolved_entities "
    "was not recognized: re-query using an alternate spelling or a more common name. "
    "If reason is ambiguous or no_sql, split the request into smaller sub-questions and "
    "call query_text2sql for each. "
    "Make at most two recovery attempts in total. Whenever a recovery query changes what "
    "the user asked — relaxing or reinterpreting a condition — state plainly in your "
    "answer what you changed and why (for example: 'No movies matched X with Y, so I "
    "broadened to Z; here is what I found'). Ask the user to clarify only if recovery "
    "also comes back empty. If it is still empty, say plainly that you found nothing and "
    "why; never invent an answer."
)

# A query_text2sql result is only the FIRST PAGE of matches (rows_per_page, currently
# 50), not the whole set. Without this, the model reads result_count as a definitive
# total and says things like "there are 50 movies shot in Technicolor" when the real
# total is unknown and larger. Shared by the Realtime and /text-chat prompts.
RESULT_COUNT_INSTRUCTIONS = (
    "Result counts and pagination: a query_text2sql result returns only the FIRST PAGE "
    "of matches, not the complete set. The result_count field is the number of rows on "
    "this page (at most rows_per_page, currently 50), NOT the total number of matching "
    "titles. When has_more is true, or when result_count equals rows_per_page (a full "
    "page), there are more matches than shown and the true total is unknown: do NOT state "
    "a specific number of results ('there are 50 movies') and do not imply the list is "
    "exhaustive. Instead speak qualitatively ('here are some of the many…', 'a first "
    "selection…', 'among the top matches…') or say there are at least that many. Only "
    "state an exact total when has_more is false AND it is page 1, so the whole result "
    "set fits on one page; then result_count is the true total. Never present the "
    "first-page count as the definitive number of results."
)

# VOICE-AGENT-093. A query_text2sql result may carry a `name_ambiguity` object
# (from FASTAPI-TEXT2SQL-157) meaning the user named ONE entity but the database holds
# several sharing that exact name/title (homonym person, duplicate movie/serie title).
# The API only DETECTS the cluster; deciding whether to ask or to list is the client's
# job, and it hinges on the user's phrasing (singular vs plural) — which is NOT in the
# SQL. Shared by the Realtime and /text-chat prompts.
DISAMBIGUATION_INSTRUCTIONS = (
    "Same-name disambiguation: a query_text2sql result may include a name_ambiguity "
    "object with an anchor, a count, and a candidates list (each candidate has an id and "
    "a discriminator). It means the user named ONE entity (person, movie, or series) but "
    "several in the database share that exact name or title. "
    "When name_ambiguity is present AND the user asked about a SINGLE entity (for example "
    "'tell me about X', 'who is X', 'what is X about'), do NOT call a detail tool yet. "
    "First ASK the user which one they mean, naming each candidate by what distinguishes "
    "it: for a person, lead with the role (say 'the actor' vs 'the director' from the "
    "discriminator), add the birth year, and when present their known_for titles and "
    "country_of_birth (say 'the one known for 12 Years a Slave' or 'the British one'); for a "
    "movie or series, use the year and, for same-year twins, the director. The "
    "candidate's on-screen title can differ from the exact word the user said (it may be "
    "an English or alternate title), so identify candidates by year, role, director or cast, "
    "not by repeating the title. If two candidates share the same year, tell them apart by "
    "the discriminator's directors and top_cast (plus creators for a series) or by the full "
    "release_date — these are already in the discriminator, so you do NOT need a detail tool "
    "to compare director or cast. "
    "As soon as the user's answer points to ONE candidate, call that candidate's detail "
    "tool with its id and answer from the result. The choice may be DIRECT (by year, role, "
    "or ordinal), INDIRECT (by director or lead actor — match the discriminator's directors / "
    "top_cast; by a person's known_for title or country_of_birth; or 'the most recent / latest / "
    "oldest one' — resolve it with the candidates' release_date), or a CONFIRMATION of a "
    "candidate you just named ('yes', 'that one', 'focus on this one'). In every such case "
    "you already have the id, so fetch it immediately in this same turn: never reply that "
    "you lack the details, only have the list, or will look it up later without fetching "
    "first. "
    "But if the user's request was PLURAL or a listing ('list all movies called X', "
    "'how many people are named X', 'show me the X films'), do NOT ask — simply present "
    "the candidates. When name_ambiguity is absent, behave normally."
)

# VOICE-AGENT-093, text path only. Typed /text-chat is near-stateless: the server
# re-runs query_text2sql on EVERY message, so the user's follow-up choice ("the
# director") would otherwise be re-searched as if it were a new question, losing the
# candidate list. This tells the model to treat such a reply as a SELECTION and resolve
# it from the carried candidates instead of the freshly forced search.
DISAMBIGUATION_TEXT_ADDENDUM = (
    "Handling the user's choice in typed chat: when the recent conversation context "
    "contains a name_ambiguity candidate list from an earlier turn, a reply that selects "
    "among those candidates is NOT a new search, so no query_text2sql is pre-executed for "
    "it — you must act on the carried candidate list yourself. A selection can be DIRECT "
    "('the director', 'the 1965 one', 'the second'), INDIRECT ('the one directed by Nolan' — "
    "match the discriminator's directors; 'the one with De Niro' — match top_cast; for a person "
    "'the one known for 12 Years a Slave' or 'the British one' — match known_for / "
    "country_of_birth; 'the most recent one', 'the oldest' — use year and release_date), or a "
    "CONFIRMATION of a candidate you just named ('yes', 'that one', "
    "'focus on this one'). In every such case, pick the matching candidate and call its "
    "detail tool with that candidate's id from the list IMMEDIATELY in this same turn, then "
    "answer from the detail result. Do NOT reply that you will look it up, do NOT ask the "
    "user to confirm yet again, and do NOT say you only have the list or lack the details: "
    "you have the id, so fetch it now. If the selection is still genuinely ambiguous (two "
    "candidates the user's criterion cannot separate, e.g. same director), ask ONE more "
    "narrowing question instead of guessing. If the message is a NEW question unrelated to "
    "the carried candidates, call query_text2sql yourself with the user's message and "
    "answer from that."
)

VERBOSE_DETAIL_INSTRUCTIONS = (
    "Default to concise answers. If the user explicitly asks to tell me more, "
    "answer in detail, explain the full story, go deeper, or asks for a longer "
    "answer about an entity, treat that as a one-turn verbose detail request. "
    "For a verbose detail request, call the dedicated detail tool for the "
    "specific or most recently discussed entity before answering, even if you "
    "already saw a compact detail result earlier. Use the returned "
    "wikipedia_content as grounding for a noticeably longer paraphrased "
    "summary. Organize the answer around the useful sections that are present, "
    "such as intro, plot, production, reception, career, or biography. Do not "
    "read Wikipedia content verbatim, do not quote long passages, and do not "
    "invent facts. After that response, return to concise answers unless the "
    "user asks for detail again."
)

# VOICE-AGENT-105. The forced query_text2sql result is only a search-index shell
# (identifiers, title, year, runtime, tagline); it never carries plot, cast, production,
# release, or reception data — those live only in the detail tool's wikipedia_content.
# Without this, the model read the shell as the whole record and told the user the
# background was "not in the database" while the data sat one get_*_detail call away
# (Backrooms 2026, 2026-07-17). Shared by the Realtime and /text-chat prompts.
GROUNDED_ABSENCE_INSTRUCTIONS = (
    "The query_text2sql result is only a search-index shell (identifiers, title, year, "
    "runtime, rating, tagline). It is NOT the full record: it does not contain plot, cast, "
    "crew, production, release, or reception data, which live only in the dedicated detail "
    "tool's wikipedia_content. Therefore, before telling the user that the plot, story, "
    "production, release, reception, or any background detail is missing, unavailable, or "
    "not in the database, you MUST first call the dedicated detail tool (for example "
    "get_movie_detail with the entity id) for the entity in question and inspect its "
    "wikipedia_content. Only state that something is absent after that detail fetch has "
    "returned and genuinely lacks it. Never conclude from the search result alone that "
    "plot, production, or reception data does not exist."
)

# VOICE-AGENT-143. Neither prompt carried a date, so the agent had no clock: on 2026-07-29 it
# answered "what was the last episode that aired?" with episode 5 and filed episodes 6 to 8
# under "future air dates" — three days after episode 6 went out, and two turns after the app
# itself had displayed that date on screen. Pretraining cannot supply this: the database is
# fed nightly, so the rows most worth talking about are exactly the ones whose dates sit
# within days of now, which is precisely where a clockless reading fails.
#
# Note the asymmetry with the SQL side: the API needs no notion of today (MySQL has CURDATE(),
# and "recently" is generated as an ORDER BY rather than a date filter). It is the AGENT that
# needs it, to read an air date and to pick the tense of the verb.
#
# The zone is explicit rather than UTC because "did it air last night" is asked in a local
# day, not in UTC. Recomputed per request (per session on the voice path), never frozen into
# a module constant — a constant would be correct for one day and wrong every day after.
AGENT_TIMEZONE_NAME = (os.getenv("AGENT_TIMEZONE") or "Europe/Paris").strip() or "Europe/Paris"

_WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def agent_now() -> tuple[datetime, str]:
    """Current time in the configured zone, plus the zone name to state in the prompt.

    Falls back to UTC when the zone cannot be loaded (unknown name, or a slim image whose
    tzdata is missing). A date a couple of hours off is still incomparably better than no
    date at all, so this must never raise into a session or a turn.
    """
    try:
        zone = ZoneInfo(AGENT_TIMEZONE_NAME)
    except Exception:
        return datetime.now(timezone.utc), "UTC"
    return datetime.now(zone), AGENT_TIMEZONE_NAME


def current_date_line() -> str:
    """One dated sentence, short enough to sit next to the data the model is reading."""
    now, zone_name = agent_now()
    # Weekday from a fixed tuple, not strftime("%A"): %A follows the process locale, so a
    # container started with a French locale would inject a French weekday into an English
    # prompt.
    return (
        f"Today's date is {_WEEKDAY_NAMES[now.weekday()]} {now.strftime('%Y-%m-%d')} "
        f"({zone_name})."
    )


# VOICE-AGENT-149. VOICE-AGENT-143 gave the agent a clock and it works: on 2026-08-02 the
# model read an air date, compared it to today, and SAID the comparison out loud ("its air
# date is August 9, 2026, which is in the future compared with today") while presenting that
# episode as the last one aired. What was missing is not the clock, it is what to do when the
# clock and a tool row disagree: a row labelled "last aired episode" outranked the model's own
# arithmetic. The same day, the same build made the mirror error on a film, calling Anora
# "still in the future" two years after its release, which is the proof that this is an absent
# rule rather than a bias in one direction.
#
# Three things this text has to do, and the third is the one that is easy to forget: forbid
# the observed phrasing. An agent that narrates the contradiction instead of resolving it tells
# the viewer the app knows it is wrong and is speaking anyway, worse on camera than a plain
# mistake.
#
# The same-day convention is deliberate (decided with Philippe, 2026-08-03): a date equal to
# today counts as scheduled for today, not as already happened. HBO airs on Sunday evening US
# time, which is Monday morning in Europe/Paris, so an episode dated today has usually NOT been
# seen by anyone when the question is asked in the morning. "Airs today" is the answer that
# cannot be wrong either way.
DATE_PRECEDENCE_RULE = (
    "When a date disagrees with what a row is called, the date wins. A date later than today "
    "has not happened, whatever the row that carries it is labelled, including a row returned "
    "as the latest, last, or most recent one. Never present such a record as released, aired, "
    "or broadcast: name the most recent record whose date is strictly before today, or say you "
    "do not have one. A date equal to today is happening today, so say it comes out today or "
    "airs today rather than calling it the last one that already aired. Resolve this silently: "
    "never say aloud that a date is in the future compared with today, or otherwise narrate the "
    "contradiction. State the correct fact instead. "
    # VOICE-AGENT-149, second pass. Telling the model to compare dates is not enough: on
    # 2026-08-03 it read Anora's DAT_RELEASE of 2024-10-14, had today's date in the same
    # payload, and still answered "its release date is later than today, so I can't treat it
    # as already released", dropping a correct row from the answer. The comparison is
    # therefore done in code and handed over as a verdict, so the only thing left to the
    # model is reading a word.
    "Every row and record carries `_date_status`, computed by the application against today's "
    "date: `past` means it has already happened, `today` means it happens today, `future` means "
    "it has not happened yet. That field is authoritative. Never work out the comparison "
    "yourself and never override it with what you believe about a title: if `_date_status` says "
    "`past`, the record is out and you speak of it in the past, even if you remember it as "
    "recent or forthcoming. When a record carries no `_date_status`, say nothing about whether "
    "it has happened. "
    # VOICE-AGENT-155, second pass, and the sentence above is exactly what broke it. On
    # 2026-08-06 the season payload carried `episode_air_status` with `last_aired` spelled
    # out, the model read it — it named episode 7 and its date correctly — and then hedged
    # three times: "without an episode-level date status, I can't confirm it as already
    # aired". It was obeying "say nothing when a record carries no `_date_status`", since the
    # verdict deliberately rides on the payload rather than inside the episode records. The
    # rule and the payload disagreed, and the rule won. Naming the field closes that gap.
    "A season sheet carries `episode_air_status` instead of a per-episode field, computed by "
    "the application against today's date and just as authoritative: `last_aired` is the most "
    "recent episode that HAS already aired, `next_airing` is the next one that has NOT aired "
    "yet, `season_last_air_date` is the date the season ends, and `aired_count` and "
    "`upcoming_count` say how many fall on each side. Answer episode timing questions straight "
    "from it, in the past tense for `last_aired` and the future tense for `next_airing`. Never "
    "say that per-episode status is missing and never hedge about it: every episode outside "
    "`upcoming_count` has aired."
)

# VOICE-AGENT-149. The date columns worth a verdict, per entity. Deliberately a named list and
# not "every DAT_ column": DAT_CREAT is a bookkeeping timestamp, and annotating it would spend
# payload budget to tell the model that a database row was created in the past.
_DATE_STATUS_COLUMNS = (
    "DAT_RELEASE",     # movie
    "DAT_FIRST_AIR",   # serie start
    "DAT_LAST_AIR",    # serie end, so a running show can be told from a finished one
    "DAT_AIR",         # episode
    "DEATHDAY",        # person, the one date whose tense is never neutral
)


def _date_status(value: Any, today: date) -> str | None:
    """`past`, `today` or `future` for one date value, or None when it is not a date.

    Accepts what the API actually returns: a date, a datetime, or an ISO-ish string. Anything
    unparseable returns None rather than a guess, because a wrong verdict here is worse than
    no verdict: the prompt tells the model to stay silent when the field is absent.
    """
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        parsed = value.date()
    elif isinstance(value, date):
        parsed = value
    else:
        try:
            parsed = date.fromisoformat(str(value)[:10])
        except ValueError:
            return None
    if parsed < today:
        return "past"
    if parsed == today:
        return "today"
    return "future"


def _date_status_map(record: Any, today: date) -> dict[str, str]:
    """The verdicts for one record, keyed by the column they were computed from."""
    if not isinstance(record, dict):
        return {}
    out = {}
    for column in _DATE_STATUS_COLUMNS:
        status = _date_status(record.get(column), today)
        if status:
            out[column] = status
    return out


def _episode_air_summary(detail: Any, today: date) -> dict[str, Any] | None:
    """Which episodes have aired, decided in code (VOICE-AGENT-155).

    Same lesson as VOICE-AGENT-149, one level deeper: `_date_status` only ever looked at the
    TOP of a payload, so a season sheet carried a verdict for its own DAT_AIR and none for the
    eight episodes underneath it. Asking the model to compare eight dates to today is the
    arithmetic that ticket already proved it loses.

    The verdict rides on the payload, never inside the episode records: those dicts are what
    the browser renders episode cards from, and a key added inside would surface on screen.

    It also disarms the placeholder trap. An unaired episode arrives titled "Episode 8" with
    VOTE_AVERAGE 1.0 — a rating nobody gave it. Left unflagged, that is a 1-out-of-10 the
    model would happily read aloud for an episode that does not exist yet.
    """
    episodes = detail.get("episodes") if isinstance(detail, dict) else None
    if not isinstance(episodes, list) or not episodes:
        return None

    def brief(ep: dict[str, Any]) -> dict[str, Any]:
        return {
            "EPISODE_NUMBER": ep.get("EPISODE_NUMBER"),
            "TITLE": ep.get("TITLE"),
            "DAT_AIR": str(ep.get("DAT_AIR") or "")[:10],
        }

    aired: list[dict[str, Any]] = []
    upcoming: list[dict[str, Any]] = []
    for episode in episodes:
        if not isinstance(episode, dict):
            continue
        status = _date_status(episode.get("DAT_AIR"), today)
        if status == "future":
            upcoming.append(episode)
        elif status:
            aired.append(episode)

    if not aired and not upcoming:
        return None

    def air_key(ep: dict[str, Any]) -> str:
        return str(ep.get("DAT_AIR") or "")[:10]

    summary: dict[str, Any] = {
        "as_of": today.isoformat(),
        "episodes_listed": len(episodes),
        "aired_count": len(aired),
        "upcoming_count": len(upcoming),
    }
    # VOICE-AGENT-155 second pass: the block said what had NOT aired and left what HAD aired
    # implicit, so the model hedged on the half that was certain. State both.
    summary["verdict"] = (
        "Computed in code against as_of. last_aired HAS already aired: speak of it in the "
        "past. next_airing has NOT aired: speak of it in the future. Do not recompute this "
        "and do not hedge about missing per-episode status."
    )
    if aired:
        summary["last_aired"] = brief(max(aired, key=air_key))
    if upcoming:
        summary["next_airing"] = brief(min(upcoming, key=air_key))
        summary["season_last_air_date"] = max(air_key(e) for e in upcoming)
        summary["upcoming_warning"] = (
            "The episodes counted in upcoming_count have NOT aired yet. Their titles and "
            "ratings are placeholders the database fills in advance, never a real title or "
            "a real score: do not quote them, and never present such an episode as broadcast."
        )
    elif aired:
        summary["season_last_air_date"] = max(air_key(e) for e in aired)
    return summary


def current_date_instructions() -> str:
    return (
        current_date_line()
        + " Compare every date you read against it before you speak. This database is "
        "refreshed every night and holds records more recent than anything in your "
        "training, so never date a record from your own memory. A release, broadcast, or "
        "death date on or before today has already happened: speak of it in the past. A "
        "later date has not happened yet: speak of it in the future. Never describe a "
        "title or an episode as upcoming, unreleased, still to come, or not yet aired "
        "when its date is today or earlier, and never read a missing rating on such a "
        "record as proof that it has not come out. This applies to dates you find in the "
        "tool results and to dates quoted earlier in this conversation alike. "
        + DATE_PRECEDENCE_RULE
    )


def current_date_guardrail() -> str:
    """The dated line plus the precedence rule, short enough to travel WITH a tool result.

    VOICE-AGENT-143 established the lesson this reuses: a rule about dates has to sit next to
    the dates. In the instructions it is the tail of ~4500 words of operational prose, read at
    session creation, several turns before the row it should have governed. Riding on the tool
    payload, it is read at the moment the model reads the air date.
    """
    return current_date_line() + " " + DATE_PRECEDENCE_RULE


def realtime_session_config(
    voice: str = DEFAULT_REALTIME_VOICE,
    *,
    structured_card_focus: bool = True,
    soul: Soul | None = None,
) -> dict[str, Any]:
    selected_voice = voice if voice in REALTIME_VOICES else DEFAULT_REALTIME_VOICE
    realtime_model = os.getenv("OPENAI_REALTIME_MODEL", DEFAULT_REALTIME_MODEL).strip() or DEFAULT_REALTIME_MODEL
    # VOICE-AGENT-103: persona comes from SOUL.md, not from inline prose. VOICE-AGENT-118:
    # that persona is now one of several (`soul_instructions` = persona + non-negotiable core)
    # and it owns the length delta that used to be hardcoded here. Only the operational
    # instructions below stay inline.
    active_soul = soul or resolve_soul()
    instructions = (
        soul_instructions(active_soul)
        + " " + SPOKEN_LENGTH_DIRECTIVES[active_soul.brevity]
        + " When the user asks a "
        "cinema, movie, TV, actor, director, production company, award, "
        "location, ranking, database, reporting, analytics, or text-to-SQL "
        "question, call query_text2sql with the user's spoken request as "
        "plain text. When the user asks for details about a specific returned "
        "entity, call the dedicated detail tool with that entity ID, or "
        "wikidata_id for locations. Seasons use ID_SERIE plus SEASON_NUMBER; "
        "episodes use ID_SERIE, SEASON_NUMBER, and EPISODE_NUMBER. For example, "
        "for a movie plot, call get_movie_detail with ID_MOVIE. Pass "
        "ui_language to search and detail tools, using fr for French "
        "questions and en otherwise. Use returned detail fields to "
        "respond in a short spoken summary by default. When wikipedia_content is "
        "returned for an entity, use it as grounding for questions asking "
        "for background, history, biography, plot context, or explanatory "
        "details. IDs are internal tool arguments only: never mention IMDb, "
        "Wikidata, TMDb, TVDB, ID_* fields, or any other database identifiers "
        "in user-facing spoken answers. Use entity names and titles; include "
        "the visible year or subtitle when it distinguishes duplicate titles. "
        "Do not recite result or card numbers unless the user explicitly asks "
        "for numbered output."
    )
    instructions += (
        " " + VERBOSE_DETAIL_INSTRUCTIONS
        + " " + RECOVERY_INSTRUCTIONS
        + " " + RESULT_COUNT_INSTRUCTIONS
        + " " + DISAMBIGUATION_INSTRUCTIONS
        + " " + GROUNDED_ABSENCE_INSTRUCTIONS
        # VOICE-AGENT-143: the date is resolved here, at session creation, so a session that
        # spans midnight keeps the date it opened with. Acceptable: a session lasts minutes.
        + " " + current_date_instructions()
    )
    tools = [
        {
            "type": "function",
            "name": "query_text2sql",
            "description": (
                "Forward a natural-language user question to the local "
                "FastAPI/FastMCP text2sql app and return its answer. Pass the question "
                "through unchanged: this tool resolves entities from the user's own "
                "wording, so rewriting it makes results worse, not better."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    # VOICE-AGENT-150, second pass. Measured against the production API on
                    # 2026-08-06, during the video #4 rehearsal: "What is everyone watching
                    # right now on HBO?" returns 50 rows. The model padded it into "... Show
                    # currently popular or trending HBO shows and movies." on the FIRST call,
                    # before any recovery, and that returns 0. The added word "movies" makes
                    # the API switch from a plain series query to a movie+series UNION whose
                    # projection has no POPULARITY column, while the ORDER BY still sorts on
                    # it (tracked API-side as FASTAPI-TEXT2SQL-193). Two rewrites, two empty
                    # results, 47 seconds of dead air and an on-camera "no matches came back",
                    # for a question that worked exactly as spoken.
                    "query": {
                        "type": "string",
                        "description": (
                            "The user's question, VERBATIM. Send exactly what they said. Do "
                            "not expand it, do not add synonyms, platform names, or "
                            "clarifying clauses, and do not merge it with your own "
                            "restatement: entity resolution runs on the user's words, and "
                            "padding the question breaks it."
                        ),
                    },
                    "ui_language": {
                        "type": "string",
                        "description": (
                            "Language code for the answer, such as en or fr. "
                            "Use en unless the user asks for another language."
                        ),
                    }
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        }
    ] + detail_tool_definitions()
    if structured_card_focus:
        instructions += (
            " Search results may include a visible_results list whose index "
            "values match the 1-based result cards shown in the browser. "
            "Immediately before speaking about, comparing, recommending, or "
            "summarizing a specific visible result card, call focus_result_card "
            "with that card's index as a silent UI action. After the tool "
            "returns, speak naturally using the card title, adding the "
            "subtitle or year when it disambiguates duplicates. Do not say "
            "the result or card number unless the user explicitly asks for "
            "numbered output. Use only indexes present in visible_results; "
            "do not call focus_result_card for hidden cards, aggregate rows, "
            "or entity detail pages. When you go through several results in "
            "turn, call focus_result_card for each card at the moment you "
            "mention it, so the on-screen highlight follows the card you are "
            "naming; present the list conversationally without spoken position "
            "numbers."
            # VOICE-AGENT-120: an earlier nudge asked the model to focus each candidate during a
            # disambiguation question; it worked mechanically but the model front-loads the calls
            # (all candidates focused in a burst at the start), so the highlight raced ahead of the
            # voice instead of following it. Removed. Same-title disambiguation highlight is driven
            # client-side on the audio-transcript timeline instead (app.js).
        )
        tools.append(focus_result_card_tool_definition())
    return {
        "type": "realtime",
        "model": realtime_model,
        "instructions": instructions,
        "audio": {
            "input": {
                # VOICE-AGENT-100: server-side noise reduction, applied BEFORE turn detection
                # and transcription. The browser already sets echoCancellation/noiseSuppression
                # on getUserMedia, but it was not enough: the voice log carried transcripts of
                # room noise in other languages (despite language="en") and, worse, snippets of
                # the assistant's own speech ("There are several", "Let me") echoed back as user
                # turns — each a phantom turn that fires a real query_text2sql. near_field is the
                # profile for a mic held close to the face (phone/tablet in hand).
                "noise_reduction": {"type": "near_field"},
                # VOICE-AGENT-102 (no language lock by default) + VOICE-AGENT-128 (domain
                # bias). Built together on purpose: the two tickets pull on the same lever,
                # and the prompt is what keeps accuracy up once the language pin is gone.
                "transcription": realtime_transcription_config(),
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 700,
                    "create_response": True,
                    "interrupt_response": True,
                }
            },
            "output": {"voice": selected_voice},
        },
        "tools": tools,
        "tool_choice": "auto",
    }


def text_tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": "query_text2sql",
            "description": (
                "Forward a natural-language user question to the local "
                "FastAPI/FastMCP text2sql app and return its answer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The user's question as text.",
                    },
                    "ui_language": {
                        "type": "string",
                        "description": (
                            "Language code for the answer, such as en or fr. "
                            "Use en unless the user asks for another language."
                        ),
                    },
                    "page": {
                        "type": "integer",
                        "description": "Result page number. Use 1 for a new query.",
                    },
                    "question_hashed": {
                        "type": "string",
                        "description": "Cached question hash for follow-up pages.",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        }
    ] + detail_tool_definitions()


def extract_response_text(response_body: Any) -> str:
    if not isinstance(response_body, dict):
        return ""
    output_text = str(response_body.get("output_text") or "")
    if output_text:
        return output_text

    fragments: list[str] = []
    for output_item in response_body.get("output", []):
        if not isinstance(output_item, dict):
            continue
        for content in output_item.get("content", []):
            if isinstance(content, dict) and content.get("type") in {"output_text", "text"}:
                fragments.append(str(content.get("text", "")))
    return "\n".join(fragment for fragment in fragments if fragment).strip()


def multipart_form_data(fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = f"----realtime-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8")
        )
        chunks.append(value.encode("utf-8"))
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), boundary


def transcription_file_extension(content_type: str) -> str:
    media_type = content_type.split(";", 1)[0].strip().lower()
    return TRANSCRIPTION_MIME_EXTENSIONS.get(media_type, "webm")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    # Inject the global app version into the cache-busting query strings, the About
    # page, and any other `__APP_VERSION__` placeholder, so one VERSION bump refreshes
    # the browser's JS/CSS and updates the displayed version in a single place.
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    # The `?v=` scheme only busts the SUB-resources (app.js / styles.css); it is gated
    # by this document, which carries the version string. Mark index.html no-cache so
    # every load/reload revalidates it and always serves the current `?v=` — otherwise a
    # browser- or proxy-cached index.html keeps pointing at the old app.js after a deploy
    # (only Ctrl+Shift+R would recover it). Note: an already-open SPA tab still won't pick
    # up a new version until it is reloaded — no header fixes "the tab was never reloaded".
    # VOICE-AGENT-126: hand the browser the SAME shared vocabulary the server uses, so app.js
    # builds its language/family/stopword lists from one source instead of a hand-kept copy.
    html = html.replace("__LEXICONS_JSON__", LEXICONS_JSON)
    return HTMLResponse(
        html.replace("__APP_VERSION__", APP_VERSION),
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/souls")
async def list_souls() -> dict[str, Any]:
    """Which personas this build can serve, so a test run (or a later in-app picker) does not
    have to guess the slugs. VOICE-AGENT-118. The prose itself is deliberately not exposed:
    this is a selector, not a prompt dump.
    """
    ordered = sorted(
        AGENT_SOULS.values(), key=lambda soul: (soul.slug != DEFAULT_SOUL_SLUG, soul.slug)
    )
    return {
        # The persona actually in effect when no ?soul= is given, i.e. AGENT_SOUL resolved —
        # NOT the literal `default` slug. A client that displays the active character has no
        # other way to know which one answers by default on this deployment.
        "default": resolve_soul().slug,
        "core_loaded": bool(AGENT_SOUL_CORE),
        "souls": [
            {
                "slug": soul.slug,
                "label": soul.label,
                "brevity": soul.brevity,
                # The voice the character declares, and the avatar a client can display for it.
                # Empty voice = this persona defers to AGENT_VOICE; empty avatar = no portrait
                # shipped for this slug, so a client knows not to request a 404.
                "voice": soul.voice if soul.voice in REALTIME_VOICES else "",
                "avatar": (
                    f"static/souls/{soul.slug}.webp"
                    if (STATIC_DIR / "souls" / f"{soul.slug}.webp").is_file()
                    else ""
                ),
            }
            for soul in ordered
        ],
    }


@app.post("/session", response_class=PlainTextResponse)
async def create_realtime_session(request: Request) -> PlainTextResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    sdp = (await request.body()).decode("utf-8")
    if not sdp.strip():
        raise HTTPException(status_code=400, detail="Missing SDP offer body")

    use_structured_card_focus = structured_card_focus_enabled(request)
    use_spoken_subtitles = spoken_subtitles_enabled(request)
    use_user_transcript_subtitles = user_transcript_subtitles_enabled(request)
    # VOICE-AGENT-118: same "env default, query-param override" shape as the flags above. The
    # persona is resolved FIRST because it can carry the voice (see request_voice).
    active_soul = request_soul(request)
    voice = request_voice(request, active_soul)

    body, boundary = multipart_form_data(
        {
            "sdp": sdp,
            "session": json.dumps(
                realtime_session_config(
                    voice,
                    structured_card_focus=use_structured_card_focus,
                    soul=active_soul,
                )
            ),
        }
    )
    # Without this line a recorded voice test cannot say WHICH character answered, which makes
    # the persona comparison uninterpretable after the fact (same lesson as VOICE-AGENT-096).
    write_client_log(
        "session_persona",
        {
            "source": "voice",
            "soul": active_soul.slug,
            "brevity": active_soul.brevity,
            "voice": voice,
        },
    )

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            "https://api.openai.com/v1/realtime/calls",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            content=body,
        )

    answer_sdp = response.text
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=answer_sdp)

    headers = {
        "X-Structured-Card-Focus": "1" if use_structured_card_focus else "0",
        "X-Spoken-Subtitles": "1" if use_spoken_subtitles else "0",
        "X-User-Transcript-Subtitles": "1" if use_user_transcript_subtitles else "0",
    }
    location = response.headers.get("Location")
    if location:
        headers["X-OpenAI-Call-ID"] = location.rsplit("/", 1)[-1]

    return PlainTextResponse(answer_sdp, media_type="application/sdp", headers=headers)


@app.post("/transcribe")
async def transcribe_audio(request: Request) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Missing audio body")
    if len(audio_bytes) > MAX_TRANSCRIPTION_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio upload is too large")

    content_type = request.headers.get("content-type", "audio/webm")
    media_type = content_type.split(";", 1)[0].strip().lower() or "audio/webm"
    extension = transcription_file_extension(content_type)
    model = (
        os.getenv("OPENAI_TRANSCRIPTION_MODEL", DEFAULT_TRANSCRIPTION_MODEL).strip()
        or DEFAULT_TRANSCRIPTION_MODEL
    )

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            response = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                # VOICE-AGENT-128: the dictation upload gets the same domain bias as the
                # Realtime session. It never carried a language pin, so it needs nothing
                # from VOICE-AGENT-102, only the vocabulary.
                data={"model": model, "prompt": transcription_prompt()},
                files={"file": (f"dictation.{extension}", audio_bytes, media_type)},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    upstream_content_type = response.headers.get("content-type", "")
    if "application/json" in upstream_content_type:
        upstream_body: Any = response.json()
    else:
        upstream_body = response.text

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=upstream_body)

    return {
        "configured": True,
        "model": model,
        "text": upstream_body.get("text", "") if isinstance(upstream_body, dict) else "",
        "upstream_id": upstream_body.get("id", "") if isinstance(upstream_body, dict) else "",
    }


def _text2sql_unresolved_entities(sql_query: str, entity_extraction: Any) -> list[str]:
    """Surface names of entities the upstream extracted but could not resolve.

    The upstream leaves an unresolved entity's placeholder (e.g. ``{{Person_name1}}``)
    in the returned ``sql_query`` instead of substituting a real id/name; this mirrors
    the upstream's own detection (entity.resolve_entities) and maps each surviving
    placeholder back to the surface name the user spoke.
    """
    keys = re.findall(r"\{\{([^}]+)\}\}", sql_query or "")
    if not keys:
        return []
    names: list[str] = []
    for key in keys:
        value = entity_extraction.get(key) if isinstance(entity_extraction, dict) else None
        if isinstance(value, dict):
            value = value.get("name") or value.get("value")
        surface = str(value).strip() if value not in (None, "") else ""
        names.append(surface or key)
    return names


def _text2sql_diagnostic(upstream_body: Any) -> dict[str, Any]:
    """Compact, actionable reason why a text2sql query returned nothing.

    The upstream API computes why a query failed and the trimmed tool output drops
    it, so on an empty result the model only sees ``answer="" error="" result_count=0``
    and cannot tell an unresolved entity from a genuinely empty database. This recovers
    the signal so the model can pick a recovery strategy instead of guessing.

    ``reason`` is one of: ``ok`` | ``transient`` | ``no_sql`` | ``sql_error`` |
    ``entity_unresolved`` | ``ambiguous`` | ``empty_result`` | ``unknown``.
    """
    if not isinstance(upstream_body, dict):
        return {"reason": "unknown", "retryable": False, "unresolved_entities": []}

    error_text = str(upstream_body.get("error") or "")
    retryable = bool(upstream_body.get("is_retryable"))
    sql_query = str(upstream_body.get("sql_query") or "")
    unresolved = _text2sql_unresolved_entities(sql_query, upstream_body.get("entity_extraction"))
    result_count = len(upstream_body.get("result") or [])

    if error_text:
        reason = "transient" if retryable else ("sql_error" if sql_query else "no_sql")
    elif unresolved:
        reason = "entity_unresolved"
    elif upstream_body.get("ambiguous_question_for_text2sql"):
        reason = "ambiguous"
    elif result_count == 0:
        reason = "empty_result"
    else:
        reason = "ok"

    diagnostic: dict[str, Any] = {
        "reason": reason,
        "retryable": retryable,
        "unresolved_entities": unresolved,
    }
    error_code = upstream_body.get("error_code")
    if error_code:
        diagnostic["error_code"] = str(error_code)
    retry_after = upstream_body.get("retry_after_seconds")
    if retry_after is not None:
        diagnostic["retry_after_seconds"] = retry_after
    return diagnostic


def build_text2sql_request_json(
    payload: Text2SqlRequest,
    *,
    ui_language: str,
    rows_per_page: int,
) -> dict[str, Any]:
    request_json = {
        "question": payload.query,
        "question_hashed": payload.question_hashed or None,
        "ui_language": ui_language,
        "page": payload.page,
        "rows_per_page": rows_per_page,
        "retrieve_from_cache": True,
        "store_to_cache": True,
        "complex_question_processing": False,
    }
    return {key: value for key, value in request_json.items() if value is not None}


def reusable_text2sql_question_hash(upstream_body: Any, *, has_more: bool) -> str | None:
    if not has_more or not isinstance(upstream_body, dict):
        return None
    question_hashed = str(upstream_body.get("question_hashed") or "").strip()
    sql_query = str(upstream_body.get("sql_query") or "").strip()
    if not question_hashed or not sql_query:
        return None
    if upstream_body.get("ambiguous_question_for_text2sql") or upstream_body.get("error"):
        return None
    return question_hashed


async def _post_text2sql_with_retry(
    url: str,
    request_json: dict[str, Any],
    headers: dict[str, str],
    *,
    retries: int = 3,
    backoff: float = 1.5,
    timeout: float = 30.0,
) -> httpx.Response:
    """POST to the text2sql API, retrying transient 5xx and transport errors.

    The text2sql API can return a transient 5xx (DB blip, restart, …); without retry
    that surfaces to voice and typed users as a hard 502. Retries 5xx responses and
    httpx transport errors with linear backoff; 4xx and a final 5xx fall through to
    the caller's normal status handling. Raises HTTPException(502) only when transport
    keeps failing after every attempt.
    """
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                response = await client.post(url, json=request_json, headers=headers)
            except httpx.HTTPError as exc:
                last_exc = exc
                if attempt >= retries:
                    raise HTTPException(status_code=502, detail=str(exc)) from exc
                await asyncio.sleep(backoff * attempt)
                continue
        if response.status_code >= 500 and attempt < retries:
            await asyncio.sleep(backoff * attempt)
            continue
        return response
    raise HTTPException(status_code=502, detail=str(last_exc) if last_exc else "text2sql retry exhausted")


async def query_text2sql_data(payload: Text2SqlRequest) -> dict[str, Any]:
    text2sql_url = f"{text2sql_base_url()}/search/text2sql"
    headers = text2sql_headers()

    rows_per_page = int(os.getenv("TEXT2SQL_ROWS_PER_PAGE", "50"))
    ui_language = resolve_ui_language(payload.ui_language, payload.query)
    request_json = build_text2sql_request_json(
        payload,
        ui_language=ui_language,
        rows_per_page=rows_per_page,
    )

    response = await _post_text2sql_with_retry(text2sql_url, request_json, headers)

    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        upstream_body: Any = response.json()
    else:
        upstream_body = response.text

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail={
                "upstream_status": response.status_code,
                "upstream_body": upstream_body,
            },
        )

    raw_rows = upstream_body.get("result", []) if isinstance(upstream_body, dict) else []
    rows = raw_rows if isinstance(raw_rows, list) else []
    page_filled = rows_per_page > 0 and len(rows) == rows_per_page
    question_hashed = reusable_text2sql_question_hash(upstream_body, has_more=page_filled)
    has_more = bool(question_hashed)

    return {
        "configured": True,
        "query": payload.query,
        "ui_language": ui_language,
        "answer": upstream_body.get("answer", "") if isinstance(upstream_body, dict) else "",
        "error": upstream_body.get("error", "") if isinstance(upstream_body, dict) else "",
        "result_count": (len(rows) if isinstance(upstream_body, dict) else None),
        "rows": (rows[:rows_per_page] if isinstance(upstream_body, dict) else []),
        "page": payload.page,
        "rows_per_page": rows_per_page,
        "question_hashed": question_hashed,
        "has_more": has_more,
        "sql_query": (
            upstream_body.get("sql_query", "") if isinstance(upstream_body, dict) else ""
        ),
        "diagnostic": _text2sql_diagnostic(upstream_body),
        # VOICE-AGENT-093: neutral same-name-cluster flag from the API
        # (FASTAPI-TEXT2SQL-157). Surfaced top-level so both the Realtime tool output
        # and the /text-chat model see it and can disambiguate homonyms/duplicate titles.
        "name_ambiguity": (
            upstream_body.get("name_ambiguity") if isinstance(upstream_body, dict) else None
        ),
        "upstream": upstream_body,
    }


async def get_entity_detail_data(entity: str, args: dict[str, Any]) -> dict[str, Any]:
    config = DETAIL_ENTITY_CONFIG.get(entity)
    if not config:
        raise HTTPException(status_code=404, detail=f"Unsupported detail entity: {entity}")

    try:
        relative_endpoint, entity_id = detail_endpoint(entity, args)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    detail_url = f"{text2sql_base_url()}{relative_endpoint}"
    ui_language = normalize_ui_language(args.get("ui_language"))
    try:
        params = detail_query_params(args, ui_language)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    endpoint = f"{relative_endpoint}?{urlencode(params)}"
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.get(
                detail_url,
                headers=text2sql_headers(),
                params=params,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        upstream_body: Any = response.json()
    else:
        upstream_body = response.text

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail={
                "upstream_status": response.status_code,
                "upstream_body": upstream_body,
            },
        )

    return {
        "configured": True,
        "entity": entity,
        "id_name": config["id_name"],
        "id": entity_id,
        "ui_language": ui_language,
        "endpoint": f"GET {endpoint}",
        "detail": upstream_body,
    }


async def execute_text_tool(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    # VOICE-AGENT-149: the verdicts, not the dated line. This path already prepends the line
    # to its input, but it needs `_date_status` for the same reason the voice path does: the
    # model reading a 2024 release date against what it believes about the title is a
    # property of the model, not of the transport.
    if tool_name == "query_text2sql":
        return _with_date_status(await query_text2sql_data(
            Text2SqlRequest(
                query=str(args.get("query") or ""),
                ui_language=args.get("ui_language") or None,
                page=int(args.get("page") or 1),
                question_hashed=args.get("question_hashed") or None,
            )
        ))

    entity = DETAIL_TOOL_BY_NAME.get(tool_name)
    if not entity:
        return {"error": f"Unsupported tool: {tool_name}"}

    try:
        return _with_date_status(await get_entity_detail_data(entity, args))
    except HTTPException as exc:
        if exc.status_code == 400:
            return {"error": str(exc.detail)}
        raise


def detail_args_from_context_item(item: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    tool_name = str(item.get("tool_name", "")).strip()
    entity = DETAIL_TOOL_BY_NAME.get(tool_name)
    if not entity:
        return None

    config = DETAIL_ENTITY_CONFIG[entity]
    path_params = config.get("path_params") or [
        {
            "name": config["id_param"],
            "id_name": config["id_name"],
            "type": config["id_type"],
        }
    ]
    args: dict[str, Any] = {}
    stored_id = item.get("id")
    if isinstance(stored_id, dict):
        for param in path_params:
            value = stored_id.get(param["name"], stored_id.get(param["id_name"]))
            if value is not None and value != "":
                args[param["name"]] = value
    elif stored_id is not None and stored_id != "" and len(path_params) == 1:
        args[path_params[0]["name"]] = stored_id

    endpoint = str(item.get("endpoint") or "").strip()
    if endpoint and len(args) < len(path_params):
        endpoint_path = endpoint.split(" ", 1)[-1].split("?", 1)[0].strip("/")
        parts = endpoint_path.split("/")
        if parts and parts[0] == config["path"] and len(parts[1:]) >= len(path_params):
            for param, value in zip(path_params, parts[1:]):
                args.setdefault(param["name"], value)

    ui_language = item.get("ui_language")
    if ui_language:
        args["ui_language"] = normalize_ui_language(ui_language)

    if all(str(args.get(param["name"], "")).strip() for param in path_params):
        return tool_name, args
    return None


def latest_detail_tool_context(context: list[dict[str, Any]]) -> tuple[str, dict[str, Any]] | None:
    for item in reversed(context):
        if not isinstance(item, dict) or item.get("type") != "tool":
            continue
        detail_context = detail_args_from_context_item(item)
        if detail_context:
            return detail_context
    return None


@app.post("/text-chat")
async def text_chat(payload: TextChatRequest) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Missing message")

    # VOICE-AGENT-118. /text-chat takes a JSON payload and no Request object, so the persona
    # slug travels in the body here while the voice path puts it on the /session query string.
    active_soul = resolve_soul(payload.soul)
    model = os.getenv("OPENAI_TEXT_MODEL", "gpt-5.1")
    verbose_detail_request = is_verbose_detail_request(message)
    generic_verbose_detail_request = is_generic_verbose_detail_request(message)
    # VOICE-AGENT-104: pre-fetch the active entity's verbose detail not only on the terse
    # anchored "tell me more" phrases but also when the message is a rich background
    # question (production / release / reception / writing) about the entity already on
    # screen. Guarded by an existing active-entity detail context so a brand-new search
    # never triggers it, and the forced query_text2sql still runs underneath.
    background_detail_request = is_background_detail_request(message)
    active_detail_context = latest_detail_tool_context(payload.context)
    latest_detail_context = (
        active_detail_context
        if active_detail_context
        and (generic_verbose_detail_request or background_detail_request)
        else None
    )
    context_lines = []
    # VOICE-AGENT-093 diagnostic: how many same-name candidates the INCOMING context
    # carried. On a selection turn this must be > 0 for the model to resolve the choice
    # by id; a 0 here (with a name_ambiguity offered the turn before) means the browser
    # did not retain them — typically a stale cached app.js.
    carried_candidate_count = 0
    for item in payload.context[-10:]:
        item_type = str(item.get("type", "")).strip()
        text = str(item.get("text", "")).strip()
        if item_type in {"user", "assistant"} and text:
            context_lines.append(f"{item_type}: {text}")
        elif item_type == "tool":
            tool_name = str(item.get("tool_name", "tool")).strip()
            entity = str(item.get("entity", "")).strip()
            item_id = item.get("id")
            endpoint = str(item.get("endpoint", "")).strip()
            detail_bits = [f"tool: {tool_name}"]
            if entity:
                detail_bits.append(f"entity={entity}")
            if item_id is not None and item_id != "":
                detail_bits.append(f"id={json.dumps(item_id, ensure_ascii=False)}")
            if endpoint:
                detail_bits.append(f"endpoint={endpoint}")
            # VOICE-AGENT-093: surface the retained same-name candidates + their IDs so a
            # later selection reply ("the director") can be resolved from this list rather
            # than from a fresh search of the reply text (see DISAMBIGUATION_TEXT_ADDENDUM).
            name_ambiguity = item.get("name_ambiguity")
            if isinstance(name_ambiguity, dict) and name_ambiguity.get("candidates"):
                carried_candidate_count = max(
                    carried_candidate_count, len(name_ambiguity["candidates"])
                )
                candidate_bits = []
                for candidate in name_ambiguity["candidates"][:12]:
                    discriminator = candidate.get("discriminator") or {}
                    disc_str = ", ".join(
                        f"{key}={value}"
                        for key, value in discriminator.items()
                        if value not in (None, "")
                    )
                    label = str(candidate.get("display") or "").strip()
                    candidate_bits.append(
                        f"id={json.dumps(candidate.get('id'), ensure_ascii=False)} "
                        f"{label} ({disc_str})".strip()
                    )
                detail_bits.append(
                    "name_ambiguity anchor="
                    + json.dumps(name_ambiguity.get("anchor"), ensure_ascii=False)
                    + " candidates=[" + "; ".join(candidate_bits) + "]"
                )
            context_lines.append(" ".join(detail_bits).strip())

    # VOICE-AGENT-143: the date also travels in the INPUT, not only in the instructions.
    # Measured 2026-07-29 on the exact turn that motivated the ticket: with the date only in
    # the instructions (last of ~4500 words of operational prose) the model still answered
    # "episode 5" and filed an episode broadcast three days earlier under "still to come".
    # It never compared the dates because the clock was nowhere near the facts. Sitting at
    # the head of the input, one line above the conversation and the tool result it reasons
    # over, it is read at the moment the dates are.
    input_text = (
        current_date_line()
        + "\n\nRecent conversation context:\n"
        + ("\n".join(context_lines) if context_lines else "(none)")
        + "\n\nUser message:\n"
        + message
    )
    ui_language = detect_ui_language_from_text(message)
    initial_text2sql_args = {
        "query": message,
        "ui_language": ui_language,
        "page": 1,
    }
    # VOICE-AGENT-095: on a disambiguation SELECTION turn (an earlier turn offered
    # name_ambiguity candidates the browser still carries), do NOT pre-force
    # query_text2sql. Forcing a search of a selection phrase ("the most recent one",
    # "yes, that one") returns junk / 0 rows whose grid BLANKS the screen (the forced
    # query drives the render). Instead let the model resolve the pick from the carried
    # candidates and call the detail tool itself; if the message is actually a new
    # unrelated question it still has query_text2sql as an auto tool. This finally does
    # the "don't re-force" deferred in VOICE-AGENT-093.
    is_selection_turn = carried_candidate_count > 0
    initial_text2sql_output = (
        None
        if is_selection_turn
        else await execute_text_tool("query_text2sql", initial_text2sql_args)
    )
    # VOICE-AGENT-103: persona comes from SOUL.md, not from inline prose. VOICE-AGENT-118:
    # the persona is selected per request (payload `soul`) and owns the length delta; only the
    # operational instructions below stay inline.
    instructions = (
        soul_instructions(active_soul)
        + " " + TEXT_LENGTH_DIRECTIVES[active_soul.brevity] + " "
        "The server has already executed query_text2sql for the user's typed "
        "message and provided the result in the input. Base your answer on "
        "that tool result, not on pretraining. If the user asks for details "
        "about a specific returned entity, call the dedicated detail tool with "
        "that entity ID, or wikidata_id for locations. Seasons use ID_SERIE plus "
        "SEASON_NUMBER; episodes use ID_SERIE, SEASON_NUMBER, and EPISODE_NUMBER. "
        "Pass ui_language to search and detail tools, using fr for French "
        "questions and en otherwise. Use returned tool data "
        "to answer in plain text. When wikipedia_content is returned for an "
        "entity, use it as grounding for questions asking for background, "
        "history, biography, plot context, or explanatory details. Do not "
        "produce audio. "
        + ("" if active_soul.brevity == "expansive" else TEXT_SUBTITLE_BREVITY)
        + "IDs are "
        "internal tool arguments only: never mention IMDb, Wikidata, TMDb, "
        "TVDB, ID_* fields, or any other database identifiers in user-facing "
        "subtitle text. Use entity names and titles; include the visible year "
        "or subtitle when it distinguishes duplicate titles. Do not enumerate "
        "cards with result numbers unless the user explicitly asks for "
        "numbered output."
    )
    instructions += (
        " " + VERBOSE_DETAIL_INSTRUCTIONS
        + " " + RECOVERY_INSTRUCTIONS
        + " " + RESULT_COUNT_INSTRUCTIONS
        + " " + DISAMBIGUATION_INSTRUCTIONS
        + " " + DISAMBIGUATION_TEXT_ADDENDUM
        + " " + GROUNDED_ABSENCE_INSTRUCTIONS
        # VOICE-AGENT-143: recomputed on every typed turn, so the text path is always exact.
        + " " + current_date_instructions()
    )
    request_base = {
        "model": model,
        "instructions": instructions,
        "tools": text_tool_definitions(),
        "tool_choice": "auto",
        "store": False,
    }
    input_items: list[Any] = [
        {
            "role": "user",
            "content": input_text,
        },
    ]
    tool_outputs: list[dict[str, Any]] = []
    if initial_text2sql_output is not None:
        input_items.append({
            "role": "user",
            "content": (
                "query_text2sql tool output for the user message:\n"
                + json.dumps(initial_text2sql_output)
            ),
        })
        tool_outputs.append({
            "name": "query_text2sql",
            "args": initial_text2sql_args,
            "output": initial_text2sql_output,
            "forced": True,
        })
    else:
        # VOICE-AGENT-095: selection turn — no forced query. Tell the model the carried
        # candidates are its source and it must fetch the resolved detail (or run
        # query_text2sql itself if this is actually a new question).
        input_items.append({
            "role": "user",
            "content": (
                "No query_text2sql was pre-executed for this message: the conversation "
                "context above carries a name_ambiguity candidate list, so treat this "
                "message as a possible selection among those candidates. If it selects or "
                "confirms one candidate (directly, indirectly, or as a confirmation), call "
                "that candidate's detail tool with its id now and answer from it. If it is "
                "instead a new question unrelated to the candidates, call query_text2sql "
                "yourself with the user's message."
            ),
        })
    if latest_detail_context:
        detail_tool_name, detail_args = latest_detail_context
        detail_args = {**detail_args, "ui_language": ui_language}
        verbose_detail_output = await execute_text_tool(detail_tool_name, detail_args)
        input_items.append(
            {
                "role": "user",
                "content": (
                    "Verbose detail tool output for the user's generic tell-me-more request. "
                    "Answer from this without calling the same detail tool again unless it is insufficient:\n"
                    + json.dumps(
                        compact_detail_for_model(verbose_detail_output, verbose=True, intent_text=message),
                        ensure_ascii=False,
                    )
                ),
            }
        )
        tool_outputs.append({
            "name": detail_tool_name,
            "args": detail_args,
            "output": verbose_detail_output,
            "forced": True,
            "verbose": True,
        })
    upstream_body: Any = {}

    async with httpx.AsyncClient(timeout=60) as client:
        for _ in range(6):
            try:
                response = await client.post(
                    "https://api.openai.com/v1/responses",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={**request_base, "input": input_items},
                )
            except httpx.HTTPError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

            content_type = response.headers.get("content-type", "")
            if "application/json" in content_type:
                upstream_body = response.json()
            else:
                upstream_body = response.text

            if response.status_code >= 400:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=upstream_body,
                )
            if not isinstance(upstream_body, dict):
                break

            output_items = upstream_body.get("output", [])
            function_calls = [
                item for item in output_items
                if isinstance(item, dict) and item.get("type") == "function_call"
            ]
            if not function_calls:
                break

            input_items.extend(output_items)
            for call in function_calls:
                tool_name = str(call.get("name", ""))
                try:
                    arguments = json.loads(call.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                if isinstance(arguments, dict):
                    arguments["ui_language"] = ui_language
                output = await execute_text_tool(tool_name, arguments)
                tool_outputs.append({
                    "name": tool_name,
                    "args": arguments,
                    "output": output,
                    "verbose": bool(verbose_detail_request and DETAIL_TOOL_BY_NAME.get(tool_name)),
                })
                model_output = (
                    compact_detail_for_model(output, verbose=verbose_detail_request, intent_text=message)
                    if DETAIL_TOOL_BY_NAME.get(tool_name)
                    else output
                )
                input_items.append({
                    "type": "function_call_output",
                    "call_id": call.get("call_id"),
                    "output": json.dumps(model_output),
                })

    output_text = extract_response_text(upstream_body)

    # Server-side logging for the typed /text-chat path. The browser only records
    # lengths for text turns (text_chat_sent / text_chat_success), which made typed
    # disambiguation impossible to reconstruct from the log (VOICE-AGENT-093 debugging).
    # Record the same shapes the Realtime path emits — the user message, EVERY tool call
    # (name + id, not just query_text2sql), and the assistant reply — all tagged
    # source="text-chat" so one offline harvest covers voice and text uniformly.
    write_client_log("user_transcript", {
        "source": "text-chat",
        "transcript": message,
        # VOICE-AGENT-118: which persona answered this turn (voice logs it once per session
        # via soul_selected; the text path is stateless, so it is stamped per turn).
        "soul": active_soul.slug,
        # >0 on a selection turn = the browser carried the candidates (fresh app.js);
        # 0 after a disambiguation offer = candidates lost in transit (stale app.js).
        "carried_candidate_count": carried_candidate_count,
        # VOICE-AGENT-095: True when the forced query_text2sql was skipped so it could
        # not blank the screen; the model then fetches the resolved detail itself.
        "forced_query_skipped": is_selection_turn,
    })
    for o in tool_outputs:
        name = str(o.get("name") or "")
        out = o.get("output") if isinstance(o.get("output"), dict) else {}
        if name == "query_text2sql":
            na = out.get("name_ambiguity")
            write_client_log("tool_call_success", {
                "name": "query_text2sql",
                "source": "text-chat",
                "result_count": out.get("result_count"),
                "has_more": out.get("has_more"),
                "diagnostic": out.get("diagnostic"),
                "forced": bool(o.get("forced")),
                # Surface whether the same-name flag fired, so a disambiguation turn is
                # visible in the log (VOICE-AGENT-093 / FASTAPI-TEXT2SQL-157).
                "name_ambiguity_count": (na.get("count") if isinstance(na, dict) else None),
            })
        elif DETAIL_TOOL_BY_NAME.get(name):
            write_client_log("tool_call_success", {
                "name": name,
                "source": "text-chat",
                "entity": out.get("entity") or DETAIL_TOOL_BY_NAME.get(name) or "",
                "id": (o.get("args") or {}).get("id") or out.get("id") or "",
                "forced": bool(o.get("forced")),
            })
    write_client_log("assistant_transcript", {"source": "text-chat", "transcript": output_text})

    return {
        "configured": True,
        "model": model,
        "message": message,
        "text": output_text,
        "tool_outputs": tool_outputs,
        "upstream_id": upstream_body.get("id") if isinstance(upstream_body, dict) else "",
    }


def _with_date_guardrail(payload: dict[str, Any]) -> dict[str, Any]:
    """Attach the dated precedence rule to a tool payload (VOICE-AGENT-149).

    Applied on the HTTP tool endpoints, which is the VOICE path: the browser posts the
    result straight back into the Realtime conversation as a function_call_output, so this
    line lands in the same message as the air dates the model is about to read. The text
    path is deliberately untouched: it already carries the same line at the head of its
    input and would otherwise say it twice.

    Second pass, same ticket: the dated line was necessary and not sufficient. On 2026-08-03
    the model read Anora's DAT_RELEASE of 2024-10-14, had today's date one line above it in
    the same payload, and still answered "its release date is later than today, so I can't
    treat it as already released", dropping a correct row from its answer. Asking a model to
    compare dates loses against what it believes about a title, so the comparison moved into
    code and it is handed a verdict instead of an arithmetic problem.

    The verdict rides on the row WRAPPER, beside `data` and never inside it: those row dicts
    are the same objects the browser renders cards from, so a key added inside `data` would
    surface as a column in a rendered table.

    Recomputed per call rather than cached: a container that has been up for days must not
    answer with the date it started on.
    """
    if not isinstance(payload, dict):
        return payload
    payload["today"] = current_date_guardrail()
    return _with_date_status(payload)


def _with_date_status(payload: dict[str, Any]) -> dict[str, Any]:
    """The per-record verdicts alone, without the dated line (VOICE-AGENT-149).

    Split out for the TEXT path, which already carries the dated line at the head of its
    input and would say it twice, but must still get the verdicts: the precedence rule now
    tells the model that every record carries `_date_status` and to stay silent about timing
    when it does not. Shipping that sentence on a path where the field is absent would make
    the prompt lie, and a prompt that lies about its own payload is a trap for whoever reads
    it next, model or human.
    """
    if not isinstance(payload, dict):
        return payload
    today = agent_now()[0].date()

    rows = payload.get("rows")
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, dict):
                statuses = _date_status_map(row.get("data"), today)
                if statuses:
                    row["_date_status"] = statuses

    detail = payload.get("detail")
    if isinstance(detail, dict):
        statuses = _date_status_map(detail, today)
        if statuses:
            payload["date_status"] = statuses
        # VOICE-AGENT-155: the same verdict for the episodes nested under a season sheet.
        # Top level, so it survives the compaction that may drop `detail` entirely.
        episode_summary = _episode_air_summary(detail, today)
        if episode_summary:
            payload["episode_air_status"] = episode_summary
    return payload


@app.post("/tool/text2sql")
async def query_text2sql(payload: Text2SqlRequest) -> dict[str, Any]:
    return _with_date_guardrail(await query_text2sql_data(payload))


@app.get("/tool/detail/{entity}/{entity_id}")
async def get_entity_detail(
    entity: str,
    entity_id: str,
    ui_language: str = "en",
    collection: str | None = None,
    page: int = 1,
    rows_per_page: int | None = None,
) -> dict[str, Any]:
    return _with_date_guardrail(await get_entity_detail_data(
        entity,
        {
            "id": entity_id,
            "ui_language": ui_language,
            "collection": collection,
            "page": page,
            "rows_per_page": rows_per_page,
        },
    ))


@app.get("/tool/detail/season/{id_serie}/{season_number}")
async def get_season_detail(
    id_serie: int,
    season_number: int,
    ui_language: str = "en",
    collection: str | None = None,
    page: int = 1,
    rows_per_page: int | None = None,
) -> dict[str, Any]:
    return _with_date_guardrail(await get_entity_detail_data(
        "season",
        {
            "id_serie": id_serie,
            "season_number": season_number,
            "ui_language": ui_language,
            "collection": collection,
            "page": page,
            "rows_per_page": rows_per_page,
        },
    ))


@app.get("/tool/detail/episode/{id_serie}/{season_number}/{episode_number}")
async def get_episode_detail(
    id_serie: int,
    season_number: int,
    episode_number: int,
    ui_language: str = "en",
    collection: str | None = None,
    page: int = 1,
    rows_per_page: int | None = None,
) -> dict[str, Any]:
    return _with_date_guardrail(await get_entity_detail_data(
        "episode",
        {
            "id_serie": id_serie,
            "season_number": season_number,
            "episode_number": episode_number,
            "ui_language": ui_language,
            "collection": collection,
            "page": page,
            "rows_per_page": rows_per_page,
        },
    ))


@app.get("/tool/samples")
async def get_samples(ui_language: str = "en", set: str = "sample") -> dict[str, Any]:
    """Proxy the upstream text2sql /samples endpoint.

    Returns the curated tree of suggested sample questions (each with its parsed
    `assertion` and a `simulated_result` preview) so the browser can render a launch
    showcase without database access. The API key is injected server-side, like the
    other /tool/* proxies.

    ``set`` is forwarded to the upstream: "sample" (all IS_SAMPLE) or "showcase"
    (the curated IS_SHOWCASE picks for the advisor home screen). The launch showcase
    requests "showcase".
    """
    samples_url = f"{text2sql_base_url()}/samples"
    resolved_language = normalize_ui_language(ui_language)
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.get(
                samples_url,
                headers=text2sql_headers(),
                params={"ui_language": resolved_language, "set": set},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        upstream_body: Any = response.json()
    else:
        upstream_body = response.text

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail={
                "upstream_status": response.status_code,
                "upstream_body": upstream_body,
            },
        )

    return {
        "configured": True,
        "ui_language": (
            upstream_body.get("ui_language", resolved_language)
            if isinstance(upstream_body, dict)
            else resolved_language
        ),
        "categories": (
            upstream_body.get("categories", []) if isinstance(upstream_body, dict) else []
        ),
    }


# Only events relevant to harness engineering are persisted to client.log: tool
# calls (+ their diagnostic), spoken/typed queries, and their outcomes. All UI and
# transport telemetry (focus, visibility, WebRTC/ICE, keepalive, mic, wake-lock,
# audio elements, reconnect, …) is dropped so the log stays harvestable. The browser
# still posts those events to /client-log; they are filtered here at write time.
HARNESS_LOG_EVENTS = frozenset({
    "tool_call_start",
    "tool_call_success",
    "tool_call_error",
    "user_transcript",
    "assistant_transcript",
    "text_chat_sent",
    "text_chat_success",
    "text_chat_error",
    "text_chat_cancelled",
    "realtime_text_sent",
    "reco_cards_shown",
    # VOICE-AGENT-118. Emitted once per Realtime session with the character that answered:
    # persona slug, its brevity dial, and the Realtime voice. A persona comparison is only
    # interpretable if each recording says which soul and which voice were in play.
    "session_persona",
    # VOICE-AGENT-099. Emitted right after the splash releases the page. It carries
    # handoff="animation" | "timeout" | "skipped" | "error": a "timeout" means the handoff
    # animation hung and the page would have stayed locked (body.launchSplashOpen ->
    # overflow: hidden) before the fix. Filtering this out is what left us unable to tell,
    # from a log alone, whether the splash had completed at all.
    "launch_splash_dismissed",
    # VOICE-AGENT-098. Carries the lanes' measured scroll_width. A showcase lane that is
    # hundreds of thousands of pixels wide is what made iOS drop the first swipes while
    # WebKit tiled the layer, so this is the number that says whether the cap did its job.
    "showcase_rendered",
    # VOICE-AGENT-107 (Option 2): the client-forced verbose re-fetch of the active entity on
    # a background question. Without these in the whitelist a log harvest cannot tell whether
    # Option 2 fired at all (they were dropped, which made -107 look like it never ran).
    "forced_verbose_refetch",
    "forced_verbose_refetch_error",
    # VOICE-AGENT-108: a click on a name_ambiguity candidate resolved the disambiguation; the
    # entry carries the exact "Focus on ..." selection text injected to the model.
    "disambiguation_click_resolved",
    "disambiguation_click_error",
    # VOICE-AGENT-109: data-channel size guard. "truncated" says the verbose payload had to be
    # shrunk to fit the SCTP max-message-size; the two "send_error" entries mean the guard was
    # not enough and the turn fell back to a minimal output. Without these a log harvest cannot
    # tell a healthy verbose turn from one that silently lost its grounding.
    "tool_output_truncated",
    "tool_output_send_error",
    "tool_output_send_fallback_error",
    # VOICE-AGENT-111: the holding line spoken while a slow call runs, and its counterpart
    # when it stayed silent because the model was already speaking. Missing from this list
    # they were dropped at write time, so two recorded sessions showed zero occurrences and
    # the feature looked like it had never run. That is the SAME trap this file already
    # documents for -107 four entries above: an event that is not whitelisted is not absent,
    # it is invisible, and the two cannot be told apart from a log.
    "holding_line",
    "holding_line_skipped",
    # Spoken-card highlight diagnostics. `structured_card_focus_session` (emitted once at
    # session start) says whether the structured-focus mode is active for the session;
    # `structured_card_focus` is emitted each time the model calls focus_result_card. Without
    # these whitelisted a log harvest cannot tell whether the model ever drives the highlight
    # by index (vs the title/year fallback) — the exact blind spot that made the same-title
    # disambiguation highlight impossible to diagnose from a log.
    "structured_card_focus",
    "structured_card_focus_session",
    # VOICE-AGENT-120: the same-title disambiguation highlight is driven client-side on the
    # audio-transcript timeline (no tool call), so this is the only trace that it fired — one
    # entry per candidate card as its discriminator (year/director/known_for) is spoken.
    "disambiguation_highlight",
    # VOICE-AGENT-142: a typed turn whose search failed and was therefore NOT allowed to
    # repaint the screen. Without it in the whitelist, the log shows the failed tool call but
    # not the render decision taken from it, and a screen that "did not follow the
    # conversation" is indistinguishable from a screen that was deliberately left alone.
    "forced_search_render_skipped",
})


def write_client_log(event: str, data: dict[str, Any], level: str = "info") -> None:
    """Append one JSONL entry to client.log, same shape as the browser /client-log
    route. Used server-side so the typed /text-chat path also records the
    query_text2sql diagnostic — the browser only logs it on the voice/Realtime path,
    so without this, typed-query failures are invisible to offline log harvests.
    Only harness-relevant events (HARNESS_LOG_EVENTS) are persisted; UI/transport
    telemetry is dropped. Logging must never break a request, hence the broad guard.
    """
    if event not in HARNESS_LOG_EVENTS:
        return
    now = datetime.now(timezone.utc)
    entry = {
        "ts": now.isoformat(),
        "version": APP_VERSION,
        "level": level,
        "event": event,
        "data": data or {},
    }
    try:
        log_path = CLIENT_LOG_DIR / f"client-{now.strftime('%Y%m%d')}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


@app.post("/client-log")
async def client_log(payload: ClientLogRequest) -> dict[str, bool]:
    write_client_log(payload.event, payload.data or {}, payload.level)
    return {"ok": True}
