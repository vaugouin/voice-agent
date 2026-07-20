import asyncio
import json
import os
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CLIENT_LOG_PATH = ROOT.parent / "logs" / "client.log"


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
BACKGROUND_DETAIL_TOPIC_WORDS = frozenset({
    # production
    "production", "productions", "produced", "producing", "filming", "filmed",
    "shoot", "shooting", "tournage", "produit", "coulisses",
    # release
    "release", "released", "premiere", "sortie",
    # reception
    "reception", "review", "reviews", "reviewed", "critic", "critics",
    "critical", "acclaim", "critiques", "accueil", "avis",
    # writing
    "writing", "wrote", "screenplay", "screenwriter", "screenwriting",
    "script", "scripts", "scenario", "scenariste", "ecriture", "ecrit",
})
BACKGROUND_DETAIL_TOPIC_PHRASES = (
    "box office",
    "behind the scenes",
    "making of",
)
FRENCH_MARKERS = {
    "acteur",
    "acteurs",
    "actrice",
    "actrices",
    "aimerais",
    "avec",
    "ce",
    "ces",
    "cet",
    "cette",
    "cherche",
    "combien",
    "comment",
    "dans",
    "de",
    "des",
    "dis",
    "donne",
    "donnez",
    "du",
    "elle",
    "elles",
    "est",
    "fais",
    "fait",
    "film",
    "films",
    "francais",
    "francaise",
    "il",
    "ils",
    "je",
    "la",
    "le",
    "les",
    "liste",
    "lister",
    "ma",
    "me",
    "meilleur",
    "meilleure",
    "meilleures",
    "meilleurs",
    "mes",
    "moi",
    "moins",
    "montre",
    "montrez",
    "nous",
    "par",
    "peux",
    "plus",
    "pour",
    "pourquoi",
    "pouvez",
    "quel",
    "quelle",
    "quelles",
    "quels",
    "que",
    "qui",
    "quoi",
    "realisateur",
    "realisatrice",
    "recherche",
    "reponds",
    "sans",
    "serie",
    "series",
    "ses",
    "sont",
    "sorti",
    "sortie",
    "sorties",
    "sortis",
    "sur",
    "te",
    "toi",
    "ton",
    "tres",
    "tu",
    "un",
    "une",
    "veux",
    "voudrais",
    "vous",
}
FRENCH_PHRASES = (
    "donne moi",
    "dis moi",
    "est ce que",
    "en francais",
    "peux tu",
    "qu est ce",
    "quels sont",
    "quelles sont",
    "qui est",
    "reponds en francais",
)
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
            "movements, awards, nominations, posters, and backdrops."
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
        "description": (
            "Get all fields for a TV series season by ID_SERIE and SEASON_NUMBER, "
            "including its parent series, cast, crew, posters, backdrops, and "
            "Wikipedia detail when available. Season 0 represents specials."
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
            "Get all fields for a TV series episode by ID_SERIE, SEASON_NUMBER, "
            "and EPISODE_NUMBER, including its parent season and series, cast, "
            "crew, still images, and Wikipedia detail when available."
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
    return bool(set(clean.split()) & BACKGROUND_DETAIL_TOPIC_WORDS)


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


def compact_wikipedia_content(
    detail: Any,
    *,
    verbose: bool = False,
) -> list[dict[str, str]]:
    if not isinstance(detail, dict):
        return []
    sections = detail.get("wikipedia_content")
    if not isinstance(sections, list):
        return []

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


def compact_detail_for_model(output: dict[str, Any], *, verbose: bool = False) -> dict[str, Any]:
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
        "wikipedia_content": compact_wikipedia_content(detail, verbose=verbose),
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


def realtime_session_config(
    voice: str = DEFAULT_REALTIME_VOICE,
    *,
    structured_card_focus: bool = True,
) -> dict[str, Any]:
    selected_voice = voice if voice in REALTIME_VOICES else DEFAULT_REALTIME_VOICE
    realtime_model = os.getenv("OPENAI_REALTIME_MODEL", DEFAULT_REALTIME_MODEL).strip() or DEFAULT_REALTIME_MODEL
    instructions = (
        "You are a knowledgeable cinema companion and advisor, not a search engine or "
        "database. Talk like a film connoisseur helping a friend: answer the question "
        "directly and stay on the title or person the user is currently exploring. Do "
        "NOT suggest or pivot to a different film unless the user explicitly asks for a "
        "recommendation, asks what to watch next, or signals they are done with the "
        "current subject; when they do, recommend ONLY titles that appear in the active "
        "title's own similar or recommendations lists provided in the detail tool result "
        "(these are grounded in the database). This is a hard constraint: never name a "
        "film that is not in those two lists, and never fall back on titles from your own "
        "memory or training, even if they feel like a great match. If those lists are "
        "empty or missing, say you have nothing to suggest for this title rather than "
        "inventing one. Being an advisor "
        "means answering well about what is on screen, not steering away from it. "
        "Keep spoken answers concise. When the user asks a "
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
    )
    tools = [
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
                        "description": "The user's spoken question as text.",
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
                "transcription": {
                    "model": "gpt-4o-transcribe",
                    "language": "en",
                },
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
    return HTMLResponse(
        html.replace("__APP_VERSION__", APP_VERSION),
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.post("/session", response_class=PlainTextResponse)
async def create_realtime_session(request: Request) -> PlainTextResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    sdp = (await request.body()).decode("utf-8")
    if not sdp.strip():
        raise HTTPException(status_code=400, detail="Missing SDP offer body")

    voice = agent_voice()
    use_structured_card_focus = structured_card_focus_enabled(request)
    use_spoken_subtitles = spoken_subtitles_enabled(request)
    use_user_transcript_subtitles = user_transcript_subtitles_enabled(request)

    body, boundary = multipart_form_data(
        {
            "sdp": sdp,
            "session": json.dumps(
                realtime_session_config(
                    voice,
                    structured_card_focus=use_structured_card_focus,
                )
            ),
        }
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
                data={"model": model},
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
    if tool_name == "query_text2sql":
        return await query_text2sql_data(
            Text2SqlRequest(
                query=str(args.get("query") or ""),
                ui_language=args.get("ui_language") or None,
                page=int(args.get("page") or 1),
                question_hashed=args.get("question_hashed") or None,
            )
        )

    entity = DETAIL_TOOL_BY_NAME.get(tool_name)
    if not entity:
        return {"error": f"Unsupported tool: {tool_name}"}

    try:
        return await get_entity_detail_data(entity, args)
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

    input_text = (
        "Recent conversation context:\n"
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
    instructions = (
        "You are a knowledgeable cinema companion and advisor, not a search engine or "
        "database, replying as concise text. Talk like a film connoisseur helping a "
        "friend: answer directly and stay on the title or person the user is currently "
        "exploring. Do NOT suggest or pivot to a different film unless the user explicitly "
        "asks for a recommendation, asks what to watch next, or signals they are done with "
        "the current subject; when they do, recommend ONLY titles that appear in the "
        "active title's own similar or recommendations lists provided in the tool result "
        "(these are grounded in the database). This is a hard constraint: never name a "
        "film that is not in those two lists, and never fall back on titles from your own "
        "memory or training. If those lists are empty or missing, say you have nothing to "
        "suggest for this title rather than inventing one. Being an "
        "advisor means answering well about what is on screen, not steering away from it. "
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
        "produce audio. Keep the response short enough to be readable as "
        "subtitles unless the user explicitly asks for detail. IDs are "
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
                        compact_detail_for_model(verbose_detail_output, verbose=True),
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
                    compact_detail_for_model(output, verbose=verbose_detail_request)
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


@app.post("/tool/text2sql")
async def query_text2sql(payload: Text2SqlRequest) -> dict[str, Any]:
    return await query_text2sql_data(payload)


@app.get("/tool/detail/{entity}/{entity_id}")
async def get_entity_detail(
    entity: str,
    entity_id: str,
    ui_language: str = "en",
    collection: str | None = None,
    page: int = 1,
    rows_per_page: int | None = None,
) -> dict[str, Any]:
    return await get_entity_detail_data(
        entity,
        {
            "id": entity_id,
            "ui_language": ui_language,
            "collection": collection,
            "page": page,
            "rows_per_page": rows_per_page,
        },
    )


@app.get("/tool/detail/season/{id_serie}/{season_number}")
async def get_season_detail(
    id_serie: int,
    season_number: int,
    ui_language: str = "en",
    collection: str | None = None,
    page: int = 1,
    rows_per_page: int | None = None,
) -> dict[str, Any]:
    return await get_entity_detail_data(
        "season",
        {
            "id_serie": id_serie,
            "season_number": season_number,
            "ui_language": ui_language,
            "collection": collection,
            "page": page,
            "rows_per_page": rows_per_page,
        },
    )


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
    return await get_entity_detail_data(
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
    )


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
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "version": APP_VERSION,
        "level": level,
        "event": event,
        "data": data or {},
    }
    try:
        with CLIENT_LOG_PATH.open("a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


@app.post("/client-log")
async def client_log(payload: ClientLogRequest) -> dict[str, bool]:
    write_client_log(payload.event, payload.data or {}, payload.level)
    return {"ok": True}
