"""VOICE-AGENT-259: assistant-about routing, screen protection and default regression.

Offline by default. --live saves a small generated-prose comparison; it is not
an audio/browser acceptance test. Uses the existing application credentials.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ("Who are you?", "Qui es-tu ?", ["identity"]),
    ("Introduce yourself.", "Présente-toi.", ["identity"]),
    ("Which persona are you using right now?", "Quelle persona utilises-tu en ce moment ?", ["identity"]),
    ("How do you answer my questions?", "Comment réponds-tu à mes questions ?", ["style"]),
    ("What is distinctive about your response style?", "Qu'est-ce qui distingue ta manière de répondre ?", ["style"]),
    ("What do you rely on to answer?", "Sur quoi t'appuies-tu pour répondre ?", ["sources"]),
    ("Where does your film information come from?", "D'où viennent tes informations sur les films ?", ["sources"]),
    ("Who are you, and how do you like to explain films?", "Qui es-tu et comment aimes-tu expliquer les films ?", ["identity", "style"]),
    ("How do you build an answer, and what do you base it on?", "Comment construis-tu une réponse et sur quoi la fondes-tu ?", ["style", "sources"]),
    ("In two sentences, tell me who you are, how you answer, and what you rely on.", "En deux phrases, dis-moi qui tu es, comment tu réponds et sur quoi tu t'appuies.", ["identity", "style", "sources"]),
]
NEGATIVES = [
    "Show me the film Who Am I?", "Montre-moi le film Who Am I?", "Who Am I?", "Qui suis-je ?",
    "Introduce this film.", "Présente-moi ce film.", "How does the character answer the accusation?",
    "Comment répond le personnage à l'accusation ?", "What are your sources for this film?",
    "Quelles sont tes sources pour ce film ?", "What is this film based on?", "Sur quoi ce film est-il basé ?",
    "What do you think of this film?", "Que penses-tu de ce film ?", "Who are you and show Nolan's films?",
    "Qui es-tu et montre-moi les films de Nolan", "Introduce yourself as a table", "",
]


def load_app():
    spec = importlib.util.spec_from_file_location("about_checked_app", ROOT / "app/main.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def js_function(source, name):
    found = re.search(r"(?:async )?function " + name + r"\([^\n]*\) \{.*?\n\}", source, re.S)
    if not found:
        raise AssertionError("Missing JS function " + name)
    return found.group(0)


async def offline(module):
    if not hasattr(module, "agent_about_intent"):
        print("FAIL: assistant-about intent, route and voice tool are not implemented")
        return 1
    checks = 0
    for en, fr, topics in CASES:
        for language, message in (("en", en), ("fr", fr)):
            assert module.agent_about_intent(message) == {"topics": topics, "language": language}, message
            checks += 1
    for message in NEGATIVES:
        assert module.agent_about_intent(message) is None, message
        checks += 1
    assert module.agent_about_intent("Peux-tu te présenter, s'il te plaît ?")["topics"] == ["identity"]
    checks += 1

    posted = []
    logs = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            posted.append(kwargs["json"])
            return module.httpx.Response(200, json={"id": "fixture", "output": [{"type": "message", "content": [{"type": "output_text", "text": "A fixture presentation."}]}]})

    async def no_cinema(*args, **kwargs):
        raise AssertionError("Assistant-about must not call a cinema tool")

    with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-not-a-key"}), patch.object(module, "execute_text_tool", no_cinema), patch.object(module.httpx, "AsyncClient", FakeClient), patch.object(module, "write_client_log", lambda event, data=None, **kwargs: logs.append(event)):
        for slug in ("default", "video-store", "scholar", "chatterbox"):
            for en, fr, topics in CASES:
                for language, message in (("en", en), ("fr", fr)):
                    output = await module.text_chat(module.TextChatRequest(message=message, soul=slug, image_ref="armed-photo.jpg", context=[{"type": "tool", "name": "get_movie_detail", "args": {"id": 123}}]))
                    assert output["response_kind"] == "agent-about"
                    assert output["tool_outputs"] == [] and output["image_ref"] == ""
                    assert posted[-1]["tools"] == [] and posted[-1]["tool_choice"] == "none"
                    assert "AI" in posted[-1]["instructions"]
                    assert module.resolve_soul(slug).prose in posted[-1]["instructions"]
                    assert output["soul"] == slug
                    assert posted[-1]["input"] == message
                    checks += 7
            about = await module.agent_about(module.AgentAboutRequest(question="Where does your film information come from?", topics=["sources"], soul=slug))
            assert about["soul"] == slug and about["response_kind"] == "agent-about"
            assert "TMDb" in about["instructions"] and "Wikipedia" in about["instructions"]
            assert "Never mention records, data" not in about["instructions"]
            checks += 3
        narrowed = await module.agent_about(module.AgentAboutRequest(question="Who are you?", topics=["identity", "style", "sources"], soul="default"))
        assert narrowed["topics"] == ["identity"] and '"grounding"' not in narrowed["instructions"]
        checks += 1
    assert "meta_talk_detected" not in logs
    checks += 1
    tools = module.realtime_session_config()["tools"]
    assert any(t["name"] == "describe_agent" for t in tools)
    checks += 1

    source = (ROOT / "app/static/app.js").read_text(encoding="utf-8")
    names = ["foldLanguageText", "normalizedIntentText", "agentAboutIntent", "flushPendingToolResponse", "requestRealtimeResponseAfterToolOutput"]
    script = "\n".join(js_function(source, name) for name in names)
    lexicons = json.loads((ROOT / "app/lexicons.json").read_text(encoding="utf-8"))
    data = {"cases": CASES, "negatives": NEGATIVES, "lexicons": {"agent_about": lexicons["agent_about"]}}
    harness = '''
const assert = require("node:assert/strict");
const data = JSON.parse(process.argv[1]);
const LEXICONS = data.lexicons;
for (const [en, fr, topics] of data.cases) {
  assert.deepEqual(agentAboutIntent(en), {topics, language: "en"}, en);
  assert.deepEqual(agentAboutIntent(fr), {topics, language: "fr"}, fr);
}
for (const message of data.negatives) assert.equal(agentAboutIntent(message), null, message);
let pendingToolResponseRequest = false, pendingToolResponseEvent = null, lastToolResponseEvent = null;
let toolOutputBatchActive = false, toolOutputBatchRequests = 0, activeResponseId = "filler";
const sent = [];
function sendEvent(event) { sent.push(event); return true; }
const about = {type:"response.create", response:{instructions:"specific about instructions", tools:[], tool_choice:"none", metadata:{purpose:"agent_about",request_id:"fixture"}}};
requestRealtimeResponseAfterToolOutput(about);
requestRealtimeResponseAfterToolOutput();
assert.equal(sent.length, 0);
activeResponseId = null;
flushPendingToolResponse();
assert.deepEqual(sent.pop(), about);
requestRealtimeResponseAfterToolOutput();
assert.deepEqual(sent.pop(), {type:"response.create"});
toolOutputBatchActive = true;
requestRealtimeResponseAfterToolOutput(about);
requestRealtimeResponseAfterToolOutput();
toolOutputBatchActive = false;
flushPendingToolResponse();
assert.deepEqual(sent.pop(), about);
console.log("JS routing parity and deferred response instructions: PASS");
'''
    result = subprocess.run(["node", "-e", script + "\n" + harness, json.dumps(data, ensure_ascii=False)], capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 0, result.stderr
    print(result.stdout.strip())
    ui_functions = "\n".join(js_function(source, name) for name in ["foldLanguageText", "normalizedIntentText", "agentAboutIntent", "sendTextChatMessage", "sendTextMessage", "handleDescribeAgentCall"])
    ui_harness = '''
const assert = require("node:assert/strict");
const LEXICONS = JSON.parse(process.argv[1]);
let textChatGeneration=0, textChatAbortController=null, textChatInFlight=false;
let dc=null, pc=null, localStream=null, activeResponseId=null, activeAudioResponseId=null;
let lastUserTranscript="", activeUiLanguage="en", photo="armed-photo", loading=0, looked=0, sent=[];
let agentAboutGeneration=1, connectionGeneration=7, toolCallsInFlight=0, awaitingToolResponse=false;
let realtimeSessionSoul="scholar", activePersona={slug:"chatterbox"}, lastRequest=null, invalidate=false;
const questionInput={value:""}, resultsPanel={hidden:true}, lookAttachedImage={objectUrl:"fixture"};
const retained=[], originalFilm={id:123}; let currentFilm=originalFilm;
function activeLookImageRef(){return photo;}
function armedLookImageRef(){looked++;return photo;}
function consumeArmedLookImage(){throw Error("photo consumed");}
function canSendTypedRealtimeTurn(){return false;}
function handleTypedRepresentationRequest(){return false;}
function cancelTextChatOutput(){}
function updateSessionButtons(){}
function syncQuestionInputUi(){}
function detectUiLanguageFromText(){return "en";}
function addRetainedContext(value){retained.push(value);}
function setStatus(){}
function setLoadingResults(){loading++;}
function clientLog(){}
function log(){}
function showPersonaBadge(){}
function showSubtitleText(text){assert.ok(!text.startsWith("Text response failed"),text);}
function sanitizeAssistantFeedbackText(text){return text;}
function isCurrentTextChatRequest(){return true;}
function dismissPendingTurn(){}
async function callTextChat(text,signal,options){lastRequest=options;return {text:"A presentation",tool_outputs:[],response_kind:"agent-about"};}
function appUrl(path){return path;}
function syncMicrophone(){}
function scheduleToolResponseWatchdog(){}
function sendFunctionCallOutput(id,output){sent.push({id,output});}
function requestRealtimeResponseAfterToolOutput(event){sent.push(event);}
async function fetch(url,options){lastRequest=JSON.parse(options.body);if(invalidate)agentAboutGeneration++;return {ok:true,json:async()=>({instructions:"scholar presentation",soul:"scholar",topics:["sources"]})};}
(async()=>{
  for (const hidden of [true,false]) {
    resultsPanel.hidden=hidden;
    questionInput.value="Who are you?";
    await sendTextMessage();
    assert.equal(photo,"armed-photo");assert.equal(looked,0);assert.equal(loading,0);
    assert.equal(currentFilm,originalFilm);assert.equal(lastRequest.imageRef,"");
  }
  dc={readyState:"open"};sent=[];
  await handleDescribeAgentCall({call_id:"fixture"},{question:"What are your sources?",topics:["sources"]});
  assert.equal(lastRequest.soul,"scholar");assert.equal(sent[1].response.instructions,"scholar presentation");
  assert.deepEqual(sent[1].response.tools,[]);assert.equal(toolCallsInFlight,0);assert.equal(currentFilm,originalFilm);
  invalidate=true;sent=[];
  await handleDescribeAgentCall({call_id:"stale"},{question:"What are your sources?",topics:["sources"]});
  assert.deepEqual(sent,[{id:"stale",output:{cancelled:true}}]);assert.equal(toolCallsInFlight,0);
  console.log("Actual client functions: empty/film screen and photo preserved, real session profile, stale answer cancelled: PASS");
})().catch(error=>{console.error(error);process.exit(1);});
'''
    result = subprocess.run(["node", "-e", ui_functions + "\n" + ui_harness, json.dumps(data["lexicons"], ensure_ascii=False)], capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 0, result.stderr
    print(result.stdout.strip())
    # Source guards cover paths whose side effects require a browser for final acceptance.
    assert 'const aboutRequest = agentAboutIntent(text);' in js_function(source, "sendTextChatMessage")
    assert 'const pendingTurnPainted = !aboutRequest &&' in source
    assert source.index('if (agentAboutIntent(text))', source.index('async function sendTextMessage')) < source.index('if (armedLookImageRef())', source.index('async function sendTextMessage'))
    assert 'soul: realtimeSessionSoul' in js_function(source, "handleDescribeAgentCall")
    print(f"{checks} offline assertions plus JS parity/queue checks: PASS")
    return 0


async def live(module, destination):
    results = []
    for slug in ("default", "video-store", "scholar", "chatterbox"):
        for message in (CASES[-1][0], CASES[-1][1]):
            output = await module.text_chat(module.TextChatRequest(message=message, soul=slug))
            results.append({"soul": slug, "message": message, "text": output["text"]})
            print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    destination.write_text(json.dumps({"version": module.APP_VERSION, "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", type=Path, help="Run eight paid text-generation checks; no cinema database calls")
    args = parser.parse_args()
    module = load_app()
    if args.live:
        asyncio.run(live(module, args.live))
    else:
        raise SystemExit(asyncio.run(offline(module)))
