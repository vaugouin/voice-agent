# bench/

Voice-layer bench of VOICE-AGENT-242: the same ten recorded questions against `gpt-realtime-2.1`, GPT-Live-1 (Responses delegation) and Gemini 3.8 Live (Extended Thinking and base). Usage and method: `README.md` in this folder. Not part of the app image (the `Dockerfile` copies `app/` only).

- `voice_bench.py` imports `app.main` and reuses its session config, tool definitions and tool executor: a change to those in the app changes what the bench measures. Record the app `VERSION` (it is written to `session.json`) when comparing runs.
- Its dependencies are in `bench/requirements.txt`, unpinned and separate from the app's: `google-genai` needs `httpx>=0.28.1`, the app pins 0.27.2. Always run it with `uv run --no-project --with-requirements bench/requirements.txt`.
- `audio/`, `audio-tts/` and `results/` are ignored by git: `audio/` is Philippe's voice, `results/` holds transcripts and session audio. The conclusions go into the ticket, not into the repo.
- Every run spends API credit on four providers' accounts (OpenAI voice and backend, Gemini, the text2sql pipeline). Ask before launching a full campaign; a dry run on two questions (`--only q01,q02 --audio-dir bench/audio-tts`) is enough to test a change.
- Known API facts found while building it (2026-10-28): GPT-Live accepts a WebSocket at `wss://api.openai.com/v1/live/sessions` (openai SDK 3.40, `client.live.connect()`), streams silence continuously on its output, and gives function calls of a Responses delegation inside `response.event`; the result goes back with `response.item.create` then `response.create`. Gemini 3.8 Live Extended Thinking closes the socket (1007) if a function response carries `scheduling`.
