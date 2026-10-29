"""Bench of the voice layer (VOICE-AGENT-242): the same ten spoken questions, three voice stacks.

One run = one session that plays the ten clips of `audio/` in order, as one conversation, and
records every event with a timestamp. Nothing is judged here: `report.py` reads the event logs.

Arms (pick one with --arm):
  realtime        gpt-realtime-2.1 over the Realtime WebSocket, the app's own session config
                  (instructions, tools, transcription, turn detection) from app.main.
  live            GPT-Live-1 over its WebSocket, with Responses delegation: the backend model gets
                  the app's instructions and the app's tools as functions; their calls come back
                  to this script, which runs them and returns the output.
  gemini-ext      gemini-3.8-live-extended-thinking, async (NON_BLOCKING) tools.
  gemini          gemini-3.8-live, the cheap control, same tools.

What is identical across arms: the audio clips, the tool definitions and descriptions, the tool
executor (the app's own functions, calling the live fastapi-text2sql), and what the model gets
back (compact_search_for_model / compact_detail_for_model, as /text-chat does).

What is NOT the app: the browser-only tools (focus_result_card, play_trailer, read_based_on) are
stubbed with {"ok": true}, and the browser's own compaction of tool outputs (app.js) is replaced
by its Python twin. The arms are compared to each other, not to a phone session.

Audio is streamed in real time (40 ms frames, silence between clips), as a microphone would, and
the reply is "played" by a simulated speaker so the silences the user would HEAR are measured,
not the network arrival gaps. The speaker output of each session is saved as assistant.wav.

Keys: OPENAI_API_KEY and GEMINI_API_KEY from voice-agent/.env (loaded by app.main); for Gemini,
GOOGLE_API_KEY from ../fastapi-text2sql/.env is the fallback. Never printed.

Run from the repo root:
  uv run --no-project --with-requirements bench/requirements.txt python bench/voice_bench.py --arm realtime
  uv run --no-project --with-requirements bench/requirements.txt python bench/voice_bench.py --arm live --runs 3
"""
from __future__ import annotations

import argparse
import array
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Any

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent
sys.path.insert(0, str(ROOT))

from app import main as va  # noqa: E402  (loads voice-agent/.env as a side effect)

FRAME_MS = 40
VOICE_PEAK = 400        # int16 peak under which an output chunk is silence
OUT_RATE = 24000
UI_TOOLS = {"focus_result_card", "play_trailer", "read_based_on"}
ARMS = {
    "realtime": {"model": "gpt-realtime-2.1"},
    "live": {"model": "gpt-live-1"},
    "gemini-ext": {"model": "gemini-3.8-live-extended-thinking"},
    "gemini": {"model": "gemini-3.8-live"},
}


# --------------------------------------------------------------------------- audio

def load_clip(path: Path, rate: int) -> bytes:
    """Raw mono PCM16LE at `rate`, decoded and resampled by ffmpeg from any input format."""
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", str(rate), "-"],
        capture_output=True, check=True,
    )
    data = result.stdout
    return data[: len(data) - (len(data) % 2)]


def peak(pcm: bytes) -> int:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if sys.byteorder == "big":
        samples.byteswap()
    return max((abs(x) for x in samples), default=0)


