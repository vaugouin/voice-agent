# Agent Instructions

This file is for agent-facing operating context only. Do not use it as a second README.

## Related repositories (project ecosystem)

`voice-agent` is one stage of **Agent BBB**, a multi-repository movie/TV database system owned by GitHub user `vaugouin`. All sibling repos live under `%USERPROFILE%/Code/<repo>` and at `github.com/vaugouin/<repo>`; they are interdependent stages of one pipeline that converges on a shared MySQL/MariaDB database (`T_WC_*` tables) and a ChromaDB vector store. The canonical roster of sibling repositories is kept in `%USERPROFILE%/Nestor/projets/t2s-backlog/topics/related-repositories.txt` (documentation repo `Nestor`, outside `Code/`).

Pipeline stages:
- **Infrastructure** — `chromadb` (vector service), `reverseproxy` (NGINX TLS ingress), `chromadb-security-test` (firewall validation), `tools` (host-side operational scripts for the shared MariaDB: backups per perimeter, one-off `.sql` runs; **private repo**, it documents where the database lives and how it is restored).
- **Acquisition** — `tmdb-crawler`, `imdb-crawler`, `sparql-crawler`, `sparql-movies-persons`, `wikidata-crawler`, `wikipedia-crawler`, `selenium-tmdb`, `download-images`, `sqlite-plex-to-tmdb`, `movieparadise`, `open-credits` (crowdsourced OCR of on-screen credits into `T_WC_OC_*`).
- **Preprocessing → `T_WC_T2S_*`** — `tmdb-movie-preprocess`, `tmdb-person-preprocess`, `keywords-processing`.
- **Semantic index & name resolution** — `embedding-update`, `embedding-query`, `rapidfuzz_query`.
- **Serving** — `fastapi-text2sql` (NL→SQL API + MCP server), `voice-agent`, `tmdb-front` (PHP web front-end).
- **Evaluation** — `text2sql-eval`, `extract-movie-questions`.
- **Maintenance & tooling** — `plex-duplicates`, `subtitle-translate`, `powershell`, `playwright-test`, `manual-refresh` (one-entity TMDb + Wikipedia refresh console, formerly `python`).
- **Monitoring & observability** — `data-monitoring`, `pipeline-3d` (three.js replay of one question's execution trace through `voice-agent` and `fastapi-text2sql`).

**This repository's role:** Serving stage. A web-based voice and chat client that proxies natural-language queries to the `fastapi-text2sql` API (search plus per-entity detail tools), acting as a conversational front-end alongside `tmdb-front`.

---

## Documentation Boundaries

- `README.md` is the source of truth for overview, features, setup, deployment, environment variables, persona (soul) files, diagnostics, troubleshooting and verification commands. `UI.md` is the source of truth for stateful UI behavior. `cinema/README.md` is the cinema-mode contract.
- Keep this file to agent workflow and safety context; do not duplicate README or UI state tables here.
- For any project update, keep documentation aligned: `README.md` for user-facing behavior, configuration, deployment or verification; `UI.md` for UI state, visibility, controls or interaction (document the state transition, not just the visual result).

## First Checks For Any Task

- Run `git status --short` before editing. This workspace commonly has existing uncommitted changes; preserve them unless the user explicitly asks to revert them.
- Read the smallest relevant files first. Most work lands in `app/main.py` (routes, Realtime session config, text-chat flow, tool adapters) or `app/static/app.js` (WebRTC lifecycle, Realtime events, rendering, retained context, reconnect, UI state). Many traps below are explained in block comments in those files, tagged with their ticket (`VOICE-AGENT-NNN`): read the comment before changing the code it heads.
- `bench/` (VOICE-AGENT-242, not shipped) imports `app.main` and reuses `realtime_session_config`, the tool definitions and the tool executor, so changing those changes what it measures. Read `bench/AGENTS.md` before touching it.
- For anything touching the text2SQL API (endpoints, tool behavior, response shapes), read `C:\Users\vaugo\Code\fastapi-text2sql\README.md` first: it is the source of truth for endpoints, entity IDs, response fields and embedded relations.
- If you alter Realtime session shapes, tool schemas, model configuration, or OpenAI API usage, check current official OpenAI docs before assuming API details.

## App version (single source of truth — BUMP ON EVERY UPDATE)

- `VERSION` at the repo root is the one app version and the browser cache key (README § App version & cache busting). Bump it in the same change as every commit, frontend, backend or docs. Never add a `?v=` slug in `index.html`; keep its `__APP_VERSION__` placeholders.
- Bump PATCH by default, without asking. For MINOR (new user-facing feature) or MAJOR (breaking change or large overhaul), propose the bump and get Philippe's confirmation first. You own the digit resets.
- If you move `VERSION`, update both the `Dockerfile` (`COPY VERSION .`) and `_read_app_version()`.

## Editing Rules Specific To This App

- **Hidden screens:** an `#id` rule that sets `display` outranks the shared `[hidden] { display: none }` rule. Always scope screen-specific styles with `:not([hidden])` (regression of 2026-07-04: About credits leaked onto the menu index).
- **Soul files:** `souls/_core.md` holds the rules every persona must keep; persona files (`SOUL.md`, `souls/<slug>.md`) carry character only and never restate, soften or override a core rule, and neither holds operational instructions (tool routing, id-hiding, recovery). Any non-persona file in `souls/` must start with `_`, or it becomes a selectable persona. One character is one file (prose, `voice:`, avatar description).
- **Shared behavior spans two languages** (voice in `app.js`, text in `main.py`). Word lists are single-sourced in `app/lexicons.json` (VOICE-AGENT-126): edit them there only, never re-hardcode a list in `app.js` or `main.py`. The detection and normalization functions are parallel copies (`detectUiLanguageFromText` / `relevantSectionKeywords` in JS, `detect_ui_language_from_text` / `_relevant_section_keywords` in Python): a change to the algorithm must be applied to both (VOICE-AGENT-112 broke text mode by fixing only voice).
- Preserve the text/audio split unless asked: audio uses the Realtime WebRTC path, typed text posts to `/text-chat`.
- **Look (picture) path** (block comment at the head of the Look section of `app.js`):
  - The Look button is an action, not a toggle; keep its legacy names (`#lookToggleButton`, `look_*` events) and add a source as a line in `LOOK_MENU_ITEMS`, never a hardcoded button.
  - An image never travels on the WebRTC data channel, and the Realtime model never sees the picture (VOICE-AGENT-044 guardrail).
  - `image_ref` stays out of every tool schema; our code passes it beside the model's arguments, never inside them (a re-query would pay for another reading).
  - Do not quieten `look_session_guard`, and keep `evidence_steps` in the log.
  - A voice follow-up carries no `image_ref`, unlike the text path which re-sends it: do not harmonise the two (VOICE-AGENT-179).
  - Attaching a photo asks nothing; `consumeArmedLookImage()` spends it before the search, never after the `await` (VOICE-AGENT-183).
  - The drop listeners stay registered at load (without them the browser replaces the page and the conversation is lost); every way in goes through `handleLookFile()`.
  - Picture instructions live in Python only (`VISION_*_INSTRUCTIONS`); never copy that prose into JS.
  - Never write image bytes into `logs/`; the reference makes a turn replayable.
- **Failed searches** (VOICE-AGENT-142, -185, -186): `searchFailedWithNothingToShow()` guards both modes, and the voice path must read `hadContent` before `setLoadingResults()` unhides the panel. The picture turn is deliberately unguarded. The waiting screen lives in `#resultsContent`, never in a modal. The engine's error string never reaches the answer block; it goes to the query details and the log.
- **A follow-up that names no entity goes to the detail tool, never to the search** (`FOLLOW_UP_ROUTING_INSTRUCTIONS`). Do not add cast words to `background_detail_topic_words` instead: that gate would hijack genuine new searches.
- **`play_trailer` returns its output without a response request on success** (VOICE-AGENT-207), so the model stays silent over the video; the microphone is shut by `videoModalOpen` in `canEnableMicrophone()`, never by toggling `userMicrophoneOpen`. `read_based_on`, by contrast, does request a response.
- **Source works** (VOICE-AGENT-218): `isSourceWorkRecord()` is tested before the movie and series branches; a source that names `ID_MOVIE` / `ID_SERIE` opens that title's sheet. `compactDetailForModel` drops the `adapted_movies` / `adapted_series` rails (data-channel size).
- A new image builder with a Wikipedia fallback must call `fitWikipediaImage()` (VOICE-AGENT-234).
- **Result representations are shared with tmdb-front** (rule set by Philippe, 2026-10-31). The dispatch on the API hint (`representation`, `result_kind`, `result_columns`; `chooseText2SqlRepresentation()` and its renderers) is mirrored in tmdb-front (`lib/t2s-representation.inc.php`, called by `lib/text2sql-search.inc.php` on the search page `html/tmdb/index.php`; TMDB-FRONT-112). Any new or changed representation, unit format or fallback ships on both fronts in the same batch, with a twin ticket in the other repo.
- State sources of truth: `resultsPanel.hidden` (drives compact result mode), `updateSessionButtons()` (Start/Stop), `setStatus()` (status text and dot), `renderText2SqlResult()` / `renderEntityDetailOutput()` (rendering boundaries).

## UI And Browser Verification

- After meaningful frontend changes, verify in a browser at `http://127.0.0.1:3000/`, not only by reading code; a computed-style or DOM check is often enough for DOM-only work.
- For iOS landscape or viewport-sensitive layout, verify a `932x430` viewport (iPhone 15 Pro Max landscape) and the relevant media query.
- For result/detail rendering changes, exercise the state that makes `#resultsPanel` visible so compact mode is covered.

## Runtime And State Pitfalls

- There is no visible voice selector; voice is server-side (`AGENT_VOICE`, `?voice=`) and only lands on a new session. Re-check the DOM and README before changing voice behavior.
- `clearConversationUi()` does not clear the subtitle timer; if you change reset behavior, decide about subtitles and document it in `UI.md`. `stop()` keeps results and retained context; `startNewConversation()` is the full reset.
- Reconnect and keepalive logic is deliberately conservative (README § Connection Resilience): do not tear down self-healed connections, and be careful with the Worker fallback, data-channel no-op sends, visibility/focus keepalives and reconnect timers.
- The text input remains enabled in all states; if that changes, update the code and `UI.md`.
- **One clock for the T2S stack** (DEPLOYMENT-015, VOICE-AGENT-226): human-read dates are written in Europe/Paris with their offset, always through `ZoneInfo`, never a fixed `+02:00`, and never by setting `TZ` in the container. Log readers must parse each line's offset (README § Diagnostics).
- **Config precedence** (VOICE-AGENT-176): never switch to `load_dotenv(override=True)`; it would silently disable the launcher overrides and `docker run -e`.

## Verification Discipline

- Run the relevant checks from README § Verification after code changes; at minimum compile-check touched Python and syntax-check touched JavaScript, with a browser smoke test when behavior changes.
- For documentation-only changes, check the diff for accidental README/AGENTS/UI duplication.

## Build & deployment (Docker)

See README § Docker Build and Run and the `Dockerfile`. Pass secrets at runtime (env vars or an env file); never bake them into the image. The `Dockerfile` must keep copying `VERSION`, `SOUL.md` and `souls/` (missing soul files fail silently: the agent runs persona-less).

## Cinema mode: scripted two-voice episodes (VOICE-AGENT-235, APP-IDEAS-010)

Contract and build: `cinema/README.md`; player behavior: `UI.md`. Rules:

- A fact line is checked against the sheets and the subtitles before it ships; the generator may rewrite performance lines, never a fact line without re-checking its source.
- Keep the episode mp3 constant bitrate, and the cue scheduler on the `<audio>` clock, never `Date.now()`.
- Frames and audio under `cinema/assets/` are built, not committed (film frames must not land in the public repo).

## Backlog (Nestor second-brain)

The backlog lives in the separate **Nestor** repo: `C:\Users\vaugo\Nestor\projets\t2s-backlog\repos\voice-agent.md` (tasks `VOICE-AGENT-NNN`), cross-repo dashboard `...\t2s-backlog\index.md`. Consult it before implementing. These local paths do not resolve on the VPS or on cloud agents.
