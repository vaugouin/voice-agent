# Voice-layer bench (VOICE-AGENT-242)

The same ten spoken questions, played as one conversation, against four voice stacks. The point is to choose the app's voice layer from our own data, not from vendor benchmarks. Ticket: `Nestor/projets/t2s-backlog/repos/voice-agent.md`, VOICE-AGENT-242.

| Arm | Voice model | How tools run |
|---|---|---|
| `realtime` | `gpt-realtime-2.1` (the app today) | function calls in the Realtime session, the app's own session config |
| `live` | `gpt-live-1` | Responses delegation: a backend model (default `gpt-6-sol`, effort `low`) gets the app's instructions and tools; its function calls come back to the bench |
| `gemini-ext` | `gemini-3.8-live-extended-thinking` | async (`NON_BLOCKING`) function calls, no scheduling (the model refuses it) |
| `gemini` | `gemini-3.8-live` (cheap control) | async function calls, results scheduled `WHEN_IDLE` |

Every arm gets the same clips, the same tool definitions, the same executor (the app's own functions in `app/main.py`, calling the live `fastapi-text2sql` at `TEXT2SQL_BASE_URL`), and the same model-facing outputs (`compact_search_for_model`, `compact_detail_for_model`). The browser-only tools (`focus_result_card`, `play_trailer`, `read_based_on`) are stubbed. GPT-Live runs over its WebSocket, not WebRTC: no `aiortc` needed.

## 1. Record the ten clips

The questions are in `questions.json`. Record each one in your own voice, as you would say it to the app, in a quiet room, phone or headset microphone:

- one file per question: `bench/audio/q01.wav` ... `q10.wav` (any format ffmpeg reads works, keep the `.wav` name);
- start speaking within half a second and stop recording about one second after the last word;
- q09 is spoken over the agent's answer to q08 by the script: record it like the others;
- q07 is in French.

`bench/audio/` is ignored by git (your voice stays on the PC).

For a dry run before recording, `make_tts_audio.py` writes synthetic clips to `bench/audio-tts/`. They are far easier to transcribe than a real voice, so their results never count: the report keeps the two sets apart.

## 2. Before a run

- Switch the update processes off on the VPS, as for an evaluation campaign: `bash ~/docker/off-all.sh` (then `on-all.sh` after the LAST run).
- The bench asks the API with `retrieve_from_cache=false` and `store_to_cache=false` by default (`--api-cache off`), so every arm pays the full pipeline and the run order does not matter.
- Keys come from `voice-agent/.env` (`OPENAI_API_KEY`, `GEMINI_API_KEY`); for Gemini, `GOOGLE_API_KEY` from `../fastapi-text2sql/.env` is the fallback. Check in AI Studio that the Gemini key is on the paid tier: on the free tier Google may use the audio.

## 3. Run

From the repo root, one arm at a time, three runs each:

```bash
uv run --no-project --with-requirements bench/requirements.txt python bench/voice_bench.py --arm realtime --runs 3
uv run --no-project --with-requirements bench/requirements.txt python bench/voice_bench.py --arm live --runs 3
uv run --no-project --with-requirements bench/requirements.txt python bench/voice_bench.py --arm gemini-ext --runs 3
uv run --no-project --with-requirements bench/requirements.txt python bench/voice_bench.py --arm gemini --runs 3
```

A session lasts about six to nine minutes (the replies are "played" in real time). Useful options: `--only q05,q06`, `--audio-dir bench/audio-tts`, `--model` (for example `gpt-live-1.1` if it ships), `--backend-model gpt-6.1-terra --backend-effort none`, `--thinking-level high`, `--gemini-voice Charon`, `--voice marin`.

Each session writes `bench/results/<stamp>_<arm>_<audio>_run<n>/`: `events.jsonl` (every event, timestamped in ms from session start), `session.json` (models, voice, tools, versions) and `assistant.wav` (what the user would have heard, silences included: listen to it for the voice-quality score).

## 4. Report

```bash
uv run --no-project python bench/report.py                  # real clips
uv run --no-project python bench/report.py --audio audio-tts  # dry runs
```

It writes `results/report-<stamp>.md` and `.csv`, and appends to `results/scores.csv` one row per session and question for what a script cannot judge: whether the voice agrees with what the screen would show, and the voice quality (1 to 5), by ear from `assistant.wav`.

What it measures:

- **latency**: from the end of speech in the clip to the first voiced reply audio, as heard;
- **longest heard silence**: inside the reply, once it has started (the dead air during a tool call);
- **checks** from `questions.json`: right tool, no tool on the remark, one page only on the canon list, `ui_language`, and whether every search names its subject (a bare follow-up, a pronoun sent as is, or a question translated before the search fail it);
- **barge-in** (q09): when the interruption signal arrived, and how much reply audio played over the user;
- **cost per session**, from the providers' usage events and the list prices in `report.py` (noted 2026-10-28 from secondary sources, to re-check).

## How it measures, and its limits

- The microphone is simulated: the clip is streamed in real time in 40 ms frames, with silence between clips.
- The speaker is simulated: reply audio arrives faster than real time, so it is queued and played at real time; a silence counts only when the queue is empty and nothing voiced has arrived. GPT-Live streams silence continuously on its output, which is why chunks under an int16 peak of 400 count as silence.
- A turn ends when no tool is pending, the arm is not generating, the reply has finished playing, and nothing has arrived for 2.5 s (cap 120 s).
- On an interruption signal (Realtime `speech_started`, Gemini `interrupted`) the queued reply is dropped, as the app does. GPT-Live sends no such event over the WebSocket: its reply keeps playing over the user, which is measured, not hidden.
- The bench measures the voice layers against each other, not a phone session: no WebRTC, no echo, no browser compaction.
