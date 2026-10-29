"""Synthetic clips for a DRY RUN of the bench (VOICE-AGENT-242), never for the real comparison.

Writes audio-tts/<id>.wav from questions.json with OpenAI text-to-speech, so the harness can be
tested end to end before Philippe records the real clips. A synthetic voice is far easier to
transcribe than a real one in a real room, which is precisely one of the things the bench
measures: report.py keeps the two audio sets apart (`--audio audio-tts`).

  uv run --no-project --with httpx --with python-dotenv python bench/make_tts_audio.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

BENCH = Path(__file__).resolve().parent
MODEL = "gpt-4o-mini-tts"   # the model tools/generate-soul-intros.py already uses
VOICE = "ash"
OUT = BENCH / "audio-tts"


def main() -> None:
    load_dotenv(BENCH.parent / ".env")
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY is not set in voice-agent/.env")
    OUT.mkdir(exist_ok=True)
    questions = json.loads((BENCH / "questions.json").read_text(encoding="utf-8"))["questions"]
    with httpx.Client(timeout=60) as client:
        for q in questions:
            target = OUT / f"{q['id']}.wav"
            if target.exists():
                continue
            response = client.post(
                "https://api.openai.com/v1/audio/speech",
                headers={"Authorization": f"Bearer {key}"},
                json={"model": MODEL, "voice": VOICE, "input": q["text"], "response_format": "wav",
                      "instructions": "Speak naturally, as someone asking a voice assistant a question."},
            )
            response.raise_for_status()
            target.write_bytes(response.content)
            print(f"[tts] {target.name}  {q['text']}")


if __name__ == "__main__":
    main()
