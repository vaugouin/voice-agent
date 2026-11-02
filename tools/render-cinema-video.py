# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.40"]
# ///
"""Render a cinema episode to video with its motion: crossfades, card lines revealed one by one, the slow
settle of a still, a poster panned from top to bottom, then silent scrolling end credits (2026-11-02).

`render-cinema-stills.py` takes one picture per beat; this tool steps every CSS animation of the player
(Web Animations API, `currentTime` set by hand) and screenshots at 25 frames per second while something
moves, then holds the last picture until the next event (a new line under the picture, the next brick). So
the video carries the player's real animations, deterministically, whatever the speed of the machine.

The page runs in render mode (`?cinema=<slug>&render=1`): the player exposes `window.__cinemaRender.show(i)`
and leaves the removal of a leaving brick to this tool.

Credits: `meta.credits` ([{heading, lines}]) is laid out as one tall page and scrolled bottom to top at
`--credits-speed` pixels per second, without voice, after the episode audio.

Usage, with the app running (`python -m app --host 127.0.0.1 --port 3000`):
    uv run tools/render-cinema-video.py strangelove
    uv run tools/render-cinema-video.py strangelove --from 120000 --to 180000 --out test.mp4   # a slice, for checks

Output: cinema/assets/<slug>/episode-video.mp4 (1920x1080, H.264, AAC, -14 LUFS, MP4 chapters from
meta.chapters, chapters-youtube.txt). Frames are written as JPEG to cinema/assets/<slug>/anim/ and deleted
at the end unless --keep."""
from __future__ import annotations

import argparse
import html
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FPS = 25
STEP = 1000 / FPS
HIDE = "#cinemaPlayButton, #cinemaProgressBar, #cinemaClock { visibility: hidden !important; }"
MAX_WINDOW_MS = 20000  # an animation longer than this is sampled only up to here (safety)

JS_ANIMS = """() => document.getAnimations().map((a, i) => {
  a.pause();
  const t = a.effect.getComputedTiming();
  return [i, Number(t.delay) || 0, Number.isFinite(t.endTime) ? t.endTime : 0];
})"""
JS_SET = """(ms) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } }"""
JS_READY = """() => Promise.all(Array.from(document.querySelectorAll('#cinemaBrick img')).map((img) =>
  img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; })))"""
JS_DROP_LEAVING = """() => document.querySelectorAll('#cinemaBrick .isLeaving').forEach((n) => n.remove())"""

CREDITS_CSS = """
html, body { margin: 0; background: #000; overflow: hidden; }
#roll { position: absolute; left: 0; right: 0; top: 0; text-align: center; color: #e8e6ef;
  font-family: "Segoe UI", system-ui, sans-serif; will-change: transform; }
.pad { height: 1080px; }
h1 { font-size: 64px; margin: 0 0 12px; letter-spacing: 0.01em; }
.sub { font-size: 28px; color: #b9a7ff; margin-bottom: 110px; }
h2 { font-size: 26px; letter-spacing: 0.28em; text-transform: uppercase; color: #8fd3c7; margin: 90px 0 26px; font-weight: 700; }
p { font-size: 30px; line-height: 1.45; margin: 6px auto; max-width: 1300px; }
.small { font-size: 22px; color: #9a97a8; margin-top: 120px; }
"""


