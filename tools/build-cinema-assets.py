# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv", "faster-whisper"]
# ///
"""Build the assets of a cinema-mode scenario (VOICE-AGENT-235): frames, images, voices, timeline.

Reads `cinema/scenarios/<slug>.json` and writes `cinema/assets/<slug>/` (git-ignored):

    frames/<movie_id>-<HHhMMmSSs>.jpg   one frame per frame / quoted_frame / split_frames brick, taken by
                                         ffmpeg from the copy the scenario names (NAS): the sharpest frame
                                         (blurdetect) in a short window around the cited timecode, black
                                         bars cropped (cropdetect, `--no-crop` keeps them), up to 2560 px wide
    frames/frames.json                   per frame: the cited timecode, the one actually taken, the crop
    images/poster-<id>.jpg               posters of the title cards (TMDb)
    images/cover-<id>.jpg                covers of the source works (Wikipedia)
    images/person-<id>.jpg               portraits of the `portraits` bricks (TMDb profiles)
    images/wall-<kind>-<id>.jpg          posters of the `poster_wall` bricks (TMDb, films and series)
    audio/<beat>.wav, <beat>.json        one line per beat, OpenAI text-to-speech, pitched down by ffmpeg when
                                         the voice asks for it (`pitch_semitones`), with the signature of what
                                         was synthesized (voice, instructions, delivery, text, pitch)
    audio/x-<beat>.wav, x-<beat>.json    with `meta.tts.provider = "gemini"` (or `--tts gemini`): one Gemini
                                         multi-speaker request per exchange (a run of consecutive lines under
                                         1800 characters, both voices in one take, laughs and backchannels from
                                         `beat.speech`), named after its first line; faster-whisper then hears
                                         where each line starts and the exchange is cut into the per-line wavs
    audio/exchanges.json                 per line: its exchange and its bounds in it (the timeline glues the
                                         lines of one exchange without inserting a gap)
    audio/gap-<ms>.wav                   the silences between lines
    episode.wav, episode.mp3             the lines and silences concatenated; the mp3 at a constant bitrate,
                                         so that a seek in the browser lands where the timeline says
    timeline.json                        the scenario with start_ms / duration_ms per beat and the
                                         asset path of every brick: what the player will read
    transcript.txt                       [MM:SS] voice: line, from the real durations

Usage, from the repo root:
    uv run tools/build-cinema-assets.py cinema/scenarios/yojimbo-fistful.json
    uv run tools/build-cinema-assets.py cinema/scenarios/yojimbo-fistful.json --only frames
    uv run tools/build-cinema-assets.py cinema/scenarios/yojimbo-fistful.json --force

Idempotent: a frame or an image already on disk is kept unless `--force`. A line is synthesized again
only when its text, voice, instructions or delivery changed since the last build (the signature next to
the wav), or with `--force`; a Gemini exchange is synthesized again when any of its lines changed. Reads
OPENAI_API_KEY (and GEMINI_API_KEY for the Gemini provider) from the environment or the repo's `.env`.
Needs ffmpeg and ffprobe on PATH. Gemini 3.8 Flash TTS output is billed per second of audio (about
1.4 cents a minute in 2026, see ai.google.dev/gemini-api/docs/pricing).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import struct
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
TTS_URL = "https://api.openai.com/v1/audio/speech"
TTS_MODEL = "gpt-4o-mini-tts"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
GEMINI_MODEL = "gemini-3.8-flash-tts"
EXCHANGE_MAX_CHARS = 1800   # one Gemini request carries one exchange: a run of consecutive lines under this size
WHISPER_MODEL = "small"     # faster-whisper model that recovers the line boundaries inside an exchange
GAP_MS = 350
MP3_BITRATE = "128k"
FRAME_MAX_WIDTH = 2560
SHARPEN_WINDOW = (-0.5, 2.5)  # seconds around the cited timecode in which the sharpest frame is looked for
SHARPEN_FPS = 4
TMDB_IMAGE = "https://image.tmdb.org/t/p/"
TMDB_PROFILE_SIZE = "h632"
TMDB_WALL_SIZE = "w500"
USER_AGENT = "voice-agent-cinema-build/1.1 (https://github.com/vaugouin/voice-agent)"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def wav_info(path: Path) -> tuple[int, int, int] | None:
    """(sample rate, channels, duration in ms) of a PCM wav, read from its header and its size.

    Exact and instant where eighty-five ffprobe launches took ten minutes on this machine. The
    data length is taken from the file size, not from the `data` chunk: the wavs streamed by the
    speech API carry a placeholder length there. None when the file is not a plain PCM wav."""
    with path.open("rb") as handle:
        head = handle.read(4096)
    if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        return None
    pos, rate, channels, bits, data_offset = 12, 0, 0, 0, None
    while pos + 8 <= len(head):
        chunk_id, size = head[pos:pos + 4], struct.unpack_from("<I", head, pos + 4)[0]
        if chunk_id == b"fmt ":
            audio_format, channels, rate = struct.unpack_from("<HHI", head, pos + 8)
            bits = struct.unpack_from("<H", head, pos + 22)[0]
            if audio_format not in (1, 0xFFFE):
                return None
        elif chunk_id == b"data":
            data_offset = pos + 8
            break
        pos += 8 + size + (size & 1)
    if data_offset is None or not (rate and channels and bits):
        return None
    frames = (path.stat().st_size - data_offset) // (channels * bits // 8)
    return rate, channels, round(frames * 1000 / rate)


def probe_duration_ms(path: Path) -> int:
    info = wav_info(path) if path.suffix.lower() == ".wav" else None
    if info:
        return info[2]
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).stdout
    return round(float(out.strip()) * 1000)


def probe_audio_format(path: Path) -> tuple[int, int]:
    info = wav_info(path) if path.suffix.lower() == ".wav" else None
    if info:
        return info[0], info[1]
    out = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels",
               "-of", "csv=p=0", str(path)]).stdout.strip()
    rate, channels = out.split(",")[:2]
    return int(rate), int(channels)


def probe_video_size(path: Path) -> tuple[int, int]:
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
               "-of", "csv=p=0", str(path)]).stdout.strip()
    width, height = out.split(",")[:2]
    return int(width), int(height)


def parse_timecode(tc: str) -> float:
    h, m, s = tc.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def format_timecode(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int(seconds % 3600 // 60)
    s = seconds - h * 3600 - m * 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def timecode_slug(tc: str) -> str:
    h, m, s = tc.split(":")
    return f"{int(h):02d}h{int(m):02d}m{s.replace('.', '_')}s"


def fmt_ms(ms: int) -> str:
    total = ms // 1000
    return f"{total // 60:02d}:{total % 60:02d}"


# ----------------------------------------------------------------------------- frames

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


def sharpest_time(source: Path, timecode: str, window: tuple[float, float]) -> tuple[float, float]:
    """Time of the sharpest frame around the cited timecode, and its blur score (lower is sharper).

    A subtitle's timecode is the start of a line, which often falls on a camera move, a cut or a
    face in motion; the frame worth showing is usually a few tenths of a second away. ffmpeg's
    blurdetect scores SHARPEN_FPS frames per second over the window and the lowest score wins.
    Falls back to the cited time when nothing could be measured."""
    cited = parse_timecode(timecode)
    start = max(0.0, cited + window[0])
    length = max(0.25, cited + window[1] - start)
    result = subprocess.run(["ffmpeg", "-v", "info", "-nostats", "-ss", format_timecode(start), "-t", f"{length:.3f}",
                             "-i", str(source), "-vf",
                             f"fps={SHARPEN_FPS},scale=640:-2,blurdetect,metadata=mode=print:key=lavfi.blur",
                             "-f", "null", "-"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    scores = re.findall(r"pts_time:([0-9.]+)[^\n]*\n[^\n]*lavfi\.blur=([0-9.]+)", result.stderr)
    if not scores:
        return cited, float("nan")
    offset, blur = min(scores, key=lambda pair: float(pair[1]))
    return start + float(offset), float(blur)


def usual_crop(copy: str, copies: dict, index: dict) -> str | None:
    """The crop of a copy when cropdetect finds nothing: the one the scenario states for that copy
    (`meta.copies.<copy>.crop`), else the crop most of the copy's other frames got. A night scene has
    no row black enough to tell the picture from the bars; the bars are the same on every frame."""
    stated = copies[copy].get("crop")
    if stated:
        return stated
    seen = [entry.get("crop") for entry in index.values() if entry.get("copy") == copy and entry.get("crop")]
    if not seen:
        return None
    return max(set(seen), key=seen.count)


def frame_specs(scenario: dict) -> list[dict]:
    wanted: dict[tuple, dict] = {}
    for beat in scenario["beats"]:
        brick = beat["brick"]
        specs = []
        if brick["type"] in ("frame", "quoted_frame"):
            specs.append(brick)
        elif brick["type"] == "split_frames":
            specs += [brick["left"], brick["right"]]
        for spec in specs:
            key = (spec["movie_id"], spec["copy"], spec["timecode"])
            wanted.setdefault(key, {"movie_id": spec["movie_id"], "copy": spec["copy"], "timecode": spec["timecode"],
                                    "exact": bool(spec.get("exact")), "window": spec.get("window")})
    return list(wanted.values())


def frame_path(assets: Path, spec: dict) -> Path:
    return assets / "frames" / f"{spec['movie_id']}-{timecode_slug(spec['timecode'])}.jpg"


def frame_index_path(assets: Path) -> Path:
    return assets / "frames" / "frames.json"


def load_frame_index(assets: Path) -> dict:
    path = frame_index_path(assets)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def build_frames(scenario: dict, assets: Path, force: bool, no_crop: bool = False) -> None:
    copies = scenario["meta"]["copies"]
    (assets / "frames").mkdir(parents=True, exist_ok=True)
    index = load_frame_index(assets)
    for spec in frame_specs(scenario):
        out = frame_path(assets, spec)
        if out.exists() and not force and out.name in index:
            print(f"  frame kept   {out.name}")
            continue
        source = Path(copies[spec["copy"]]["file"])
        if not source.exists():
            sys.exit(f"copy not found: {source}")
        started = time.monotonic()
        if spec["exact"]:
            taken, blur = parse_timecode(spec["timecode"]), float("nan")
        else:
            window = tuple(spec["window"]) if spec.get("window") else SHARPEN_WINDOW
            taken, blur = sharpest_time(source, spec["timecode"], window)
        taken_tc = format_timecode(taken)
        crop = None if no_crop else (detect_crop(source, taken_tc) or usual_crop(spec["copy"], copies, index))
        filters = (f"crop={crop}," if crop else "") + f"scale='min({FRAME_MAX_WIDTH},iw)':-2"
        run(["ffmpeg", "-v", "error", "-y", "-ss", taken_tc, "-i", str(source), "-frames:v", "1",
             "-vf", filters, "-q:v", "2", str(out)])
        index[out.name] = {"movie_id": spec["movie_id"], "copy": spec["copy"], "cited": spec["timecode"],
                           "taken": taken_tc, "offset_s": round(taken - parse_timecode(spec["timecode"]), 2),
                           "blur": None if math.isnan(blur) else round(blur, 2), "crop": crop}
        frame_index_path(assets).write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
        print(f"  frame        {out.name}  ({time.monotonic() - started:.1f}s from {source.name}, taken at {taken_tc}"
              f"{', crop ' + crop if crop else ''})")


# ----------------------------------------------------------------------------- images

def image_specs(scenario: dict) -> list[dict]:
    meta = scenario["meta"]
    base = meta.get("images", {}).get("tmdb_base", "https://image.tmdb.org/t/p/w780")
    works = {w["movie_id"]: w for w in meta["works"]}
    sources = {w["source_work_id"]: w for w in meta["source_works"]}
    persons = {p["person_id"]: p for p in meta.get("persons", [])}
    related = {(r["kind"], r["id"]): r for r in meta.get("related", [])}
    wanted: dict[str, dict] = {}

    def add(name: str, url: str) -> None:
        wanted.setdefault(name, {"name": name, "url": url})

    for beat in scenario["beats"]:
        brick = beat["brick"]
        kind = brick["type"]
        if kind == "title_card":
            ids = brick.get("movie_id", [])
            for movie_id in ([ids] if isinstance(ids, int) else ids):
                path = works[movie_id].get("poster_path")
                if path:
                    add(f"poster-{movie_id}.jpg", base + path)
            sw = brick.get("source_work_id")
            if sw and sources[sw].get("cover_url"):
                add(f"cover-{sw}.jpg", sources[sw]["cover_url"])
        elif kind == "portraits":
            for person in brick.get("people", []):
                person_id = person["person_id"] if isinstance(person, dict) else person
                path = persons[person_id].get("profile_path")
                if path:
                    add(f"person-{person_id}.jpg", TMDB_IMAGE + TMDB_PROFILE_SIZE + path)
        elif kind == "poster_wall":
            for item in brick.get("items", []):
                entry = related[(item["kind"], item["id"])]
                if entry.get("poster_path"):
                    add(f"wall-{item['kind']}-{item['id']}.jpg", TMDB_IMAGE + TMDB_WALL_SIZE + entry["poster_path"])
    return list(wanted.values())


def build_images(scenario: dict, assets: Path, force: bool) -> None:
    (assets / "images").mkdir(parents=True, exist_ok=True)
    with httpx.Client(headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=60) as client:
        for spec in image_specs(scenario):
            out = assets / "images" / spec["name"]
            if out.exists() and not force:
                print(f"  image kept   {out.name}")
                continue
            response = client.get(spec["url"])
            response.raise_for_status()
            out.write_bytes(response.content)
            print(f"  image        {out.name}  ({len(response.content) // 1024} KB from {spec['url'].split('/')[2]})")


# ----------------------------------------------------------------------------- voices and timeline

def voice_config(meta: dict, name: str) -> tuple[str, str, float]:
    """Voice name, instructions and pitch shift in semitones (0 = as synthesized) of a speaker."""
    entry = meta["voices"][name]
    if isinstance(entry, str):
        return entry, "", 0.0
    return entry["voice"], entry.get("instructions", ""), float(entry.get("pitch_semitones", 0) or 0)


def shift_pitch(wav: Path, semitones: float) -> None:
    """Lower (or raise) a line's pitch in place, formants following, with ffmpeg's rubberband filter.

    A deeper timbre than the voice model offers: the delivery stays, the voice gets bigger."""
    shifted = wav.with_name(wav.stem + ".pitched.wav")
    factor = 2 ** (semitones / 12)
    run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-af",
         f"rubberband=pitch={factor:.5f}:formant=shifted:pitchq=quality", "-c:a", "pcm_s16le", str(shifted)])
    shifted.replace(wav)


def line_instructions(base: str, beat: dict) -> str:
    """The voice's instructions, plus the beat's own delivery hint (how this one line is played)."""
    delivery = (beat.get("delivery") or "").strip()
    if not delivery:
        return base
    return f"{base}\n\nThis line: {delivery}".strip()


def line_signature(voice: str, instructions: str, text: str, pitch: float = 0.0) -> str:
    parts = [TTS_MODEL, voice, instructions, text] + ([f"pitch={pitch:g}"] if pitch else [])
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- Gemini: one request per exchange

def tts_provider(scenario: dict, override: str | None) -> str:
    """`openai` (one request per line) or `gemini` (one multi-speaker request per exchange)."""
    if override:
        return override
    return (scenario["meta"].get("tts") or {}).get("provider", "openai")


def gemini_voice(meta: dict, name: str) -> str:
    entry = meta["voices"][name]
    voice = entry.get("gemini_voice") if isinstance(entry, dict) else None
    if not voice:
        sys.exit(f"meta.voices.{name}.gemini_voice is not set (a Gemini prebuilt voice name, e.g. Algenib)")
    return voice


def speech_text(beat: dict) -> str:
    """What the voice says: `speech` (with inline vocal tags and |backchannels|) when present, else the clean text."""
    return (beat.get("speech") or beat["text"]).strip()


def group_exchanges(beats: list[dict]) -> list[list[dict]]:
    """Consecutive lines grouped into exchanges, each under EXCHANGE_MAX_CHARS, cut at a line that asks for a
    pause (`pause_after_ms`, the end of a segment) when the exchange has grown past half the size."""
    exchanges: list[list[dict]] = []
    current: list[dict] = []
    size = 0
    for beat in beats:
        text = speech_text(beat)
        if current and size + len(text) > EXCHANGE_MAX_CHARS:
            exchanges.append(current)
            current, size = [], 0
        current.append(beat)
        size += len(text)
        if beat.get("pause_after_ms") and size > EXCHANGE_MAX_CHARS // 2:
            exchanges.append(current)
            current, size = [], 0
    if current:
        exchanges.append(current)
    return exchanges


def exchange_signature(model: str, speakers: dict, beats: list[dict]) -> str:
    parts = [model, json.dumps(speakers, sort_keys=True)]
    for beat in beats:
        parts += [beat["voice"], (beat.get("delivery") or "").strip(), speech_text(beat)]
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()


def synthesize_gemini(client: httpx.Client, model: str, speakers: dict, beats: list[dict], out: Path) -> dict:
    """One multi-speaker request for a whole exchange; the wav (24 kHz mono PCM) is written to `out`.

    Each line is a text item annotated with its speaker and its delivery as the turn's `style`; vocal
    tags (<laugh>, <short pause>) and |backchannels| stay inline in the text. Returns the usage block."""
    content = []
    for beat in beats:
        annotation = {"type": "speech_metadata", "speaker": beat["voice"]}
        if (beat.get("delivery") or "").strip():
            annotation["style"] = beat["delivery"].strip()
        content.append({"type": "text", "text": speech_text(beat), "annotations": [annotation]})
    payload = {
        "model": model,
        "input": [{"type": "user_input", "content": content}],
        "response_format": {"type": "audio"},
        "generation_config": {"speech_config": {"speakers": [{"speaker": role, "voice": voice}
                                                              for role, voice in speakers.items()]}},
    }
    for attempt in range(3):
        response = client.post(GEMINI_URL, json=payload)
        if response.status_code == 200:
            body = response.json()
            audio = [c for step in body.get("steps", []) if step.get("type") == "model_output"
                     for c in step.get("content", []) if c.get("type") == "audio"]
            if not audio:
                sys.exit(f"Gemini returned no audio for {out.name}: {json.dumps(body)[:300]}")
            import base64
            out.write_bytes(base64.b64decode(audio[-1]["data"]))
            return body.get("usage") or {}
        if response.status_code in (402, 403):
            sys.exit(f"Gemini refused the request: HTTP {response.status_code} {response.text[:300]}")
        wait = 2 ** attempt
        print(f"  gemini retry in {wait}s: HTTP {response.status_code} {response.text[:160]}")
        time.sleep(wait)
    sys.exit(f"Gemini text-to-speech failed for {out.name}")


_WORD = re.compile(r"[^a-z0-9']+")


def _norm_words(text: str) -> list[str]:
    """Words of a line as the recognizer will hear them: lowercase, no tags, no backchannels, no punctuation."""
    text = re.sub(r"<[^>]*>", " ", text)
    text = re.sub(r"\|[^|]*\|", " ", text)
    return [w for w in _WORD.split(text.lower()) if w]


def transcribe_words(wav: Path) -> list[tuple[str, float, float]]:
    """(word, start s, end s) of everything heard in the wav, by faster-whisper on the CPU."""
    os.environ.setdefault("CT2_USE_MKL", "0")  # the MKL build of CTranslate2 fails to allocate on this Windows box
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper is not installed (uv adds it from the script header; else pip install faster-whisper)")
    # the samples are read here, not by faster-whisper's PyAV decoder (its keyword arguments moved between versions)
    info = wav_info(wav)
    if not info:
        sys.exit(f"{wav} is not a plain PCM wav")
    rate, channels, _duration = info
    raw = wav.read_bytes()
    pos, data_offset = 12, None
    while pos + 8 <= len(raw):
        chunk_id, size = raw[pos:pos + 4], struct.unpack_from("<I", raw, pos + 4)[0]
        if chunk_id == b"data":
            data_offset = pos + 8
            break
        pos += 8 + size + (size & 1)
    samples = np.frombuffer(raw[data_offset:], dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        positions = np.arange(0, len(samples), rate / 16000.0)
        samples = np.interp(positions, np.arange(len(samples)), samples).astype(np.float32)
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(samples, language="en", word_timestamps=True, beam_size=5,
                                       condition_on_previous_text=False)
    words: list[tuple[str, float, float]] = []
    for segment in segments:
        for word in segment.words or []:
            for token in _norm_words(word.word):
                words.append((token, float(word.start), float(word.end)))
    return words


def align_exchange(words: list[tuple[str, float, float]], beats: list[dict], total_ms: int) -> list[dict]:
    """Where each line starts inside the exchange.

    The expected words of all the lines, in order, are aligned with the words heard by the longest common
    subsequence (monotonic, so a common opening like "And it..." cannot jump to an earlier line). A line
    starts at the first of its words that was heard ('heard'); a line none of whose words were heard gets
    a share of the time between its neighbours proportional to its word count ('estimated')."""
    expected: list[tuple[int, str]] = []  # (line index, word)
    for idx, beat in enumerate(beats):
        expected += [(idx, w) for w in _norm_words(beat["text"])]
    n, m = len(expected), len(words)
    # LCS table, then the backtrace gives the matched pairs
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, below = table[i], table[i + 1]
        wi = expected[i][1]
        for j in range(m - 1, -1, -1):
            row[j] = below[j + 1] + 1 if wi == words[j][0] else max(below[j], row[j + 1])
    matched: dict[int, int] = {}  # line index -> index of its first heard word
    i = j = 0
    while i < n and j < m:
        if expected[i][1] == words[j][0]:
            matched.setdefault(expected[i][0], j)
            i += 1
            j += 1
        elif table[i + 1][j] >= table[i][j + 1]:
            i += 1
        else:
            j += 1
    starts: list[int | None] = [round(words[matched[idx]][1] * 1000) if idx in matched else None for idx in range(len(beats))]
    confidence = ["heard" if s is not None else "estimated" for s in starts]
    starts[0] = 0
    # a line heard before the previous one (a word matched out of place) is treated as not heard
    for idx in range(1, len(beats)):
        if starts[idx] is not None and any(s is not None and s > starts[idx] for s in starts[:idx]):
            starts[idx], confidence[idx] = None, "estimated"
    # the lines that were not heard share the time between their heard neighbours
    idx = 0
    count = len(beats)
    while idx < count:
        if starts[idx] is not None:
            idx += 1
            continue
        end = idx
        while end < count and starts[end] is None:
            end += 1
        left_ms = starts[idx - 1]
        right_ms = total_ms if end >= count else starts[end]
        span = list(range(idx - 1, end))
        weights = [max(1, len(_norm_words(beats[k]["text"]))) for k in span]
        acc = left_ms
        for k, weight in zip(span, weights):
            if k != idx - 1:
                starts[k] = round(acc)
            acc += (right_ms - left_ms) * weight / sum(weights)
        idx = end
    bounds: list[dict] = []
    for idx in range(count):
        start_ms = starts[idx]
        end_ms = starts[idx + 1] if idx + 1 < count else total_ms
        bounds.append({"start_ms": start_ms, "end_ms": max(end_ms, start_ms + 200), "confidence": confidence[idx]})
    return bounds


def slice_wav(src: Path, start_ms: int, end_ms: int, out: Path) -> None:
    """Cut [start_ms, end_ms) of a PCM wav into a new wav, by bytes: no ffmpeg launch per line."""
    info = wav_info(src)
    if not info:
        sys.exit(f"{src} is not a plain PCM wav")
    rate, channels, _duration = info
    with src.open("rb") as handle:
        head = handle.read(4096)
    pos, bits, data_offset = 12, 16, None
    while pos + 8 <= len(head):
        chunk_id, size = head[pos:pos + 4], struct.unpack_from("<I", head, pos + 4)[0]
        if chunk_id == b"fmt ":
            bits = struct.unpack_from("<H", head, pos + 22)[0]
        elif chunk_id == b"data":
            data_offset = pos + 8
            break
        pos += 8 + size + (size & 1)
    frame_size = channels * bits // 8
    first = data_offset + (start_ms * rate // 1000) * frame_size
    last = data_offset + (end_ms * rate // 1000) * frame_size
    with src.open("rb") as handle:
        handle.seek(first)
        data = handle.read(max(0, last - first))
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * frame_size, frame_size, bits)
    out.write_bytes(header + b"data" + struct.pack("<I", len(data)) + data)


def build_audio_gemini(scenario: dict, assets: Path, force: bool) -> None:
    """Voices by Gemini, one multi-speaker request per exchange, then the exchange wav cut into one wav per
    line at the boundaries faster-whisper hears. `audio/exchanges.json` records, per line, its exchange and
    where it sits in it: the timeline keeps the lines of one exchange glued (no inserted gap)."""
    load_dotenv(ROOT / ".env")
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        sys.exit("GEMINI_API_KEY is not set (environment or .env)")
    meta = scenario["meta"]
    model = (meta.get("tts") or {}).get("model") or GEMINI_MODEL
    speakers = {role: gemini_voice(meta, role) for role in meta["voices"]}
    audio_dir = assets / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    index_path = audio_dir / "exchanges.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    exchanges = group_exchanges(scenario["beats"])
    print(f"  gemini       {len(exchanges)} exchanges for {len(scenario['beats'])} lines, model {model}, voices {speakers}")
    with httpx.Client(headers={"x-goog-api-key": api_key, "Content-Type": "application/json"}, timeout=300) as client:
        for beats in exchanges:
            key = beats[0]["id"]
            wav = audio_dir / f"x-{key}.wav"
            sidecar = wav.with_suffix(".json")
            signature = exchange_signature(model, speakers, beats)
            previous = json.loads(sidecar.read_text(encoding="utf-8")) if sidecar.exists() else {}
            lines_ok = all((audio_dir / f"{b['id']}.wav").exists() for b in beats)
            if wav.exists() and lines_ok and not force and previous.get("signature") == signature:
                continue
            started = time.monotonic()
            usage = synthesize_gemini(client, model, speakers, beats, wav)
            info = wav_info(wav)
            if not info:
                sys.exit(f"{wav.name}: not a PCM wav")
            total_ms = info[2]
            words = transcribe_words(wav)
            bounds = align_exchange(words, beats, total_ms)
            heard = sum(1 for b in bounds if b["confidence"] == "heard")
            for beat, bound in zip(beats, bounds):
                out = audio_dir / f"{beat['id']}.wav"
                slice_wav(wav, bound["start_ms"], bound["end_ms"], out)
                out.with_suffix(".json").write_text(json.dumps({
                    "signature": signature, "model": model, "voice": speakers[beat["voice"]], "exchange": key,
                    "start_in_exchange_ms": bound["start_ms"], "end_in_exchange_ms": bound["end_ms"],
                    "confidence": bound["confidence"], "delivery": beat.get("delivery", ""),
                    "speech": speech_text(beat), "text": beat["text"]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                index[beat["id"]] = {"exchange": key, "start_ms": bound["start_ms"], "end_ms": bound["end_ms"],
                                     "confidence": bound["confidence"]}
            sidecar.write_text(json.dumps({"signature": signature, "model": model, "speakers": speakers,
                                           "lines": [b["id"] for b in beats], "duration_ms": total_ms,
                                           "usage": usage}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"  exchange     {wav.name}  {len(beats)} lines, {fmt_ms(total_ms)}, {heard}/{len(beats)} boundaries heard"
                  f"  ({time.monotonic() - started:.1f}s)")


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
            sidecar = out.with_suffix(".json")
            voice, base, pitch = voice_config(meta, beat["voice"])
            instructions = line_instructions(base, beat)
            signature = line_signature(voice, instructions, beat["text"], pitch)
            if out.exists() and not force:
                previous = json.loads(sidecar.read_text(encoding="utf-8")).get("signature") if sidecar.exists() else None
                if previous == signature:
                    continue
                reason = "changed" if previous else "unsigned"
            else:
                reason = "new"
            started = time.monotonic()
            synthesize(client, beat["text"], voice, instructions, out)
            if pitch:
                shift_pitch(out, pitch)
            sidecar.write_text(json.dumps({"signature": signature, "model": TTS_MODEL, "voice": voice,
                                           "pitch_semitones": pitch, "delivery": beat.get("delivery", ""),
                                           "text": beat["text"]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            shifted = f" {pitch:+g} st" if pitch else ""
            print(f"  voice        {out.name}  {beat['voice']}/{voice}{shifted}  ({reason}, {time.monotonic() - started:.1f}s,"
                  f" {len(beat['text'].split())} words)")


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
    frames = load_frame_index(assets)
    index_path = audio_dir / "exchanges.json"
    exchanges = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    concat_lines: list[str] = []
    cursor = 0
    timeline = {"version": scenario["version"], "meta": scenario["meta"], "assets_dir": str(assets), "beats": []}
    transcript: list[str] = []
    beats = scenario["beats"]
    for i, beat in enumerate(beats):
        wav = audio_dir / f"{beat['id']}.wav"
        duration = probe_duration_ms(wav)
        entry = dict(beat)
        entry["start_ms"] = cursor
        entry["duration_ms"] = duration
        entry["audio"] = str(wav.relative_to(assets)).replace("\\", "/")
        entry["brick"] = resolve_brick(beat["brick"], scenario, assets, frames)
        if beat["id"] in exchanges:
            entry["exchange"] = exchanges[beat["id"]]["exchange"]
        timeline["beats"].append(entry)
        transcript.append(f"[{fmt_ms(cursor)}] {beat['voice'].capitalize():<8} {beat['text']}")
        concat_lines.append(f"file '{wav.as_posix()}'")
        cursor += duration
        # lines cut from one Gemini exchange are glued back as synthesized: the natural pause is already in the audio
        same_exchange = (i + 1 < len(beats) and beat["id"] in exchanges and beats[i + 1]["id"] in exchanges
                         and exchanges[beat["id"]]["exchange"] == exchanges[beats[i + 1]["id"]]["exchange"])
        pause = 0 if same_exchange else GAP_MS + int(beat.get("pause_after_ms", 0))
        if pause:
            gap = silence(audio_dir, pause, rate, channels)
            concat_lines.append(f"file '{gap.as_posix()}'")
            cursor += pause
    timeline["duration_ms"] = cursor
    transcript.append(f"[{fmt_ms(cursor)}] END")
    concat_file = audio_dir / "concat.txt"
    concat_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
    episode_wav = assets / "episode.wav"
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(episode_wav)])
    run(["ffmpeg", "-v", "error", "-y", "-i", str(episode_wav), "-c:a", "libmp3lame", "-b:a", MP3_BITRATE,
         str(assets / "episode.mp3")])
    (assets / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (assets / "transcript.txt").write_text("\n".join(transcript) + "\n", encoding="utf-8")
    return timeline


def resolve_frame(spec: dict, assets: Path, frames: dict) -> dict:
    path = frame_path(assets, spec)
    out = dict(spec, image=path.relative_to(assets).as_posix())
    taken = frames.get(path.name, {}).get("taken")
    if taken:
        out["taken"] = taken
    return out


def resolve_brick(brick: dict, scenario: dict, assets: Path, frames: dict) -> dict:
    meta = scenario["meta"]
    out = dict(brick)
    if brick["type"] in ("frame", "quoted_frame"):
        out = resolve_frame(brick, assets, frames)
    elif brick["type"] == "split_frames":
        out["left"] = resolve_frame(brick["left"], assets, frames)
        out["right"] = resolve_frame(brick["right"], assets, frames)
    elif brick["type"] == "title_card":
        ids = brick.get("movie_id", [])
        ids = [ids] if isinstance(ids, int) else ids
        out["images"] = [f"images/poster-{i}.jpg" for i in ids if (assets / "images" / f"poster-{i}.jpg").exists()]
        sw = brick.get("source_work_id")
        if sw and (assets / "images" / f"cover-{sw}.jpg").exists():
            out["images"].append(f"images/cover-{sw}.jpg")
    elif brick["type"] == "portraits":
        persons = {p["person_id"]: p for p in meta.get("persons", [])}
        people = []
        for person in brick.get("people", []):
            spec = person if isinstance(person, dict) else {"person_id": person}
            entry = persons[spec["person_id"]]
            image = f"images/person-{spec['person_id']}.jpg"
            people.append({"person_id": spec["person_id"], "name": entry["name"], "caption": spec.get("caption", ""),
                           "image": image if (assets / image).exists() else None})
        out["people"] = people
    elif brick["type"] == "poster_wall":
        related = {(r["kind"], r["id"]): r for r in meta.get("related", [])}
        items = []
        for item in brick.get("items", []):
            entry = related[(item["kind"], item["id"])]
            image = f"images/wall-{item['kind']}-{item['id']}.jpg"
            items.append({"kind": item["kind"], "id": item["id"], "title": entry["title"], "year": entry.get("year"),
                          "image": image if (assets / image).exists() else None})
        out["items"] = items
    return out


# ----------------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scenario", type=Path)
    parser.add_argument("--only", choices=["frames", "images", "audio", "timeline"], action="append", default=[])
    parser.add_argument("--force", action="store_true", help="rebuild assets already on disk")
    parser.add_argument("--no-crop", action="store_true", help="keep the black bars of letterboxed copies")
    parser.add_argument("--tts", choices=["openai", "gemini"], default=None,
                        help="voice provider (default: meta.tts.provider of the scenario, else openai)")
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
        provider = tts_provider(scenario, args.tts)
        if provider == "gemini":
            build_audio_gemini(scenario, assets, args.force)
        else:
            index_path = assets / "audio" / "exchanges.json"
            if index_path.exists():
                index_path.unlink()  # lines synthesized one by one: the timeline inserts its gaps again
            build_audio(scenario, assets, args.force)
    if "timeline" in steps:
        timeline = build_timeline(scenario, assets)
        print(f"timeline: {len(timeline['beats'])} beats, {fmt_ms(timeline['duration_ms'])} total, episode.mp3 and transcript.txt written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
