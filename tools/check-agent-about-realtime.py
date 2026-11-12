"""VOICE-AGENT-259: paid Realtime routing smoke test, text input/output only.

Eight sessions cover four personas in EN/FR, then return to a cinema question.
No cinema database is queried; this does not test ASR, audio or the browser.
An optional first argument saves the generated responses as JSON.
An optional second argument selects identity, style, sources or combined (default).
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.parse import quote
from websockets.asyncio.client import connect

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("about_rt_app", root / "app/main.py")
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
results = []


async def next_done(socket):
    async with asyncio.timeout(45):
        while True:
            event = json.loads(await socket.recv())
            if event["type"] == "error":
                raise RuntimeError("Realtime error code: " + str(event.get("error", {}).get("code")))
            if event["type"] == "response.done":
                return event["response"]


async def run(slug, language):
    config = m.realtime_session_config(soul=m.resolve_soul(slug), structured_card_focus=False)
    model = config["model"]
    config["output_modalities"] = ["text"]
    config["audio"]["input"]["turn_detection"] = None
    async with connect("wss://api.openai.com/v1/realtime?model=" + quote(model), additional_headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]}, max_size=8_000_000) as socket:
        await socket.send(json.dumps({"type": "session.update", "session": config}))
        async with asyncio.timeout(20):
            while True:
                event = json.loads(await socket.recv())
                if event["type"] == "error":
                    raise RuntimeError("Realtime configuration error code: " + str(event.get("error", {}).get("code")))
                if event["type"] == "session.updated":
                    break
        cases = {
            "identity": {"en": "Who are you?", "fr": "Qui es-tu ?"},
            "style": {"en": "How do you answer my questions?", "fr": "Comment réponds-tu à mes questions ?"},
            "sources": {"en": "What do you rely on to answer?", "fr": "Sur quoi t'appuies-tu pour répondre ?"},
            "combined": {"en": "In two sentences, tell me who you are, how you answer, and what you rely on.", "fr": "En deux phrases, dis-moi qui tu es, comment tu réponds et sur quoi tu t'appuies."},
        }
        case = sys.argv[2] if len(sys.argv) > 2 else "combined"
        question = cases[case][language]
        await socket.send(json.dumps({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": question}]}}))
        await socket.send(json.dumps({"type": "response.create"}))
        response = await next_done(socket)
        calls = [i for i in response.get("output", []) if i["type"] == "function_call"]
        row = {"soul": slug, "language": language, "case": case, "model": model, "selected_tools": [i["name"] for i in calls]}
        assert row["selected_tools"] == ["describe_agent"], row
        for call in calls:
            assert call["name"] == "describe_agent", row
            args = json.loads(call["arguments"])
            about = await m.agent_about(m.AgentAboutRequest(question=args["question"], topics=args.get("topics", []), soul=slug, ui_language=language))
            await socket.send(json.dumps({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": call["call_id"], "output": json.dumps({"response_kind": "agent-about", "soul": slug})}}))
            await socket.send(json.dumps({"type": "response.create", "response": {"instructions": about["instructions"], "tools": [], "tool_choice": "none", "metadata": {"purpose": "agent_about"}}}))
            response = await next_done(socket)
        row["text"] = " ".join(p.get("text", "") for i in response.get("output", []) if i.get("type") == "message" for p in i.get("content", []))
        film_question = "Montre-moi les films de Christopher Nolan." if language == "fr" else "Show me films directed by Christopher Nolan."
        await socket.send(json.dumps({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": film_question}]}}))
        await socket.send(json.dumps({"type": "response.create"}))
        followup = await next_done(socket)
        row["next_film_tools"] = [i["name"] for i in followup.get("output", []) if i["type"] == "function_call"]
        assert row["next_film_tools"] == ["query_text2sql"], row
        print(json.dumps(row, ensure_ascii=False), flush=True)
        results.append(row)


async def main():
    await asyncio.gather(*(run(s, language) for s in ("default", "video-store", "scholar", "chatterbox") for language in ("en", "fr")))
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


asyncio.run(main())