def sample_times(windows: list[tuple[float, float]], beat_offsets: list[float], span: float) -> list[float]:
    """Times (ms from the brick's start) worth a frame: every 40 ms inside an animation window, plus each
    line change; the frame is then held until the next sample."""
    ts = {0.0}
    for start, end in windows:
        end = min(end, span, start + MAX_WINDOW_MS)
        t = max(0.0, start)
        while t < end:
            ts.add(round(t / STEP) * STEP)
            t += STEP
        ts.add(round(min(end, span - 1) / STEP) * STEP)
    ts.update(o for o in beat_offsets if 0 <= o < span)
    return sorted(t for t in ts if 0 <= t < span)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slug")
    ap.add_argument("--port", type=int, default=3000)
    ap.add_argument("--from", dest="t0", type=int, default=0, help="start, ms of episode time")
    ap.add_argument("--to", dest="t1", type=int, default=None, help="end, ms of episode time")
    ap.add_argument("--out", default="episode-video.mp4")
    ap.add_argument("--credits-speed", type=float, default=140.0, help="credits scroll, px per second at 1080p")
    ap.add_argument("--no-credits", action="store_true")
    ap.add_argument("--keep", action="store_true", help="keep the JPEG frames")
    args = ap.parse_args()
    assets = ROOT / "cinema" / "assets" / args.slug
    timeline = json.loads((assets / "timeline.json").read_text(encoding="utf-8"))
    beats = timeline["beats"]
    total = timeline["duration_ms"]
    t1 = args.t1 or total
    anim = assets / "anim"
    shutil.rmtree(anim, ignore_errors=True)
    anim.mkdir(parents=True)
    entries: list[tuple[Path, float]] = []  # (frame, absolute ms)
    started = time.monotonic()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page.goto(f"http://127.0.0.1:{args.port}/?cinema={args.slug}&render=1", wait_until="networkidle")
        page.wait_for_function("() => window.__cinemaRender", timeout=60000)
        page.add_style_tag(content=HIDE)
        stage = page.locator("#cinemaStage")
        # brick groups: a beat that sets a picture, and the hold beats after it
        starts = [i for i, b in enumerate(beats) if i == 0 or (b.get("brick") or {}).get("type") != "hold"]
        n = 0
        for g, i in enumerate(starts):
            j = starts[g + 1] if g + 1 < len(starts) else len(beats)
            s_abs = beats[i]["start_ms"]
            e_abs = beats[j]["start_ms"] if j < len(beats) else total
            if e_abs <= args.t0 or s_abs >= t1:
                continue
            page.evaluate("(i) => window.__cinemaRender.show(i)", i)
            page.evaluate(JS_READY)
            windows = [(d, e) for _, d, e in page.evaluate(JS_ANIMS) if e > 0]
            offsets = [beats[k]["start_ms"] - s_abs for k in range(i, j)]
            current = i
            dropped = False
            for r in sample_times(windows, offsets, e_abs - s_abs):
                k = max(b for b in range(i, j) if beats[b]["start_ms"] - s_abs <= r)
                if k != current:
                    page.evaluate("(i) => window.__cinemaRender.show(i)", k)
                    current = k
                if not dropped and r >= 560:
                    page.evaluate(JS_DROP_LEAVING)
                    dropped = True
                page.evaluate(JS_SET, r)
                f = anim / f"{n:06d}.jpg"
                stage.screenshot(path=str(f), type="jpeg", quality=90)
                entries.append((f, s_abs + r))
                n += 1
            if not dropped:
                page.evaluate(JS_DROP_LEAVING)
            if g % 20 == 0:
                print(f"  brick {g}/{len(starts)}, {n} frames, {time.monotonic() - started:.0f}s", flush=True)
        credits = None
        if not args.no_credits and timeline["meta"].get("credits") and t1 >= total:
            credits = render_credits(page, assets, timeline["meta"], args.credits_speed)
        browser.close()
    print(f"{n} frames in {time.monotonic() - started:.0f}s", flush=True)
    encode(assets, timeline, entries, max(args.t0, 0), min(t1, total), args.out, credits)
    if not args.keep:
        shutil.rmtree(anim, ignore_errors=True)
    return 0


def render_credits(page, assets: Path, meta: dict, speed: float) -> dict:
    """The end credits as one tall page, scrolled bottom to top, one screenshot per frame."""
    parts = [f"<div class='pad'></div><h1>{html.escape(meta.get('title', ''))}</h1>"]
    if meta.get("credits_subtitle"):
        parts.append(f"<div class='sub'>{html.escape(meta['credits_subtitle'])}</div>")
    for sec in meta["credits"]:
        parts.append(f"<h2>{html.escape(sec['heading'])}</h2>")
        parts += [f"<p>{html.escape(line)}</p>" for line in sec["lines"]]
    if meta.get("credits_footer"):
        parts.append(f"<p class='small'>{html.escape(meta['credits_footer'])}</p>")
    parts.append("<div class='pad'></div>")
    page.set_content(f"<html><head><style>{CREDITS_CSS}</style></head><body><div id='roll'>{''.join(parts)}</div></body></html>")
    height = page.evaluate("() => document.getElementById('roll').scrollHeight")
    distance = height - 1080
    frames = int(distance / speed * FPS)
    out = assets / "anim-credits"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    for k in range(frames + 1):
        y = distance * k / frames
        page.evaluate("(y) => { document.getElementById('roll').style.transform = `translateY(${-y}px)`; }", y)
        page.screenshot(path=str(out / f"{k:06d}.jpg"), type="jpeg", quality=90)
    print(f"credits: {frames} frames, {frames / FPS:.1f}s", flush=True)
    return {"dir": out, "frames": frames}