def speech_end_ms(pcm: bytes, rate: int, threshold: int = 600) -> float:
    """Where the speech stops inside the clip: the last 10 ms window above `threshold`.

    The recordings keep their natural tail of room noise, so the clip end is not the end of the
    sentence. Latency is measured from this point, which is what the user experiences as "I have
    finished talking".
    """
    samples = array.array("h")
    samples.frombytes(pcm)
    if sys.byteorder == "big":
        samples.byteswap()
    window = max(1, rate // 100)
    last = 0
    for start in range(0, len(samples), window):
        chunk = samples[start:start + window]
        if chunk and max(abs(s) for s in chunk) >= threshold:
            last = start + len(chunk)
    return last * 1000.0 / rate


# --------------------------------------------------------------------------- recording

class Recorder:
    def __init__(self, path: Path):
        self.t0 = time.monotonic()
        self.file = path.open("w", encoding="utf-8")

    def now(self) -> float:
        return (time.monotonic() - self.t0) * 1000.0

    def log(self, kind: str, **fields: Any) -> dict[str, Any]:
        record = {"t": round(self.now(), 1), "kind": kind, **fields}
        self.file.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        self.file.flush()
        return record

    def close(self) -> None:
        self.file.close()


class Bench:
    """Session state shared by the arms: the current question, the simulated speaker, the tools."""

    def __init__(self, rec: Recorder, wav_path: Path, api_cache: bool):
        self.rec = rec
        self.q = "warmup"
        self.api_cache = api_cache
        self.play_cursor = 0.0          # ms: when the simulated speaker runs out of audio
        self.voiced_end = 0.0           # ms: when the last voiced audio finishes playing
        self.last_server_t = 0.0
        self.pending_tools: set[str] = set()
        self.turn: dict[str, dict[str, Any]] = {}
        self.user_texts: list[str] = []
        self.last_detail: tuple[str, dict[str, Any]] | None = None
        self.arm: Any = None
        self.dead = False               # the session died: stop waiting, stop asking
        self.closing = False
        self.wav = wave.open(str(wav_path), "wb")
        self.wav.setnchannels(1)
        self.wav.setsampwidth(2)
        self.wav.setframerate(OUT_RATE)

    def state(self, q: str | None = None) -> dict[str, Any]:
        return self.turn.setdefault(q or self.q, {
            "speech_end": None, "first_audio": None, "last_audio": None,
            "last_tool_end": None, "audio_after_tool": None,
        })

    def touch(self) -> None:
        self.last_server_t = self.rec.now()

    def log(self, kind: str, **fields: Any) -> None:
        self.touch()
        self.rec.log(kind, q=self.q, **fields)

    # The simulated speaker. Output audio arrives faster than real time; what the user hears is
    # the stream played back at real time, so a "heard gap" opens only when the speaker has
    # drained everything and the next VOICED chunk is not there yet. Voiced, because GPT-Live
    # streams its output continuously, silence included: a chunk below VOICE_PEAK counts as
    # silence, is written to the wav and advances the speaker, but is not "the agent talking".
    def audio_out(self, pcm: bytes, rate: int = OUT_RATE) -> None:
        now = self.rec.now()
        duration = len(pcm) / 2 / rate * 1000.0
        if now > self.play_cursor:
            if self.play_cursor > 0:
                silence = int(min(now - self.play_cursor, 10_000) * OUT_RATE / 1000)
                if silence > 0:
                    self.wav.writeframes(b"\0\0" * silence)
            self.play_cursor = now
        play_start = self.play_cursor
        self.play_cursor += duration
        if rate == OUT_RATE:
            self.wav.writeframes(pcm)
        if peak(pcm) < VOICE_PEAK:
            return
        self.touch()
        gap = play_start - self.voiced_end if self.voiced_end > 0 else 0.0
        self.voiced_end = self.play_cursor
        state = self.state()
        if state["speech_end"] is not None and state["first_audio"] is None and play_start >= state["speech_end"]:
            state["first_audio"] = play_start
        state["last_audio"] = play_start
        if state["last_tool_end"] is not None and state["audio_after_tool"] is None:
            state["audio_after_tool"] = play_start
        self.rec.log("audio_out", q=self.q, play=round(play_start, 1), ms=round(duration, 1), gap=round(max(gap, 0.0), 1))

    def flush_speaker(self, reason: str) -> None:
        """What the app does on an interruption: drop the queued reply audio."""
        now = self.rec.now()
        if self.voiced_end > now:
            self.log("speaker_flush", reason=reason, dropped_ms=round(self.voiced_end - now, 1))
            self.voiced_end = now
        self.play_cursor = min(self.play_cursor, now)

    # ------------------------------------------------------------------ tools

    def start_tool(self, call_id: str, name: str, args: Any) -> None:
        if isinstance(args, str):
            try:
                args = json.loads(args or "{}")
            except json.JSONDecodeError:
                args = {"_unparsed": args}
        self.pending_tools.add(call_id)
        self.log("tool_start", call_id=call_id, name=name, args=args)
        asyncio.create_task(self._run_tool(call_id, name, args or {}))

    async def _run_tool(self, call_id: str, name: str, args: dict[str, Any]) -> None:
        started = time.monotonic()
        summary: dict[str, Any] = {}
        try:
            output, summary = await self.execute(name, args)
        except Exception as exc:  # the model must get an answer whatever happens
            detail = getattr(exc, "detail", None)
            output = {"error": f"{type(exc).__name__}: {detail or exc}"}
            summary = {"error": output["error"][:300]}
        elapsed = (time.monotonic() - started) * 1000.0
        self.state()["last_tool_end"] = self.rec.now()
        self.log("tool_end", call_id=call_id, name=name, ms=round(elapsed, 1), **summary)
        try:
            await self.arm.send_tool_result(self, call_id, name, output)
        finally:
            self.pending_tools.discard(call_id)
        await self.arm.after_tool(self)

    async def execute(self, name: str, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        """Run one tool the way the app would, and return (model-facing output, log summary)."""
        if name == "query_text2sql":
            out = va._with_date_status(await va.query_text2sql_data(va.Text2SqlRequest(
                query=str(args.get("query") or ""),
                ui_language=args.get("ui_language") or None,
                page=int(args.get("page") or 1),
                question_hashed=args.get("question_hashed") or None,
            )))
            upstream = out.get("upstream") if isinstance(out.get("upstream"), dict) else {}
            return va.compact_search_for_model(out), {
                "result_count": out.get("result_count"), "error": out.get("error") or "",
                "sql": (out.get("sql_query") or "")[:400],
                "api_cached": upstream.get("cached") if upstream else None,
            }
        if name in va.DETAIL_TOOL_BY_NAME:
            out = await va.execute_text_tool(name, args)
            if not out.get("error"):
                self.last_detail = (name, args)
            return va.compact_detail_for_model(out, intent_text=self.user_texts[-1] if self.user_texts else None), {
                "error": out.get("error") or "", "entity": out.get("entity"), "id": out.get("id"),
            }
        if name == va.ASK_ABOUT_RECORD_TOOL:
            tool_name = args.get("detail_tool") or (self.last_detail[0] if self.last_detail else "")
            tool_args = args.get("detail_args") or (self.last_detail[1] if self.last_detail else {})
            if not tool_name:
                return {"error": "No record on screen."}, {"error": "no record on screen"}
            out = await va.deep_answer(va.DeepAnswerRequest(
                tool_name=tool_name, args=dict(tool_args), question=str(args.get("question") or ""),
                context=self.user_texts[-3:],
            ))
            return out, {"detail_tool": tool_name}
        if name in UI_TOOLS:
            return {"ok": True}, {"stub": True}
        return {"error": f"Unsupported tool: {name}"}, {"error": "unsupported"}

    # ------------------------------------------------------------------ turn pacing

    def idle(self) -> bool:
        now = self.rec.now()
        return (not self.pending_tools and not self.arm.busy()
                and now > self.voiced_end + 800 and now - self.last_server_t > 2500)

    async def wait_turn_end(self, q: str, cap_s: float = 120) -> str:
        state = self.state(q)
        start = self.rec.now()
        while self.rec.now() - start < cap_s * 1000 and not self.dead:
            now = self.rec.now()
            answered = state["first_audio"] is not None
            if answered and self.idle():
                return "idle"
            if not answered and now - (state["speech_end"] or start) > 20_000 and self.idle():
                return "no_audio"
            await asyncio.sleep(0.1)
        return "cap"

    async def wait_barge_point(self, q: str, delay_ms: float = 1500, cap_s: float = 90) -> str:
        """Start the barge-in clip while the answer to `q` is being spoken.

        With a tool call, "the answer" is the audio that follows the tool result, not the filler
        before it; without one, the reply is given three seconds to get going.
        """
        state = self.state(q)
        start = self.rec.now()
        while self.rec.now() - start < cap_s * 1000 and not self.dead:
            now = self.rec.now()
            if state["audio_after_tool"] is not None and now - state["audio_after_tool"] >= delay_ms:
                return "after_tool_answer"
            if (state["last_tool_end"] is None and state["first_audio"] is not None
                    and now - state["first_audio"] >= 3000 and not self.pending_tools):
                return "no_tool_answer"
            await asyncio.sleep(0.05)
        return "cap"


class AudioPump:
    """Streams the microphone: a clip when one is playing, silence otherwise, in real time."""

    def __init__(self, bench: Bench, rate: int):
        self.bench = bench
        self.rate = rate
        self.frame = rate * 2 * FRAME_MS // 1000
        self.clip = b""
        self.pos = 0
        self.speech_end_bytes = 0
        self.speech_logged = True
        self.done = asyncio.Event()
        self.stopped = False

    async def play(self, pcm: bytes, speech_end: float) -> None:
        self.done.clear()
        self.speech_end_bytes = int(speech_end * self.rate / 1000) * 2
        self.speech_logged = False
        self.clip, self.pos = pcm, 0
        await self.done.wait()

    async def run(self) -> None:
        next_t = time.monotonic()
        while not self.stopped:
            if self.pos < len(self.clip):
                chunk = self.clip[self.pos:self.pos + self.frame]
                self.pos += len(chunk)
                if not self.speech_logged and self.pos >= self.speech_end_bytes:
                    self.speech_logged = True
                    self.bench.state()["speech_end"] = self.bench.rec.now()
                    self.bench.rec.log("clip_speech_end", q=self.bench.q)
                if self.pos >= len(self.clip):
                    self.bench.rec.log("clip_end", q=self.bench.q)
                    self.done.set()
                if len(chunk) < self.frame:
                    chunk += b"\0" * (self.frame - len(chunk))
            else:
                chunk = b"\0" * self.frame
            try:
                await self.bench.arm.send_audio(chunk)
            except Exception as exc:
                self.bench.rec.log("audio_send_error", error=str(exc)[:300])
                self.bench.dead = True
                self.stopped = True
                self.done.set()
                return
            next_t += FRAME_MS / 1000
            await asyncio.sleep(max(0.0, next_t - time.monotonic()))


# --------------------------------------------------------------------------- the app's session

def app_session(voice: str | None = None) -> tuple[dict[str, Any], Any]:
    """The Realtime session the app would open: instructions, tools, transcription, VAD."""
    soul = va.resolve_soul()
    selected = voice or soul.voice or va.agent_voice()
    return va.realtime_session_config(selected, structured_card_focus=True, soul=soul), soul


def function_tools(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"name": t["name"], "description": t.get("description", ""), "parameters": t.get("parameters") or {}}
        for t in cfg["tools"] if t.get("type") == "function"
    ]


# --------------------------------------------------------------------------- arm A: Realtime

class RealtimeArm:
    rate_in = 24000

    def __init__(self, model: str, voice: str | None):
        self.model, self.voice = model, voice
        self.active_response = False
        self.want_response = False

    async def open(self, bench: Bench) -> dict[str, Any]:
        from openai import AsyncOpenAI

        cfg, soul = app_session(self.voice)
        cfg["model"] = self.model
        cfg["audio"]["input"]["format"] = {"type": "audio/pcm", "rate": 24000}
        cfg["audio"]["output"]["format"] = {"type": "audio/pcm", "rate": OUT_RATE}
        self.client = AsyncOpenAI()
        self.cm = self.client.realtime.connect(model=self.model)
        self.conn = await self.cm.__aenter__()
        await self.conn.send({"type": "session.update", "session": cfg})
        return {"model": self.model, "voice": cfg["audio"]["output"]["voice"], "soul": soul.slug,
                "instructions_chars": len(cfg["instructions"]), "tools": [t["name"] for t in function_tools(cfg)],
                "turn_detection": cfg["audio"]["input"].get("turn_detection")}

    async def send_audio(self, pcm: bytes) -> None:
        await self.conn.send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode()})

    def busy(self) -> bool:
        return self.active_response

    async def events(self, bench: Bench) -> None:
        async for event in self.conn:
            d = event.model_dump(exclude_none=True) if hasattr(event, "model_dump") else dict(event)
            kind = d.get("type", "")
            if kind == "response.output_audio.delta":
                bench.audio_out(base64.b64decode(d["delta"]))
            elif kind == "response.created":
                self.active_response = True
                bench.touch()
            elif kind == "response.done":
                self.active_response = False
                response = d.get("response") or {}
                bench.log("usage", source="realtime", model=self.model, status=response.get("status"),
                          usage=response.get("usage"))
                if self.want_response and not bench.pending_tools:
                    self.want_response = False
                    await self.conn.send({"type": "response.create"})
            elif kind == "response.output_item.done" and (d.get("item") or {}).get("type") == "function_call":
                item = d["item"]
                bench.start_tool(item["call_id"], item["name"], item.get("arguments"))
            elif kind == "conversation.item.input_audio_transcription.completed":
                text = d.get("transcript", "")
                bench.user_texts.append(text)
                bench.log("user_transcript", text=text)
            elif kind == "response.output_audio_transcript.done":
                bench.log("assistant_transcript", text=d.get("transcript", ""))
            elif kind == "input_audio_buffer.speech_started":
                bench.log("interrupt_signal", source="speech_started")
                bench.flush_speaker("speech_started")
            elif kind == "input_audio_buffer.speech_stopped":
                bench.log("vad_speech_stopped")
            elif kind == "error":
                bench.log("error", error=d.get("error"))
            elif kind in ("session.created", "session.updated"):
                bench.log(kind)

    async def send_tool_result(self, bench: Bench, call_id: str, name: str, output: Any) -> None:
        await self.conn.send({"type": "conversation.item.create", "item": {
            "type": "function_call_output", "call_id": call_id,
            "output": json.dumps(output, ensure_ascii=False, default=str),
        }})

    async def after_tool(self, bench: Bench) -> None:
        if bench.pending_tools:
            return
        if self.active_response:
            self.want_response = True
        else:
            await self.conn.send({"type": "response.create"})

    async def close(self, bench: Bench) -> None:
        await self.cm.__aexit__(None, None, None)


