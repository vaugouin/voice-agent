# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.40"]
# ///
"""Render one still per beat of a cinema episode, from the player itself (VOICE-AGENT-235, step 5).

Opens `http://127.0.0.1:<port>/?cinema=<slug>` in the installed Chrome (Playwright, channel "chrome",
no browser download), seeks the player's audio to the start of each beat (the player re-applies the
cue on `seeked`, even paused) and screenshots the stage into `cinema/assets/<slug>/stills/<beat>.png`.
The stills are what the avatar pipeline (`tools/build-cinema-avatars.py`) uses as backgrounds, and
what a direct render would concatenate with `episode.mp3`.

Usage, with the app running (`python -m app --host 127.0.0.1 --port 3000`):
    uv run tools/render-cinema-stills.py yojimbo-fistful
    uv run tools/render-cinema-stills.py yojimbo-fistful --beats s001 s002 --width 1920 --height 1080
    uv run tools/render-cinema-stills.py yojimbo-fistful --no-line      # the picture alone, no spoken line
    uv run tools/render-cinema-stills.py yojimbo-fistful --mp4          # also cinema/assets/<slug>/episode.mp4:
                                                                        # the stills held for their beats over episode.mp3

Idempotent: a still already on disk is kept unless `--force`; `stills/stills.json` records the beat,
the time seeked to and the brick type.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HIDE_CONTROLS = "#cinemaPlayButton, #cinemaProgressBar, #cinemaClock { visibility: hidden !important; }"
HIDE_LINE = "#cinemaLine { visibility: hidden !important; }"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("slug")
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--beats", nargs="*", default=[], help="only these beat ids")
    parser.add_argument("--no-line", action="store_true", help="hide the spoken line under the picture")
    parser.add_argument("--offset-ms", type=int, default=120, help="how far into the beat to seek")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--mp4", action="store_true", help="write episode.mp4 from the stills and episode.mp3 (ffmpeg)")
    args = parser.parse_args()
    assets = ROOT / "cinema" / "assets" / args.slug
    timeline = json.loads((assets / "timeline.json").read_text(encoding="utf-8"))
    stills = assets / "stills"
    stills.mkdir(parents=True, exist_ok=True)
    index_path = stills / "stills.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    wanted = [b for b in timeline["beats"] if not args.beats or b["id"] in args.beats]
    url = f"http://127.0.0.1:{args.port}/?cinema={args.slug}"
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": args.width, "height": args.height}, device_scale_factor=1)
        page.goto(url, wait_until="networkidle")
        # app.js is a module: its state is not reachable from here, the audio element is (the player sets its
        # src once the timeline is loaded, and seeks re-apply the cue even paused)
        page.wait_for_function("() => { const a = document.getElementById('cinemaAudio'); return a && a.src && a.readyState >= 1; }",
                               timeout=60000)
        page.add_style_tag(content=HIDE_CONTROLS + (HIDE_LINE if args.no_line else ""))
        done = 0
        started = time.monotonic()
        for beat in wanted:
            out = stills / f"{beat['id']}.png"
            if out.exists() and not args.force and index.get(beat["id"], {}).get("start_ms") == beat["start_ms"]:
                continue
            at = (beat["start_ms"] + args.offset_ms) / 1000
            page.evaluate("""(t) => new Promise((resolve) => {
                const audio = document.getElementById('cinemaAudio');
                const done = () => { audio.removeEventListener('seeked', done); resolve(); };
                audio.addEventListener('seeked', done);
                audio.currentTime = t;
            })""", at)
            page.wait_for_timeout(350)  # the brick's images are preloaded; the transition is instant on seek
            page.locator("#cinemaStage").screenshot(path=str(out))
            index[beat["id"]] = {"start_ms": beat["start_ms"], "seek_ms": round(at * 1000), "brick": beat["brick"]["type"],
                                 "voice": beat["voice"], "line": not args.no_line}
            done += 1
            if done % 20 == 0:
                print(f"  {done} stills, {time.monotonic() - started:.0f}s", flush=True)
        browser.close()
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{args.slug}: {done} stills rendered, {len(index)} in {stills}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
