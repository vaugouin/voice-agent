"""Read the bench sessions (results/*/events.jsonl) and write the comparison (VOICE-AGENT-242).

  uv run --no-project python bench/report.py                 # every session under results/
  uv run --no-project python bench/report.py --since 20261029 # sessions whose folder starts later

Writes results/report-<stamp>.md (the tables), results/report-<stamp>.csv (one row per session
and question) and, once, results/scores.csv: the judgments a script cannot make (does the voice
agree with the screen, is the French voice acceptable), to fill by hand and read back next time.

Prices are list prices noted on 2026-10-28 from secondary sources (see PRICES): re-check them
against the providers' pages before quoting a cost outside this bench.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

BENCH = Path(__file__).resolve().parent
RESULTS = BENCH / "results"

# US dollars per million tokens unless noted. Realtime 2.1: audio from orcarouter.ai, text from
# futureagi.com (2026-10-28, not OpenAI's own page). Gemini 3.8 Live: ai.google.dev/pricing, read
# 2026-10-28 (thinking billed as text output). GPT-Live-1: $0.05 per minute of session, billed
# per second (OpenAI forum announcement). Backend models: fastapi-text2sql/llm_costs.py.
PRICES = {
    # cached_in: OpenAI's gpt-realtime rate ($0.40), assumed unchanged on 2.1: to verify.
    "realtime": {"audio_in": 32.0, "text_in": 4.0, "cached_in": 0.40, "audio_out": 64.0, "text_out": 24.0},
    "gemini": {"audio_in": 3.0, "text_in": 0.75, "image_in": 1.0, "audio_out": 12.0, "text_out": 4.50},
    "live_per_minute": 0.05,
    "backend": {
        "gpt-6.1-terra": (1.00, 0.05, 5.00), "gpt-6.1-sol": (2.00, 0.10, 10.00),
        "gpt-6-sol": (2.00, 0.20, 10.00), "gpt-6-luna": (0.10, 0.01, 0.50),
        "gpt-6-astra": (10.00, 1.00, 50.00),
    },
}


def load_events(folder: Path) -> list[dict[str, Any]]:
    with (folder / "events.jsonl").open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


# --------------------------------------------------------------------------- cost

def realtime_cost(usages: list[dict[str, Any]]) -> float:
    price = PRICES["realtime"]
    total = 0.0
    for usage in usages:
        inp = usage.get("input_token_details") or {}
        out = usage.get("output_token_details") or {}
        cached = inp.get("cached_tokens_details") or {}
        cached_audio, cached_text = cached.get("audio_tokens", 0), cached.get("text_tokens", 0)
        total += ((inp.get("audio_tokens", 0) - cached_audio) * price["audio_in"]
                  + (inp.get("text_tokens", 0) - cached_text) * price["text_in"]
                  + (cached_audio + cached_text) * price["cached_in"]
                  + out.get("audio_tokens", 0) * price["audio_out"] + out.get("text_tokens", 0) * price["text_out"])
    return total / 1_000_000


def gemini_cost(usages: list[dict[str, Any]]) -> tuple[float, str]:
    """Gemini sends usage_metadata several times; the docs do not say whether it is cumulative.

    If the totals never decrease the last one is taken as the session total, otherwise they are
    summed. The choice is reported beside the cost so a wrong reading shows.
    """
    if not usages:
        return 0.0, "none"
    totals = [u.get("total_token_count", 0) for u in usages]
    cumulative = all(b >= a for a, b in zip(totals, totals[1:]))
    chosen = [usages[-1]] if cumulative else usages
    price = PRICES["gemini"]
    total = 0.0
    for usage in chosen:
        for detail in usage.get("prompt_tokens_details") or []:
            modality = str(detail.get("modality", "")).upper()
            rate = price["audio_in"] if "AUDIO" in modality else price["image_in"] if modality in ("IMAGE", "VIDEO") else price["text_in"]
            total += detail.get("token_count", 0) * rate
        response_details = usage.get("response_tokens_details") or []
        audio_out = sum(d.get("token_count", 0) for d in response_details if "AUDIO" in str(d.get("modality", "")).upper())
        text_out = usage.get("response_token_count", 0) - audio_out + usage.get("thoughts_token_count", 0)
        total += audio_out * price["audio_out"] + max(text_out, 0) * price["text_out"]
    return total / 1_000_000, "cumulative" if cumulative else "summed"


def backend_cost(usages: list[dict[str, Any]], model: str) -> float:
    key = next((k for k in sorted(PRICES["backend"], key=len, reverse=True) if model.startswith(k)), None)
    if not key:
        return float("nan")
    p_in, p_cached, p_out = PRICES["backend"][key]
    total = 0.0
    for usage in usages:
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
        total += ((usage.get("input_tokens", 0) - cached) * p_in + cached * p_cached
                  + usage.get("output_tokens", 0) * p_out)
    return total / 1_000_000


def session_cost(events: list[dict[str, Any]], info: dict[str, Any]) -> tuple[float, str]:
    usage_events = [e for e in events if e["kind"] == "usage" and e.get("usage")]
    arm = info["arm"]
    if arm == "realtime":
        return realtime_cost([e["usage"] for e in usage_events]), ""
    if arm.startswith("gemini"):
        return gemini_cost([e["usage"] for e in usage_events])
    closed = [e for e in events if e["kind"] == "session_closed"]
    seconds = ((closed[-1].get("usage") or {}).get("seconds") if closed else None)
    note = "" if seconds is not None else "voice seconds unconfirmed, wall clock used"
    if seconds is None:
        seconds = events[-1]["t"] / 1000.0
    voice = seconds / 60.0 * PRICES["live_per_minute"]
    backend = backend_cost([e["usage"] for e in usage_events if e.get("source") == "backend"],
                           info.get("backend_model", ""))
    return voice + backend, note


# --------------------------------------------------------------------------- per question

def turn_metrics(events: list[dict[str, Any]], q: dict[str, Any]) -> dict[str, Any]:
    window = [e for e in events if e.get("q") == q["id"]]
    clip_start = next((e["t"] for e in window if e["kind"] == "clip_start"), None)
    speech_end = next((e["t"] for e in window if e["kind"] == "clip_speech_end"), None)
    audio = [e for e in window if e["kind"] == "audio_out"]
    # `play` is when the simulated speaker starts the chunk, i.e. when the user hears it.
    after = [e for e in audio if speech_end is not None and e.get("play", e["t"]) >= speech_end]
    latency = round(after[0].get("play", after[0]["t"]) - speech_end) if after else None
    silence = round(max((e["gap"] for e in after[1:]), default=0)) if after else None
    tools = [e for e in window if e["kind"] == "tool_start"]
    tool_ends = [e for e in window if e["kind"] == "tool_end"]
    user = " ".join(e["text"] for e in window if e["kind"] in ("user_transcript",)) or \
        "".join(e["text"] for e in window if e["kind"] == "user_transcript_delta")
    assistant = " ".join(e["text"] for e in window if e["kind"] == "assistant_transcript") or \
        "".join(e["text"] for e in window if e["kind"] == "assistant_transcript_delta")
    metrics: dict[str, Any] = {
        "latency_ms": latency,
        "longest_heard_silence_ms": silence,
        "reply_audio_s": round(sum(e["ms"] for e in after) / 1000, 1) if after else 0,
        "tools": [f"{t['name']}({json.dumps(t.get('args'), ensure_ascii=False)})" for t in tools],
        "tool_ms": round(sum(e.get("ms", 0) for e in tool_ends)),
        "tool_errors": [e.get("error") for e in tool_ends if e.get("error")],
        "user": user.strip(),
        "assistant": assistant.strip(),
        "turn_end": next((e.get("how") for e in window if e["kind"] in ("turn_end", "barge_point")), ""),
    }
    if q.get("barge_in") and clip_start is not None:
        signal = next((e["t"] for e in window if e["kind"] == "interrupt_signal"), None)
        metrics["interrupt_signal_ms"] = round(signal - clip_start) if signal is not None else None
        end = (speech_end or clip_start) + 500
        metrics["talk_over_s"] = round(sum(e["ms"] for e in audio if clip_start <= e.get("play", e["t"]) <= end) / 1000, 1)
    metrics["checks"] = checks(q.get("expect") or {}, tools)
    return metrics


def checks(expect: dict[str, Any], tools: list[dict[str, Any]]) -> dict[str, bool]:
    names = [t["name"] for t in tools]
    searches = [t.get("args") or {} for t in tools if t["name"] == "query_text2sql"]
    result: dict[str, bool] = {}
    if "tools_any" in expect:
        result["right_tool"] = any(n in expect["tools_any"] for n in names)
    if expect.get("no_tools"):
        result["no_tool"] = not names
    for name, limit in (expect.get("max_calls") or {}).items():
        result[f"max_{limit}_{name}"] = names.count(name) <= limit
    if "ui_language" in expect and searches:
        result["ui_language"] = all((s.get("ui_language") or "en") == expect["ui_language"] for s in searches)
    if "search_must_mention_any" in expect and searches:
        words = [w.lower() for w in expect["search_must_mention_any"]]
        result["search_names_subject"] = all(any(w in str(s.get("query", "")).lower() for w in words) for s in searches)
    return result


# --------------------------------------------------------------------------- report

def median(values: list[Any]) -> Any:
    clean = [v for v in values if isinstance(v, (int, float))]
    return round(statistics.median(clean)) if clean else "-"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="", help="only session folders whose name sorts at or after this")
    parser.add_argument("--audio", default="audio", help="audio set tag in the folder name (audio, audio-tts)")
    args = parser.parse_args()

    all_questions = json.loads((BENCH / "questions.json").read_text(encoding="utf-8"))["questions"]
    sessions = []
    for folder in sorted(p for p in RESULTS.glob("*_run*") if p.is_dir()):
        if folder.name < args.since or f"_{args.audio}_" not in folder.name:
            continue
        if not (folder / "events.jsonl").exists() or not (folder / "session.json").exists():
            continue
        info = json.loads((folder / "session.json").read_text(encoding="utf-8"))
        events = load_events(folder)
        cost, cost_note = session_cost(events, info)
        per_q = {q["id"]: turn_metrics(events, q) for q in all_questions if q["id"] in info.get("questions", [])}
        sessions.append({"folder": folder.name, "info": info, "cost": cost, "cost_note": cost_note,
                         "minutes": round(events[-1]["t"] / 60000, 1), "q": per_q,
                         "errors": [e for e in events if e["kind"] == "error"]})
    if not sessions:
        raise SystemExit(f"No session found under {RESULTS} for audio set '{args.audio}'.")

    asked = {qid for s in sessions for qid in s["q"]}
    questions = [q for q in all_questions if q["id"] in asked]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    by_arm: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in sessions:
        by_arm[s["info"]["arm"]].append(s)
    arms = sorted(by_arm)

    lines = [f"# Voice-layer bench, report of {stamp}", "",
             f"Audio set: `{args.audio}`. Sessions: {len(sessions)}. Medians across runs; checks as passed/runs.", ""]
    lines += ["## By arm", "", "| Arm | Model | Runs | Median latency (ms) | Median longest silence (ms) | Checks passed | Cost per session ($) | Minutes |",
              "|---|---|---|---|---|---|---|---|"]
    for arm in arms:
        runs = by_arm[arm]
        lat = median([m["latency_ms"] for s in runs for m in s["q"].values()])
        sil = median([m["longest_heard_silence_ms"] for s in runs for m in s["q"].values()])
        passed = sum(v for s in runs for m in s["q"].values() for v in m["checks"].values())
        total = sum(len(m["checks"]) for s in runs for m in s["q"].values())
        cost = statistics.median([s["cost"] for s in runs])
        model = runs[0]["info"].get("model", "")
        if runs[0]["info"].get("backend_model"):
            model += f" + {runs[0]['info']['backend_model']} ({runs[0]['info'].get('effort') or 'default'})"
        lines.append(f"| {arm} | {model} | {len(runs)} | {lat} | {sil} | {passed}/{total} | {cost:.3f} | "
                     f"{statistics.median([s['minutes'] for s in runs])} |")
    notes = sorted({f"{s['info']['arm']}: {s['cost_note']}" for s in sessions if s["cost_note"]})
    if notes:
        lines += ["", "Cost notes: " + "; ".join(notes) + "."]

    lines += ["", "## Latency by question (median ms from end of speech to first reply audio)", "",
              "| Question | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)]
    for q in questions:
        cells = [str(median([s["q"][q["id"]]["latency_ms"] for s in by_arm[a] if q["id"] in s["q"]])) for a in arms]
        lines.append(f"| {q['id']} {q['kind']} | " + " | ".join(cells) + " |")

    lines += ["", "## Longest heard silence by question (median ms, after the reply started)", "",
              "| Question | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)]
    for q in questions:
        cells = [str(median([s["q"][q["id"]]["longest_heard_silence_ms"] for s in by_arm[a] if q["id"] in s["q"]])) for a in arms]
        lines.append(f"| {q['id']} | " + " | ".join(cells) + " |")

    lines += ["", "## Checks by question (passed/runs)", "", "| Question | " + " | ".join(arms) + " |",
              "|---|" + "---|" * len(arms)]
    for q in questions:
        cells = []
        for a in arms:
            runs = [s["q"][q["id"]] for s in by_arm[a] if q["id"] in s["q"]]
            names = sorted({k for m in runs for k in m["checks"]})
            cells.append(", ".join(f"{k} {sum(m['checks'].get(k, False) for m in runs)}/{len(runs)}" for k in names) or "-")
        lines.append(f"| {q['id']} | " + " | ".join(cells) + " |")

    barge = [q for q in questions if q.get("barge_in")]
    if barge:
        lines += ["", "## Barge-in", "", "| Arm | Interrupt signal (ms after the user starts) | Reply audio over the user (s) |", "|---|---|---|"]
        for a in arms:
            ms = [s["q"][q["id"]].get("interrupt_signal_ms") for s in by_arm[a] for q in barge if q["id"] in s["q"]]
            talk = [s["q"][q["id"]].get("talk_over_s") for s in by_arm[a] for q in barge if q["id"] in s["q"]]
            lines.append(f"| {a} | {', '.join(str(x) for x in ms)} | {', '.join(str(x) for x in talk)} |")

    lines += ["", "## Transcripts and tool calls, session by session", ""]
    for s in sessions:
        lines += [f"### {s['folder']}", "", f"Cost ${s['cost']:.3f}, {s['minutes']} min, {len(s['errors'])} error event(s).", ""]
        for qid, m in s["q"].items():
            lines.append(f"- **{qid}** heard: {m['user'] or '(no transcript)'}")
            lines.append(f"  - tools: {'; '.join(m['tools']) or 'none'} ({m['tool_ms']} ms)"
                         + (f", errors: {m['tool_errors']}" if m["tool_errors"] else ""))
            lines.append(f"  - said: {m['assistant'] or '(nothing)'}")
        for e in s["errors"][:5]:
            lines.append(f"- error at {e['t']} ms: `{json.dumps(e.get('error'), ensure_ascii=False)[:300]}`")
        lines.append("")

    md_path = RESULTS / f"report-{stamp}.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    csv_path = RESULTS / f"report-{stamp}.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["session", "arm", "question", "latency_ms", "longest_heard_silence_ms", "tool_ms",
                         "checks_passed", "checks_total", "tools", "user", "assistant"])
        for s in sessions:
            for qid, m in s["q"].items():
                writer.writerow([s["folder"], s["info"]["arm"], qid, m["latency_ms"], m["longest_heard_silence_ms"],
                                 m["tool_ms"], sum(m["checks"].values()), len(m["checks"]), " | ".join(m["tools"]),
                                 m["user"], m["assistant"]])

    scores = RESULTS / "scores.csv"
    known = set()
    if scores.exists():
        with scores.open(encoding="utf-8") as handle:
            known = {(r["session"], r["question"]) for r in csv.DictReader(handle)}
    new_rows = [(s["folder"], s["info"]["arm"], qid) for s in sessions for qid in s["q"] if (s["folder"], qid) not in known]
    if new_rows:
        write_header = not scores.exists()
        with scores.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            if write_header:
                writer.writerow(["session", "arm", "question", "voice_matches_screen (y/n)", "voice_quality (1-5)", "notes"])
            writer.writerows([[*row, "", "", ""] for row in new_rows])
    print(f"[report] {md_path}\n[report] {csv_path}\n[report] {scores} ({len(new_rows)} new row(s) to score by hand)")


if __name__ == "__main__":
    main()