# --------------------------------------------------------------------------- arm B: GPT-Live

LIVE_VOICE_INSTRUCTIONS = (
    "You are the spoken voice of a movie and TV database app. For any question about movies, "
    "series, people, awards, lists, rankings, or anything that needs the database, delegate it: "
    "the backend owns the database tools and the rules for using them. Say only what the backend "
    "returns; never invent a title, a date, a number or a name. A remark that is not a question "
    "gets a short spoken reply and no delegation. Answer in the language the user speaks."
)


class LiveArm:
    rate_in = 24000

    def __init__(self, model: str, voice: str, backend_model: str, effort: str):
        self.model, self.voice = model, voice
        self.backend_model, self.effort = backend_model, effort
        self.active = 0
        self.closed = asyncio.Event()

    async def open(self, bench: Bench) -> dict[str, Any]:
        from openai import AsyncOpenAI

        cfg, soul = app_session()
        backend_instructions = (
            cfg["instructions"]
            + " Your reply is spoken aloud by a separate voice model: write short plain sentences, "
            "no lists, no markdown."
        )
        tools = [{"type": "function", "strict": False, **t} for t in function_tools(cfg)]
        live_instructions = va.soul_instructions(soul) + " " + LIVE_VOICE_INSTRUCTIONS
        self.client = AsyncOpenAI()
        self.cm = self.client.live.connect()
        self.conn = await self.cm.__aenter__()
        responses: dict[str, Any] = {
            "model": self.backend_model, "instructions": backend_instructions, "tools": tools,
            "tool_choice": "auto", "parallel_tool_calls": False,
        }
        if self.effort:
            responses["reasoning"] = {"effort": self.effort}
        await self.conn.send({"type": "session.start", "event_id": "evt_start", "session": {
            "model": self.model,
            "instructions": live_instructions,
            "audio": {"format": {"type": "audio/pcm", "rate": 24000}, "output": {"voice": self.voice}},
            "delegation": {"type": "responses", "responses": responses},
        }})
        return {"model": self.model, "voice": self.voice, "soul": soul.slug,
                "backend_model": self.backend_model, "effort": self.effort,
                "instructions_chars": len(live_instructions), "backend_instructions_chars": len(backend_instructions),
                "tools": [t["name"] for t in tools]}

    async def send_audio(self, pcm: bytes) -> None:
        await self.conn.send({"type": "session.input_audio.append", "audio": base64.b64encode(pcm).decode()})

    def busy(self) -> bool:
        return self.active > 0

    async def events(self, bench: Bench) -> None:
        async for event in self.conn:
            d = event.model_dump(exclude_none=True) if hasattr(event, "model_dump") else dict(event)
            kind = d.get("type", "")
            if kind == "session.output_audio.delta":
                bench.audio_out(base64.b64decode(d["delta"]))
            elif kind == "session.input_transcript.delta":
                bench.log("user_transcript_delta", text=d.get("delta", ""))
            elif kind == "session.output_transcript.delta":
                bench.log("assistant_transcript_delta", text=d.get("delta", ""))
            elif kind == "session.delegation.created":
                bench.log("delegation", delegation=d.get("delegation"))
            elif kind == "response.event":
                await self._backend_event(bench, d.get("event") or {}, d.get("delegation_id"))
            elif kind == "session.usage.updated":
                bench.log("live_usage", usage=d.get("usage"), context_window=d.get("context_window"))
            elif kind == "session.closed":
                bench.log("session_closed", usage=d.get("usage"), reason=d.get("reason"))
                self.closed.set()
                return
            elif kind == "error":
                bench.log("error", error=d.get("error"))
            elif kind in ("session.started", "session.updated"):
                bench.log(kind)

    async def _backend_event(self, bench: Bench, nested: dict[str, Any], delegation_id: Any) -> None:
        kind = nested.get("type", "")
        if kind == "response.created":
            self.active += 1
            bench.log("backend_response_created", delegation_id=delegation_id)
        elif kind in ("response.completed", "response.done", "response.failed", "response.incomplete",
                      "response.cancelled"):
            self.active = max(0, self.active - 1)
            response = nested.get("response") or {}
            bench.log("usage", source="backend", model=self.backend_model, status=response.get("status"),
                      usage=response.get("usage"), delegation_id=delegation_id)
        elif kind == "response.output_item.done" and (nested.get("item") or {}).get("type") == "function_call":
            item = nested["item"]
            bench.start_tool(item["call_id"], item["name"], item.get("arguments"))
        elif kind == "error":
            bench.log("error", source="backend", error=nested)
        else:
            bench.touch()

    async def send_tool_result(self, bench: Bench, call_id: str, name: str, output: Any) -> None:
        await self.conn.send({"type": "response.item.create", "item": {
            "type": "function_call_output", "call_id": call_id,
            "output": json.dumps(output, ensure_ascii=False, default=str),
        }})

    async def after_tool(self, bench: Bench) -> None:
        if not bench.pending_tools:
            await self.conn.send({"type": "response.create", "event_id": f"evt_continue_{int(time.time() * 1000)}"})

    async def close(self, bench: Bench) -> None:
        try:
            await self.conn.send({"type": "session.close"})
            await asyncio.wait_for(self.closed.wait(), timeout=15)
        except Exception as exc:
            bench.log("close_unconfirmed", error=str(exc)[:200])
        await self.cm.__aexit__(None, None, None)


