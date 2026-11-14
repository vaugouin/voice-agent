"""Offline persona contracts and optional composer smoke comparison (no database calls).

Run with the application's requirements. The default fixture was recaptured after the intentional four-persona rewrite in
1.13.3; never regenerate it merely to make a regression pass. Six assembled
instruction hashes had already drifted before that rewrite, while SOUL.md and
_core.md still matched the earlier fixture.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
FIXED_DATE = "Today is 2026-11-12 in Europe/Paris."
# Evaluation cases are defined before prompt changes. Live checks below deliberately
# distinguish composer output from browser audio and interruption acceptance.
SCENARIOS = [
    ("open", "What makes The Last Signal unsettling?", "Qu'est-ce qui rend Le Dernier Signal angoissant ?", "Develop a distinct viewpoint; chatterbox develops several connected angles."),
    ("recommend", "Would this suit an evening when I want slow tension?", "Est-ce adapté à une soirée où je cherche une tension lente ?", "Defend a viewing judgment using the supplied pace and mood."),
    ("technique", "How do framing and sound create tension?", "Comment le cadrage et le son créent-ils la tension ?", "Explain a concrete choice and its effect, without invented scenes."),
    ("context", "How does its setting shape the film?", "Comment le lieu façonne-t-il le film ?", "Connect isolation, trust and uncertainty, staying on this film."),
    ("disagreement", "I find this unbearably slow. What do you think?", "Je le trouve insupportablement lent. Qu'en penses-tu ?", "Give a reasoned view without automatic agreement or manufactured disagreement."),
    ("fact", "What is the runtime?", "Quelle est sa durée ?", "Answer 104 minutes directly; no unsolicited essay."),
    ("short", "In one sentence, what makes it unsettling?", "En une phrase, qu'est-ce qui le rend angoissant ?", "Explicit brevity takes precedence for every persona."),
    ("expand", "Go into detail about how its suspense works.", "Détaille la façon dont son suspense fonctionne.", "Develop further; subsequent ordinary answers keep the selected persona's usual length."),
    ("scant", "What did the director say about the ending?", "Qu'a dit la realisatrice de la fin ?", "Acknowledge the missing statement naturally, without inventing quotations."),
    ("list", "Summarize the three films shown on screen.", "Résume les trois films affichés à l'écran.", "Keep count/order/extremum accurate; do not recite rows or pad to a sentence target."),
]
MATERIAL = {
    "entity": "movie", "id": 999999,
    "detail": {
        "ID_MOVIE": 999999, "TITLE": "The Last Signal", "RUNTIME": 104,
        "wikipedia_content": [
            {"title": "Introduction", "content": "The Last Signal is a fictional chamber thriller set in an isolated coastal radio station. Four technicians shelter there during a storm. A repeated transmission suggests someone inside is concealing information. The runtime is 104 minutes. The film favors slow tension over action. The audience learns only what the technicians can hear and observe. No account of the director's statements is available."},
            {"title": "Style and suspense", "content": "Long static shots hold the group in the same frame. Doorways and glass partitions divide the image even when everyone is in the same room. The frame makes the distance between people visible. Faces at the edge of the frame can react before the central speaker notices them. The sound mixes low radio noise with long gaps. A repeated signal may be a warning or an ordinary fault; the film delays its explanation. Storm noise masks parts of conversations. Exchanges become difficult to interpret because the characters cannot verify what they hear. The suspense comes from uncertainty rather than frequent shocks. The film leaves time for viewers to scrutinize small changes in behavior."},
            {"title": "Structure and reception", "content": "The same evening is shown in three successive phases: cooperation, suspicion, and a fragile attempt to work together again. Information arrives unevenly: one technician hears a transmission that the others do not. Conflicting interpretations create tension without proving which person is right. The station cannot contact the mainland, so the group must act without external confirmation. Critics praised the interplay between restricted knowledge and the enclosed setting, while some found the middle section repetitive. The final scene leaves the origin of one signal unresolved. The uncertainty about it does not settle the characters' earlier disagreements. There are no reported awards, production anecdotes, or documented statements by the director in this fictional fixture."},
        ],
    },
}


def load_app(root):
    sys.path.insert(0, str(root))
    spec = importlib.util.spec_from_file_location("persona_checked_app", root / "app/main.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    exec(compile((root / "app/main.py").read_text(encoding="utf-8"), str(root / "app/main.py"), "exec"), module.__dict__)
    module.current_date_instructions = lambda: FIXED_DATE
    return module


def assembled(module, root, surface, slug, *, language="en", image=False, focus=True):
    soul = module.resolve_soul(slug)
    if surface == "voice":
        return module.realtime_session_config(soul=soul, structured_card_focus=focus)["instructions"]
    function = {"text": "text_chat", "brief": "brief", "deep": "deep_answer"}[surface]
    tree = ast.parse((root / "app/main.py").read_text(encoding="utf-8"))
    node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == function)
    selected = []
    for statement in node.body:
        if isinstance(statement, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "instructions" for t in statement.targets):
            selected.append(statement)
        elif isinstance(statement, ast.AugAssign) and isinstance(statement.target, ast.Name) and statement.target.id == "instructions":
            selected.append(statement)
        elif isinstance(statement, ast.If) and isinstance(statement.test, ast.Name) and statement.test.id == "image_ref":
            if any(isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name) and n.target.id == "instructions" for n in ast.walk(statement)):
                selected.append(statement)
    assert selected, f"No instruction assembly found in {function}"
    namespace = dict(vars(module), active_soul=soul, ui_language=language, image_ref="fixture.jpg" if image else None)
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(root / "app/main.py"), "exec"), namespace)
    return namespace["instructions"]


def digest(value):
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def default_snapshot(module, root):
    result = {"files": {p: digest((root / p).read_bytes()) for p in ("SOUL.md", "souls/_core.md")}, "instructions": {}}
    for focus in (False, True):
        result["instructions"][f"voice/focus={focus}"] = digest(assembled(module, root, "voice", "default", focus=focus))
    for language in ("en", "fr"):
        for surface in ("text", "brief", "deep"):
            for image in ((False, True) if surface == "text" else (False,)):
                key = f"{surface}/{language}/image={image}"
                result["instructions"][key] = digest(assembled(module, root, surface, "default", language=language, image=image))
    return result


def contracts(module, root, baseline):
    failures = []
    checks = 0

    def check(condition, description):
        nonlocal checks
        checks += 1
        if not condition:
            failures.append(description)

    check(default_snapshot(module, root) == baseline, "default instructions or default/core bytes changed")
    check(set(module.AGENT_SOULS) == {"default", "video-store", "scholar", "chatterbox"}, "exactly four personas remain selectable")
    expected_ranges = {"video-store": {"voice": "three to five", "text": "three to five", "brief": "three to five", "deep": "six to nine"}, "scholar": {"voice": "four to seven", "text": "four to seven", "brief": "four to seven", "deep": "eight to twelve"}, "chatterbox": {"voice": "twelve to eighteen", "text": "twelve to eighteen", "brief": "eight to twelve", "deep": "sixteen to twenty-four"}}
    forbidden = ["Default to concise answers.", "return to concise answers", "respond in a short spoken summary by default", "then stop."]
    for slug, ranges in expected_ranges.items():
        soul = module.resolve_soul(slug)
        for surface in ("voice", "text", "brief", "deep"):
            for language in ("en", "fr"):
                prompt = assembled(module, root, surface, slug, language=language)
                check(prompt.startswith(soul.prose + " " + module.AGENT_SOUL_CORE), f"{slug}/{surface}: character followed by unchanged core")
                check(ranges[surface] in prompt, f"{slug}/{surface}: distinct length target")
                check(not any(s in prompt for s in forbidden), f"{slug}/{surface}: common concision does not cancel persona")
                if surface in ("voice", "text"):
                    check("explicit request for brevity" in prompt and "narrow factual" in prompt, f"{slug}/{surface}: short answers remain available")
                    check("call the dedicated detail tool" in prompt, f"{slug}/{surface}: verbose grounding preserved")
                else:
                    check("explicit request for brevity" in prompt, f"{slug}/{surface}: explicit brevity also wins in composers")
                if surface == "text":
                    check("never write markdown" in prompt and "Never repeat the rows" in prompt, f"{slug}: screen rows and plain subtitles preserved")
                if surface == "voice":
                    check("do not add a total it does not give" in prompt, f"{slug}: summary facts preserved")
    prose = {s: module.resolve_soul(s).prose.lower() for s in expected_ranges}
    check("clear take" in prose["video-store"] and "concrete" in prose["video-store"], "video-store defends a concrete judgment")
    check("interpretation" in prose["scholar"] and "effect" in prose["scholar"], "scholar explains a mechanism")
    check("connected angles" in prose["chatterbox"] and "fresh" in prose["chatterbox"], "chatterbox develops fresh connected angles")
    check("do not wrap up" not in prose["chatterbox"] and "circle back" not in prose["chatterbox"], "chatterbox can finish without repetition")
    js = (root / "app/static/app.js").read_text(encoding="utf-8")
    match = re.search(r"function reconnectAnswerInstructions\(soul\) \{.*?\n\}", js, re.S)
    check(bool(match), "reconnection has a profile-aware continuation policy")
    if match:
        node = match.group(0) + '\nconst assert = require("node:assert/strict");\nassert.equal(reconnectAnswerInstructions("default"), "Continue the interrupted spoken answer concisely.");\nassert.equal(reconnectAnswerInstructions("unknown"), reconnectAnswerInstructions("default"));\nfor (const slug of ["video-store", "scholar", "chatterbox"]) assert.ok(!reconnectAnswerInstructions(slug).includes("concisely"));\n'
        completed = subprocess.run(["node", "-e", node], capture_output=True, text=True)
        check(completed.returncode == 0, "reconnection preserves default and respects alternatives: " + completed.stderr)
        check('sdpResponse.headers.get("X-Agent-Soul")' in js and "reconnectAnswerInstructions(realtimeSessionSoul)" in js, "reconnection uses server-resolved session persona, not current picker")
    print(f"{checks} contracts; {len(failures)} failures; {len(SCENARIOS)} paired EN/FR scenarios defined (not a model-quality score)")
    for failure in failures:
        print("FAIL:", failure)
    return 1 if failures else 0


async def live_comparison(module, root, output, case_ids):
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY unavailable; live comparison was not run")
    results = []

    async def fixed_detail(*args, **kwargs):
        return MATERIAL

    # Paired-language composer smoke cases, all four personas, fixed grounding.
    async def run(slug, language, question):
        payload = module.DeepAnswerRequest(tool_name="get_movie_detail", args={"id": 999999}, ui_language=language, soul=slug, question=question)
        answer = await module.deep_answer(payload)
        text = answer.get("deep_answer") or answer.get("answer") or answer.get("text") or ""
        if not text:
            raise AssertionError(f"Missing output text, keys={list(answer)}")
        row = {"soul": slug, "language": language, "question": question, "words": len(text.split()), "text": text}
        print(json.dumps({k: v for k, v in row.items() if k != "text"}, ensure_ascii=False), flush=True)
        return row

    with patch.object(module, "execute_text_tool", fixed_detail), patch.object(module, "write_client_log", lambda *a, **k: None):
        for case_id, en, fr, expected in SCENARIOS:
            if case_ids != "all" and case_id not in case_ids.split(","):
                continue
            for language, question in [("en", en), ("fr", fr)]:
                rows = await asyncio.gather(*(run(slug, language, question) for slug in ("default", "video-store", "scholar", "chatterbox")))
                for row in rows:
                    row["case"] = case_id
                results.extend(rows)
    if not results:
        raise SystemExit("No matching live case; use a case id from SCENARIOS or all")
    output.write_text(json.dumps({"version": module.APP_VERSION, "model": module.deep_answer_model_settings()[0], "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--capture-default", type=Path)
    parser.add_argument("--live", type=Path, help="Run eight paid composer smoke requests and save responses; not an audio test")
    parser.add_argument("--live-cases", default="open", help="Comma-separated scenario ids, or all (80 paid requests); default: open (8)")
    args = parser.parse_args()
    root = args.root.resolve()
    module = load_app(root)
    if args.capture_default:
        args.capture_default.write_text(json.dumps(default_snapshot(module, root), indent=2) + "\n", encoding="utf-8")
        print("Captured default before changes:", args.capture_default)
        return 0
    if args.live:
        asyncio.run(live_comparison(module, root, args.live, args.live_cases))
        return 0
    baseline = args.baseline or root / "tools/persona-default-baseline.json"
    return contracts(module, root, json.loads(baseline.read_text(encoding="utf-8")))


if __name__ == "__main__":
    raise SystemExit(main())
