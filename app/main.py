import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CLIENT_LOG_PATH = ROOT.parent / "logs" / "client.log"
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

app = FastAPI(title="Minimal Realtime WebRTC Voice Agent")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class Text2SqlRequest(BaseModel):
    query: str
    ui_language: str = "en"
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
            "IMDb/Wikidata IDs, ratings, technical flags, cast, crew, genre "
            "codes, companies, production countries, spoken languages, topics, "
            "lists, collections, movements, awards, and nominations."
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
            "movements, awards, and nominations."
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


def detail_tool_definitions() -> list[dict[str, Any]]:
    tools = []
    for config in DETAIL_ENTITY_CONFIG.values():
        id_param = config["id_param"]
        tools.append(
            {
                "type": "function",
                "name": config["tool_name"],
                "description": config["description"],
                "parameters": {
                    "type": "object",
                    "properties": {
                        id_param: {
                            "type": config["id_type"],
                            "description": f"The {config['id_name']} value to retrieve.",
                        }
                    },
                    "required": [id_param],
                    "additionalProperties": False,
                },
            }
        )
    return tools


def realtime_session_config(voice: str = DEFAULT_REALTIME_VOICE) -> dict[str, Any]:
    selected_voice = voice if voice in REALTIME_VOICES else DEFAULT_REALTIME_VOICE
    realtime_model = os.getenv("OPENAI_REALTIME_MODEL", DEFAULT_REALTIME_MODEL).strip() or DEFAULT_REALTIME_MODEL
    return {
        "type": "realtime",
        "model": realtime_model,
        "instructions": (
            "You are a concise voice data assistant. When the user asks a "
            "cinema, movie, TV, actor, director, production company, award, "
            "location, ranking, database, reporting, analytics, or text-to-SQL "
            "question, call query_text2sql with the user's spoken request as "
            "plain text. When the user asks for details about a specific returned "
            "entity, call the dedicated detail tool with that entity ID, or "
            "wikidata_id for locations. For example, for a movie plot, call "
            "get_movie_detail with ID_MOVIE and answer from the PLOT field. Use "
            "the returned detail fields to respond in a short spoken summary."
        ),
        "audio": {
            "input": {
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
        "tools": [
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
        ]
        + detail_tool_definitions(),
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


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.post("/session", response_class=PlainTextResponse)
async def create_realtime_session(request: Request) -> PlainTextResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    sdp = (await request.body()).decode("utf-8")
    if not sdp.strip():
        raise HTTPException(status_code=400, detail="Missing SDP offer body")

    voice = agent_voice()

    body, boundary = multipart_form_data(
        {
            "sdp": sdp,
            "session": json.dumps(realtime_session_config(voice)),
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

    headers = {}
    location = response.headers.get("Location")
    if location:
        headers["X-OpenAI-Call-ID"] = location.rsplit("/", 1)[-1]

    return PlainTextResponse(answer_sdp, media_type="application/sdp", headers=headers)


async def query_text2sql_data(payload: Text2SqlRequest) -> dict[str, Any]:
    text2sql_url = f"{text2sql_base_url()}/search/text2sql"
    headers = text2sql_headers()

    rows_per_page = int(os.getenv("TEXT2SQL_ROWS_PER_PAGE", "50"))
    request_json = {
        "question": payload.query if not payload.question_hashed else None,
        "question_hashed": payload.question_hashed,
        "ui_language": payload.ui_language or "en",
        "page": payload.page,
        "rows_per_page": rows_per_page,
        "retrieve_from_cache": True,
        "store_to_cache": True,
        "complex_question_processing": False,
    }
    request_json = {key: value for key, value in request_json.items() if value is not None}

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.post(text2sql_url, json=request_json, headers=headers)
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
        "query": payload.query,
        "answer": upstream_body.get("answer", "") if isinstance(upstream_body, dict) else "",
        "error": upstream_body.get("error", "") if isinstance(upstream_body, dict) else "",
        "result_count": (
            len(upstream_body.get("result", [])) if isinstance(upstream_body, dict) else None
        ),
        "rows": (
            upstream_body.get("result", [])[:rows_per_page]
            if isinstance(upstream_body, dict)
            else []
        ),
        "page": payload.page,
        "rows_per_page": rows_per_page,
        "question_hashed": (
            upstream_body.get("question_hashed") if isinstance(upstream_body, dict) else None
        ),
        "has_more": (
            len(upstream_body.get("result", [])) == rows_per_page
            if isinstance(upstream_body, dict)
            else False
        ),
        "sql_query": (
            upstream_body.get("sql_query", "") if isinstance(upstream_body, dict) else ""
        ),
        "upstream": upstream_body,
    }


async def get_entity_detail_data(entity: str, entity_id: str) -> dict[str, Any]:
    config = DETAIL_ENTITY_CONFIG.get(entity)
    if not config:
        raise HTTPException(status_code=404, detail=f"Unsupported detail entity: {entity}")

    detail_url = f"{text2sql_base_url()}/{config['path']}/{entity_id}"
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.get(detail_url, headers=text2sql_headers())
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
        "endpoint": f"GET /{config['path']}/{entity_id}",
        "detail": upstream_body,
    }


async def execute_text_tool(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    if tool_name == "query_text2sql":
        return await query_text2sql_data(
            Text2SqlRequest(
                query=str(args.get("query") or ""),
                ui_language=str(args.get("ui_language") or "en"),
                page=int(args.get("page") or 1),
                question_hashed=args.get("question_hashed") or None,
            )
        )

    entity = DETAIL_TOOL_BY_NAME.get(tool_name)
    if not entity:
        return {"error": f"Unsupported tool: {tool_name}"}

    config = DETAIL_ENTITY_CONFIG[entity]
    entity_id = (
        args.get(config["id_param"])
        or args.get("id")
        or args.get("wikidata_id")
        or args.get(config["id_name"])
    )
    if entity_id is None or str(entity_id).strip() == "":
        return {"error": f"Missing id for {tool_name}"}
    return await get_entity_detail_data(entity, str(entity_id))


@app.post("/text-chat")
async def text_chat(payload: TextChatRequest) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Missing message")

    model = os.getenv("OPENAI_TEXT_MODEL", "gpt-5.1")
    context_lines = []
    for item in payload.context[-10:]:
        item_type = str(item.get("type", "")).strip()
        text = str(item.get("text", "")).strip()
        if item_type in {"user", "assistant"} and text:
            context_lines.append(f"{item_type}: {text}")
        elif item_type == "tool":
            tool_name = str(item.get("tool_name", "tool")).strip()
            endpoint = str(item.get("endpoint", "")).strip()
            context_lines.append(f"tool: {tool_name} {endpoint}".strip())

    input_text = (
        "Recent conversation context:\n"
        + ("\n".join(context_lines) if context_lines else "(none)")
        + "\n\nUser message:\n"
        + message
    )
    initial_text2sql_args = {
        "query": message,
        "ui_language": "en",
        "page": 1,
    }
    initial_text2sql_output = await execute_text_tool("query_text2sql", initial_text2sql_args)
    instructions = (
        "You are a concise text-only assistant inside a movie database app. "
        "The server has already executed query_text2sql for the user's typed "
        "message and provided the result in the input. Base your answer on "
        "that tool result, not on pretraining. If the user asks for details "
        "about a specific returned entity, call the dedicated detail tool with "
        "that entity ID, or wikidata_id for locations. Use returned tool data "
        "to answer in plain text. Do not produce audio. Keep the response "
        "short enough to be readable as subtitles unless the user explicitly "
        "asks for detail."
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
        {
            "role": "user",
            "content": (
                "query_text2sql tool output for the user message:\n"
                + json.dumps(initial_text2sql_output)
            ),
        },
    ]
    tool_outputs: list[dict[str, Any]] = [
        {
            "name": "query_text2sql",
            "args": initial_text2sql_args,
            "output": initial_text2sql_output,
            "forced": True,
        }
    ]
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
                output = await execute_text_tool(tool_name, arguments)
                tool_outputs.append({
                    "name": tool_name,
                    "args": arguments,
                    "output": output,
                })
                input_items.append({
                    "type": "function_call_output",
                    "call_id": call.get("call_id"),
                    "output": json.dumps(output),
                })

    output_text = extract_response_text(upstream_body)

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
    text2sql_url = f"{text2sql_base_url()}/search/text2sql"
    headers = text2sql_headers()

    rows_per_page = int(os.getenv("TEXT2SQL_ROWS_PER_PAGE", "50"))
    request_json = {
        "question": payload.query if not payload.question_hashed else None,
        "question_hashed": payload.question_hashed,
        "ui_language": payload.ui_language or "en",
        "page": payload.page,
        "rows_per_page": rows_per_page,
        "retrieve_from_cache": True,
        "store_to_cache": True,
        "complex_question_processing": False,
    }
    request_json = {key: value for key, value in request_json.items() if value is not None}

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.post(text2sql_url, json=request_json, headers=headers)
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
        "query": payload.query,
        "answer": upstream_body.get("answer", "") if isinstance(upstream_body, dict) else "",
        "error": upstream_body.get("error", "") if isinstance(upstream_body, dict) else "",
        "result_count": (
            len(upstream_body.get("result", [])) if isinstance(upstream_body, dict) else None
        ),
        "rows": (
            upstream_body.get("result", [])[:rows_per_page]
            if isinstance(upstream_body, dict)
            else []
        ),
        "page": payload.page,
        "rows_per_page": rows_per_page,
        "question_hashed": (
            upstream_body.get("question_hashed") if isinstance(upstream_body, dict) else None
        ),
        "has_more": (
            len(upstream_body.get("result", [])) == rows_per_page
            if isinstance(upstream_body, dict)
            else False
        ),
        "sql_query": (
            upstream_body.get("sql_query", "") if isinstance(upstream_body, dict) else ""
        ),
        "upstream": upstream_body,
    }


@app.get("/tool/detail/{entity}/{entity_id}")
async def get_entity_detail(entity: str, entity_id: str) -> dict[str, Any]:
    config = DETAIL_ENTITY_CONFIG.get(entity)
    if not config:
        raise HTTPException(status_code=404, detail=f"Unsupported detail entity: {entity}")

    detail_url = f"{text2sql_base_url()}/{config['path']}/{entity_id}"
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.get(detail_url, headers=text2sql_headers())
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
        "endpoint": f"GET /{config['path']}/{entity_id}",
        "detail": upstream_body,
    }


@app.post("/client-log")
async def client_log(payload: ClientLogRequest) -> dict[str, bool]:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": payload.level,
        "event": payload.event,
        "data": payload.data or {},
    }
    with CLIENT_LOG_PATH.open("a", encoding="utf-8") as log_file:
        log_file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"ok": True}