# --------------------------------------------------------------------------- arm C: Gemini Live

def gemini_key() -> str:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if key and not key.startswith("your-"):
        return key
    env = ROOT.parent / "fastapi-text2sql" / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("GOOGLE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("No Gemini key: set GEMINI_API_KEY in voice-agent/.env")


class GeminiArm:
    rate_in = 16000

    def __init__(self, model: str, voice: str | None, thinking_level: str | None, scheduling: str):
        self.model, self.voice = model, voice
        self.thinking_level, self.scheduling = thinking_level, scheduling
        self.generating = False
        self.status = "IDLE"

    async def open(self, bench: Bench) -> dict[str, Any]:
        from google import genai
        from google.genai import types

        self.types = types
        cfg, soul = app_session()
        declarations = [
            types.FunctionDeclaration(
                name=t["name"], description=t["description"], parameters_json_schema=t["parameters"],
                behavior=types.Behavior.NON_BLOCKING,
            )
            for t in function_tools(cfg)
        ]
        config: dict[str, Any] = {
            "response_modalities": ["AUDIO"],
            "system_instruction": cfg["instructions"],
            "tools": [types.Tool(function_declarations=declarations)],
            "input_audio_transcription": types.AudioTranscriptionConfig(),
            "output_audio_transcription": types.AudioTranscriptionConfig(),
        }
        if self.voice:
            config["speech_config"] = types.SpeechConfig(voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=self.voice)))
        if self.thinking_level:
            config["thinking_config"] = types.ThinkingConfig(thinking_level=self.thinking_level)
        self.client = genai.Client(api_key=gemini_key())
        self.cm = self.client.aio.live.connect(model=self.model, config=types.LiveConnectConfig(**config))
        self.session = await self.cm.__aenter__()
        return {"model": self.model, "voice": self.voice, "soul": soul.slug, "thinking_level": self.thinking_level,
                "scheduling": self.scheduling, "instructions_chars": len(cfg["instructions"]),
                "tools": [d.name for d in declarations]}

    async def send_audio(self, pcm: bytes) -> None:
        await self.session.send_realtime_input(
            audio=self.types.Blob(data=pcm, mime_type=f"audio/pcm;rate={self.rate_in}"))

    def busy(self) -> bool:
        return self.generating or self.status not in ("IDLE", "INTERACTION_STATUS_UNSPECIFIED")

    async def events(self, bench: Bench) -> None:
        while True:
            async for msg in self.session.receive():
                content = msg.server_content
                if content:
                    if content.model_turn and content.model_turn.parts:
                        self.generating = True
                        for part in content.model_turn.parts:
                            if part.inline_data and part.inline_data.data:
                                bench.audio_out(part.inline_data.data)
                    if content.input_transcription and content.input_transcription.text:
                        bench.user_texts.append(content.input_transcription.text)
                        bench.log("user_transcript_delta", text=content.input_transcription.text)
                    if content.output_transcription and content.output_transcription.text:
                        bench.log("assistant_transcript_delta", text=content.output_transcription.text)
                    if content.interrupted:
                        bench.log("interrupt_signal", source="interrupted")
                        bench.flush_speaker("interrupted")
                    if content.interaction_status:
                        self.status = str(getattr(content.interaction_status, "value", content.interaction_status))
                        bench.log("interaction_status", status=self.status)
                    if content.turn_complete:
                        self.generating = False
                        bench.log("turn_complete", reason=str(content.turn_complete_reason or ""))
                if msg.tool_call and msg.tool_call.function_calls:
                    for call in msg.tool_call.function_calls:
                        bench.start_tool(call.id or call.name, call.name, dict(call.args or {}))
                if msg.tool_call_cancellation:
                    bench.log("tool_cancelled", ids=msg.tool_call_cancellation.ids)
                if msg.usage_metadata:
                    bench.log("usage", source="gemini", model=self.model,
                              usage=msg.usage_metadata.model_dump(exclude_none=True, mode="json"))
                if msg.go_away:
                    bench.log("go_away", detail=str(msg.go_away))

    async def send_tool_result(self, bench: Bench, call_id: str, name: str, output: Any) -> None:
        types = self.types
        response = json.loads(json.dumps(output, ensure_ascii=False, default=str))
        await self.session.send_tool_response(function_responses=[types.FunctionResponse(
            id=call_id, name=name, response={"output": response},
            scheduling=getattr(types.FunctionResponseScheduling, self.scheduling) if self.scheduling else None,
        )])

    async def after_tool(self, bench: Bench) -> None:
        return None

    async def close(self, bench: Bench) -> None:
        await self.cm.__aexit__(None, None, None)