def encode(assets: Path, timeline: dict, entries: list, t0: int, t1: int, out_name: str, credits: dict | None) -> None:
    lines = []
    for k, (f, at) in enumerate(entries):
        nxt = entries[k + 1][1] if k + 1 < len(entries) else t1
        lines.append(f"file '{f.as_posix()}'\nduration {max(0.04, (nxt - at) / 1000):.3f}")
    lines.append(f"file '{entries[-1][0].as_posix()}'")
    concat = assets / "anim" / "concat.txt"
    concat.write_text("\n".join(lines) + "\n", encoding="utf-8")
    body = assets / "anim" / "body.mp4"
    # loudness: -14 LUFS integrated, -1.5 dBTP (two passes)
    probe = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(assets / "episode.mp3"), "-af",
                            "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = json.loads(probe.stderr[probe.stderr.rfind("{"):probe.stderr.rfind("}") + 1])
    loud = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
            f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
                    "-ss", f"{t0 / 1000:.3f}", "-t", f"{(t1 - t0) / 1000:.3f}", "-i", str(assets / "episode.mp3"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-r", str(FPS),
                    "-pix_fmt", "yuv420p", "-af", loud, "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", str(body)], check=True)
    parts = [body]
    if credits:
        roll = assets / "anim" / "credits.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", str(credits["dir"] / "%06d.jpg"),
                        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a",
                        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-r", str(FPS), "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "192k", "-shortest", str(roll)], check=True)
        parts.append(roll)
        shutil.rmtree(credits["dir"], ignore_errors=True)
    lst = assets / "anim" / "parts.txt"
    lst.write_text("".join(f"file '{x.as_posix()}'\n" for x in parts), encoding="utf-8")
    starts = {b["id"]: b["start_ms"] for b in timeline["beats"]}
    chapters = sorted((starts[c["beat"]] - t0, c["title"]) for c in timeline["meta"].get("chapters", [])
                      if c.get("beat") in starts and t0 <= starts[c["beat"]] < t1)
    meta_args = []
    end_all = t1 - t0
    if chapters:
        chapters[0] = (0, chapters[0][1])
        ff, yt = [";FFMETADATA1"], []
        for k, (st, title) in enumerate(chapters):
            en = chapters[k + 1][0] if k + 1 < len(chapters) else end_all
            ff += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={st}", f"END={en}", f"title={title}"]
            s = st // 1000
            yt.append(f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d} {title}" if s >= 3600 else f"{s // 60}:{s % 60:02d} {title}")
        if credits:
            s = end_all // 1000
            yt.append(f"{s // 60}:{s % 60:02d} Credits")
        (assets / "anim" / "chapters.txt").write_text("\n".join(ff) + "\n", encoding="utf-8")
        (assets / "chapters-youtube.txt").write_text("\n".join(yt) + "\n", encoding="utf-8")
        meta_args = ["-f", "ffmetadata", "-i", str(assets / "anim" / "chapters.txt"), "-map_chapters", "1"]
    out = assets / out_name
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), *meta_args,
                    "-map", "0", "-c", "copy", "-movflags", "+faststart", str(out)], check=True)
    print(f"{out.name}: {out.stat().st_size / 1e6:.0f} MB, {len(chapters)} chapters, loudness {m['input_i']} LUFS to -14", flush=True)


if __name__ == "__main__":
    sys.exit(main())
