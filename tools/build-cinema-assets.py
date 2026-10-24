# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv"]
# ///
"""Build the assets of a cinema-mode scenario (VOICE-AGENT-235): frames, images, voices, timeline.

Reads `cinema/scenarios/<slug>.json` and writes `cinema/assets/<slug>/` (git-ignored):

    frames/<movie_id>-<HHhMMmSSs>.jpg   one frame per quoted_frame / split_frames brick, taken by
                                         ffmpeg from the copy the scenario names (NAS), black bars
                                         cropped (cropdetect, `--no-crop` keeps them), 1920 px wide
    images/<kind>-<id>.jpg               posters (TMDb) and covers (Wikipedia) of the title cards
    audio/<beat>.wav                     one line per beat, OpenAI text-to-speech, the scenario's voices
    audio/gap-<ms>.wav                   the silences between lines
    episode.wav, episode.mp3             the lines and silences concatenated
    timeline.json                        the scenario with start_ms / duration_ms per beat and the
                                         asset path of every brick: what the player will read
    transcript.txt                       [MM:SS] voice: line, from the real durations

Usage, from the repo root:
    uv run tools/build-cinema-assets.py cinema/scenarios/yojimbo-fistful.json
    uv run tools/build-cinema-assets.py cinema/scenarios/yojimbo-fistful.json --only frames
    uv run tools/build-cinema-assets.py cinema/scenarios/yojimbo-fistful.json --force

Idempotent: an asset already on disk is kept unless `--force`. Speech is only requested for the
lines whose audio file is missing, so a text change needs `--force` (or deleting that beat's wav).
Reads OPENAI_API_KEY from the environment or the repo's `.env`. Needs ffmpeg and ffprobe on PATH.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
TTS_URL = "https://api.openai.com/v1/audio/speech"
TTS_MODEL = "gpt-4o-mini-tts"
GAP_MS = 350
USER_AGENT = "voice-agent-cinema-build/1.0 (https://github.com/vaugouin/voice-agent)"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def probe_duration_ms(path: Path) -> int:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).stdout
    return round(float(out.strip()) * 1000)


def probe_audio_format(path: Path) -> tuple[int, int]:
    out = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels",
               "-of", "csv=p=0", str(path)]).stdout.strip()
    rate, channels = out.split(",")[:2]
    return int(rate), int(channels)


def probe_video_size(path: Path) -> tuple[int, int]:
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
               "-of", "csv=p=0", str(path)]).stdout.strip()
    width, height = out.split(",")[:2]
    return int(width), int(height)


def strip_mean_luma(source: Path, timecode: str, row: int) -> float:
    """Mean 8-bit luma of one pixel row of the frame at the timecode (255 = white)."""
    result = subprocess.run(["ffmpeg", "-v", "error", "-ss", timecode, "-i", str(source), "-frames:v", "1",
                             "-vf", f"crop=iw:1:0:{row},format=gray", "-f", "rawvideo", "-"],
                            capture_output=True, timeout=300)
    data = result.stdout
    return sum(data) / len(data) if data else 255.0


def detect_crop(source: Path, timecode: str) -> str | None:
    """Letterbox bars baked into the copy (a 2.35:1 film inside a 16:9 file).

    cropdetect reads a few frames at the timecode. Only horizontal bars are trusted (full width is
    kept: a dark scene could pass for a pillarbox), the 10-bit copies need a limit near 96 to see
    their bars at all, and because that limit could also eat a dark picture, the rows just outside
    the detected area must be black (mean luma under 8/255) or nothing is cropped."""
    result = subprocess.run(["ffmpeg", "-v", "info", "-ss", timecode, "-i", str(source), "-frames:v", "6",
                             "-vf", "cropdetect=96:2:0", "-f", "null", "-"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    crops = re.findall(r"crop=(\d+:\d+:\d+:\d+)", result.stderr)
    if not crops:
        return None
    _width, height, _x, y = (int(v) for v in crops[-1].split(":"))
    source_width, source_height = probe_video_size(source)
    if height >= source_height * 0.97 or height <= 0:
        return None
    above = strip_mean_luma(source, timecode, max(0, y - 2)) if y >= 2 else 0.0
    bottom_row = y + height + 1
    below = strip_mean_luma(source, timecode, bottom_row) if bottom_row < source_height - 1 else 0.0
    if above > 8 or below > 8:
        return None
    return f"{source_width}:{height}:0:{y}"


def timecode_slug(tc: str) -> str:
    h, m, s = tc.split(":")
    return f"{int(h):02d}h{int(m):02d}m{s.replace('.', '_')}s"


def fmt_ms(ms: int) -> str:
    total = ms // 1000
    return f"{total // 60:02d}:{total % 60:02d}"


# ----------------------------------------------------------------------------- frames and images

def frame_requests(scenario: dict) -> list[dict]:
    wanted: dict[tuple, dict] = {}
    for beat in scenario["beats"]:
        brick = beat["brick"]
        specs = []
        if brick["type"] == "quoted_frame":
            specs.append(brick)
        elif brick["type"] == "split_frames":
            specs += [brick["left"], brick["right"]]
        for spec in specs:
            key = (spec["movie_id"], spec["copy"], spec["timecode"])
            wanted.setdefault(key, {"movie_id": spec["movie_id"], "copy": spec["copy"], "timecode": spec["timecode"]})
    return list(wanted.values())


def frame_path(assets: Path, spec: dict) -> Path:
    return assets / "frames" / f"{spec['movie_id']}-{timecode_slug(spec['timecode'])}.jpg"


def build_frames(scenario: dict, assets: Path, force: bool, no_crop: bool = False) -> None:
    copies = scenario["meta"]["copies"]
    (assets / "frames").mkdir(parents=True, exist_ok=True)
    for spec in frame_requests(scenario):
        out = frame_path(assets, spec)
        if out.exists() and not force:
            print(f"  frame kept   {out.name}")
            continue
        source = Path(copies[spec["copy"]]["file"])
        if not source.exists():
            sys.exit(f"copy not found: {source}")
        started = time.monotonic()
        crop = None if no_crop else detect_crop(source, spec["timecode"])
        filters = (f"crop={crop}," if crop else "") + "scale=1920:-2"
        run(["ffmpeg", "-v", "error", "-y", "-ss", spec["timecode"], "-i", str(source), "-frames:v", "1",
             "-vf", filters, "-q:v", "3", str(out)])
        print(f"  frame        {out.name}  ({time.monotonic() - started:.1f}s from {source.name}"
              f"{', crop ' + crop if crop else ''})")


def image_requests(scenario: dict) -> list[dict]:
    meta = scenario["meta"]
    base = meta.get("images", {}).get("tmdb_base", "https://image.tmdb.org/t/p/w780")
    wanted: dict[str, dict] = {}
    works = {w["movie_id"]: w for w in meta["works"]}
    sources = {w["source_work_id"]: w for w in meta["source_works"]}
    for beat in scenario["beats"]:
        brick = beat["brick"]
        if brick["type"] != "title_card":
            continue
        ids = brick.get("movie_id", [])
        for movie_id in ([ids] if isinstance(ids, int) else ids):
            path = works[movie_id].get("poster_path")
            if path:
                wanted.setdefault(f"poster-{movie_id}", {"name": f"poster-{movie_id}.jpg", "url": base + path})
        sw = brick.get("source_work_id")
        if sw and sources[sw].get("cover_url"):
            wanted.setdefault(f"cover-{sw}", {"name": f"cover-{sw}.jpg", "url": sources[sw]["cover_url"]})
    return list(wanted.values())


def build_images(scenario: dict, assets: Path, force: bool) -> None:
    (assets / "images").mkdir(parents=True, exist_ok=True)
    with httpx.Client(headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=60) as client:
        for spec in image_requests(scenario):
            out = assets / "images" / spec["name"]
            if out.exists() and not force:
                print(f"  image kept   {out.name}")
                continue
            response = client.get(spec["url"])
            response.raise_for_status()
            out.write_bytes(response.content)
            print(f"  image        {out.name}  ({len(response.content) // 1024} KB from {spec['url'].split('/')[2]})")


# ----------------------------------------------------------------------------- voices and timeline

def voice_config(meta: dict, name: str) -> tuple[str, str]:
    entry = meta["voices"][name]
    if isinstance(entry, str):
        return entry, ""
    return entry["voice"], entry.get("instructions", "")


def synthesize(client: httpx.Client, text: str, voice: str, instructions: str, out: Path) -> None:
    payload = {"model": TTS_MODEL, "voice": voice, "input": text, "response_format": "wav"}
    if instructions:
        payload["instructions"] = instructions
    for attempt in range(3):
        response = client.post(TTS_URL, json=payload)
        if response.status_code == 200:
            out.write_bytes(response.content)
            return
        wait = 2 ** attempt
        print(f"  tts retry in {wait}s: HTTP {response.status_code} {response.text[:120]}")
        time.sleep(wait)
    sys.exit(f"text-to-speech failed for {out.name}")


def build_audio(scenario: dict, assets: Path, force: bool) -> None:
    load_dotenv(ROOT / ".env")
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        sys.exit("OPENAI_API_KEY is not set (environment or .env)")
    meta = scenario["meta"]
    audio_dir = assets / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    with httpx.Client(headers={"Authorization": f"Bearer {api_key}"}, timeout=120) as client:
        for beat in scenario["beats"]:
            out = audio_dir / f"{beat['id']}.wav"
            if out.exists() and not force:
                continue
            voice, instructions = voice_config(meta, beat["voice"])
            started = time.monotonic()
            synthesize(client, beat["text"], voice, instructions, out)
            print(f"  voice        {out.name}  {beat['voice']}/{voice}  ({time.monotonic() - started:.1f}s, {len(beat['text'].split())} words)")


def silence(audio_dir: Path, ms: int, rate: int, channels: int) -> Path:
    out = audio_dir / f"gap-{ms}.wav"
    if not out.exists():
        layout = "mono" if channels == 1 else "stereo"
        run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"anullsrc=r={rate}:cl={layout}",
             "-t", f"{ms / 1000:.3f}", "-c:a", "pcm_s16le", str(out)])
    return out


def build_timeline(scenario: dict, assets: Path) -> dict:
    audio_dir = assets / "audio"
    first = audio_dir / f"{scenario['beats'][0]['id']}.wav"
    rate, channels = probe_audio_format(first)
    concat_lines: list[str] = []
    cursor = 0
    timeline = {"version": scenario["version"], "meta": scenario["meta"], "assets_dir": str(assets), "beats": []}
    transcript: list[str] = []
    for beat in scenario["beats"]:
        wav = audio_dir / f"{beat['id']}.wav"
        duration = probe_duration_ms(wav)
        entry = dict(beat)
        entry["start_ms"] = cursor
        entry["duration_ms"] = duration
        entry["audio"] = str(wav.relative_to(assets)).replace("\\", "/")
        entry["brick"] = resolve_brick(beat["brick"], scenario, assets)
        timeline["beats"].append(entry)
        transcript.append(f"[{fmt_ms(cursor)}] {beat['voice'].capitalize():<8} {beat['text']}")
        concat_lines.append(f"file '{wav.as_posix()}'")
        cursor += duration
        pause = GAP_MS + int(beat.get("pause_after_ms", 0))
        gap = silence(audio_dir, pause, rate, channels)
        concat_lines.append(f"file '{gap.as_posix()}'")
        cursor += pause
    timeline["duration_ms"] = cursor
    transcript.append(f"[{fmt_ms(cursor)}] END")
    concat_file = audio_dir / "concat.txt"
    concat_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
    episode_wav = assets / "episode.wav"
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(episode_wav)])
    run(["ffmpeg", "-v", "error", "-y", "-i", str(episode_wav), "-c:a", "libmp3lame", "-q:a", "2", str(assets / "episode.mp3")])
    (assets / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (assets / "transcript.txt").write_text("\n".join(transcript) + "\n", encoding="utf-8")
    return timeline


def resolve_brick(brick: dict, scenario: dict, assets: Path) -> dict:
    out = dict(brick)
    if brick["type"] == "quoted_frame":
        out["image"] = frame_path(assets, brick).relative_to(assets).as_posix()
    elif brick["type"] == "split_frames":
        out["left"] = dict(brick["left"], image=frame_path(assets, brick["left"]).relative_to(assets).as_posix())
        out["right"] = dict(brick["right"], image=frame_path(assets, brick["right"]).relative_to(assets).as_posix())
    elif brick["type"] == "title_card":
        ids = brick.get("movie_id", [])
        ids = [ids] if isinstance(ids, int) else ids
        out["images"] = [f"images/poster-{i}.jpg" for i in ids if (assets / "images" / f"poster-{i}.jpg").exists()]
        sw = brick.get("source_work_id")
        if sw and (assets / "images" / f"cover-{sw}.jpg").exists():
            out["images"].append(f"images/cover-{sw}.jpg")
    return out


# ----------------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scenario", type=Path)
    parser.add_argument("--only", choices=["frames", "images", "audio", "timeline"], action="append", default=[])
    parser.add_argument("--force", action="store_true", help="rebuild assets already on disk")
    parser.add_argument("--no-crop", action="store_true", help="keep the black bars of letterboxed copies")
    args = parser.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH")
    scenario = json.loads(args.scenario.read_text(encoding="utf-8"))
    slug = scenario["meta"]["id"]
    assets = ROOT / "cinema" / "assets" / slug
    assets.mkdir(parents=True, exist_ok=True)
    steps = args.only or ["frames", "images", "audio", "timeline"]
    print(f"{slug}: {len(scenario['beats'])} beats, assets in {assets}")
    if "frames" in steps:
        build_frames(scenario, assets, args.force, args.no_crop)
    if "images" in steps:
        build_images(scenario, assets, args.force)
    if "audio" in steps:
        build_audio(scenario, assets, args.force)
    if "timeline" in steps:
        timeline = build_timeline(scenario, assets)
        print(f"timeline: {len(timeline['beats'])} beats, {fmt_ms(timeline['duration_ms'])} total, episode.mp3 and transcript.txt written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