# --------------------------------------------------------------------------- one session

def build_arm(args: argparse.Namespace) -> Any:
    model = args.model or ARMS[args.arm]["model"]
    if args.arm == "realtime":
        return RealtimeArm(model, args.voice)
    if args.arm == "live":
        return LiveArm(model, args.voice or "marin", args.backend_model, args.backend_effort)
    level = args.thinking_level if args.arm == "gemini-ext" else None
    # Extended Thinking rejects any scheduling ("Function response scheduling is not supported
    # for this model", WebSocket close 1007, seen 2026-10-28): on that arm the model decides.
    scheduling = args.scheduling
    if scheduling == "auto":
        scheduling = None if args.arm == "gemini-ext" else "WHEN_IDLE"
    return GeminiArm(model, args.gemini_voice, level, None if scheduling == "none" else scheduling)


def install_api_cache_switch(enabled: bool) -> None:
    """Make every arm pay the full API pipeline (default), or let the 1.1.19 cache answer.

    Without this, the first arm to ask a question fills T_WC_T2S_CACHE and every later arm gets
    the answer in milliseconds: the bench would measure the run order, not the voice layers.
    """
    original = va.build_text2sql_request_json

    def patched(*a: Any, **k: Any) -> dict[str, Any]:
        body = original(*a, **k)
        body["retrieve_from_cache"] = enabled
        body["store_to_cache"] = enabled
        return body

    va.build_text2sql_request_json = patched


