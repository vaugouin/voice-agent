# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv"]
# ///
"""Record each persona's spoken intro (VOICE-AGENT-215).

The Settings picker plays a short line in the persona's own voice when it is chosen. The line
is the `intro:` key of the persona's front matter (`SOUL.md` for `default`, `souls/<slug>.md`
for the others), spoken with its `voice:` through OpenAI text-to-speech, and written to
`app/static/souls/<slug>.mp3` next to the portrait. Recorded once and committed, like the
avatars: the app never pays for speech synthesis at click time, and the intro sounds the same
on every device.

Re-run after changing an `intro:` or a `voice:` line:

    uv run tools/generate-soul-intros.py            # only the missing files
    uv run tools/generate-soul-intros.py --force    # re-record all of them
    uv run tools/generate-soul-intros.py scholar    # one persona

Reads OPENAI_API_KEY from the environment or the repo's `.env`.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "app" / "static" / "souls"
MODEL = "gpt-4o-mini-tts"


def front_matter(path: Path) -> dict[str, str]:
    """Flat `key: value` front matter, read the way `app/main.py` reads it: comments first."""
    text = re.sub(r"<!--.*?-->", " ", path.read_text(encoding="utf-8"), flags=re.DOTALL).lstrip()
    meta: dict[str, str] = {}
    if text.startswith("---"):
        for line in text.splitlines()[1:]:
            if line.strip() == "---":
                break
            key, delim, value = line.partition(":")
            if delim and key.strip():
                meta[key.strip().lower()] = value.strip()
    return meta


def personas() -> dict[str, Path]:
    found = {"default": ROOT / "SOUL.md"}
    for path in sorted((ROOT / "souls").glob("*.md")):
        if re.match(r"^[a-z0-9][a-z0-9-]*$", path.stem):
            found.setdefault(path.stem, path)
    return found


def main() -> int:
    load_dotenv(ROOT / ".env")
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        return 1
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    force = "--force" in sys.argv[1:]
    failures = 0
    for slug, path in personas().items():
        if args and slug not in args:
            continue
        meta = front_matter(path)
        intro, voice = meta.get("intro", ""), meta.get("voice", "")
        target = OUT_DIR / f"{slug}.mp3"
        if not intro or not voice:
            print(f"{slug}: no intro or no voice in {path.name}, skipped")
            continue
        if target.exists() and not force:
            print(f"{slug}: {target.name} exists, skipped (--force to re-record)")
            continue
        response = httpx.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": MODEL,
                "voice": voice,
                "input": intro,
                "instructions": (
                    f"You are {meta.get('name') or slug}, introducing yourself in one breath. "
                    "Natural, warm, in character, no announcer tone."
                ),
                "response_format": "mp3",
            },
            timeout=60,
        )
        if response.status_code != 200:
            print(f"{slug}: HTTP {response.status_code} {response.text[:200]}", file=sys.stderr)
            failures += 1
            continue
        target.write_bytes(response.content)
        print(f"{slug}: {target.relative_to(ROOT)} ({len(response.content) // 1024} KB, voice {voice})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