async def run_session(args: argparse.Namespace, questions: list[dict[str, Any]], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    rec = Recorder(out_dir / "events.jsonl")
    bench = Bench(rec, out_dir / "assistant.wav", args.api_cache == "on")
    arm = build_arm(args)
    bench.arm = arm
    clips = {}
    for q in questions:
        pcm = load_clip(Path(args.audio_dir) / f"{q['id']}.wav", arm.rate_in)
        clips[q["id"]] = (pcm, speech_end_ms(pcm, arm.rate_in))

    meta = await arm.open(bench)
    session_info = {
        "arm": args.arm, "run": out_dir.name, "started": datetime.now().isoformat(timespec="seconds"),
        "app_version": va.APP_VERSION, "audio_dir": str(args.audio_dir), "api_cache": args.api_cache,
        "text2sql_base_url": va.text2sql_base_url(), "questions": [q["id"] for q in questions], **meta,
    }
    (out_dir / "session.json").write_text(json.dumps(session_info, indent=2, ensure_ascii=False), encoding="utf-8")
    rec.log("session_open", **{k: v for k, v in session_info.items() if k != "questions"})
    print(f"[bench] {args.arm} -> {out_dir}")

    async def read_events() -> None:
        try:
            await arm.events(bench)
        except Exception as exc:
            if not bench.closing:       # a close frame after session_end is the normal goodbye
                rec.log("events_error", error=f"{type(exc).__name__}: {exc}"[:400])
                bench.dead = True

    events_task = asyncio.create_task(read_events())
    pump = AudioPump(bench, arm.rate_in)
    pump_task = asyncio.create_task(pump.run())
    await asyncio.sleep(args.warmup)
    try:
        for index, q in enumerate(questions):
            next_q = questions[index + 1] if index + 1 < len(questions) else None
            bench.q = q["id"]
            bench.state()
            pcm, speech_end = clips[q["id"]]
            rec.log("clip_start", q=q["id"], text=q["text"], speech_ms=round(speech_end, 1),
                    clip_ms=round(len(pcm) / 2 / arm.rate_in * 1000, 1))
            print(f"[bench]   {q['id']} {q['text']}")
            await pump.play(pcm, speech_end)
            if pump.stopped or bench.dead:
                rec.log("session_dead", q=q["id"])
                print("[bench]   session died, see events.jsonl")
                break
            if next_q and next_q.get("barge_in"):
                how = await bench.wait_barge_point(q["id"])
                rec.log("barge_point", q=q["id"], how=how)
                continue
            how = await bench.wait_turn_end(q["id"])
            rec.log("turn_end", q=q["id"], how=how)
            if bench.dead:
                rec.log("session_dead", q=q["id"])
                print("[bench]   session died, see events.jsonl")
                break
            await asyncio.sleep(1.0)
    finally:
        rec.log("session_end")
        bench.closing = True
        pump.stopped = True
        await asyncio.gather(pump_task, return_exceptions=True)
        try:
            await arm.close(bench)
        except Exception as exc:
            rec.log("close_error", error=str(exc)[:300])
        events_task.cancel()
        await asyncio.gather(events_task, return_exceptions=True)
        bench.wav.close()
        rec.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--arm", required=True, choices=sorted(ARMS))
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--model", help="override the arm's default model")
    parser.add_argument("--audio-dir", default=str(BENCH / "audio"))
    parser.add_argument("--only", help="comma-separated question ids, e.g. q01,q02")
    parser.add_argument("--api-cache", choices=("off", "on"), default="off")
    parser.add_argument("--warmup", type=float, default=2.0, help="seconds of silence before the first clip")
    parser.add_argument("--voice", help="OpenAI voice (realtime: the persona's; live: marin)")
    parser.add_argument("--backend-model", default=os.getenv("OPENAI_TEXT_MODEL", "gpt-6-sol"))
    parser.add_argument("--backend-effort", default="low", help="reasoning effort of the live backend, '' for none")
    parser.add_argument("--gemini-voice", help="Gemini prebuilt voice name; model default when omitted")
    parser.add_argument("--thinking-level", default="medium", choices=("low", "medium", "high"))
    parser.add_argument("--scheduling", default="auto", choices=("auto", "none", "WHEN_IDLE", "INTERRUPT", "SILENT"),
                        help="Gemini tool-result scheduling; auto = WHEN_IDLE on gemini, none on gemini-ext")
    args = parser.parse_args()

    questions = json.loads((BENCH / "questions.json").read_text(encoding="utf-8"))["questions"]
    if args.only:
        wanted = {x.strip() for x in args.only.split(",")}
        questions = [q for q in questions if q["id"] in wanted]
    missing = [q["id"] for q in questions if not (Path(args.audio_dir) / f"{q['id']}.wav").exists()]
    if missing:
        raise SystemExit(f"Missing clips in {args.audio_dir}: {', '.join(missing)} (see bench/README.md)")
    install_api_cache_switch(args.api_cache == "on")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    tag = re.sub(r"[^a-z0-9-]+", "-", Path(args.audio_dir).name.lower())
    for run in range(1, args.runs + 1):
        out_dir = BENCH / "results" / f"{stamp}_{args.arm}_{tag}_run{run}"
        asyncio.run(run_session(args, questions, out_dir))


if __name__ == "__main__":
    main()
