# Realtime 2 WebRTC Voice Text2SQL Agent

Small FastAPI web app that connects a browser microphone to the OpenAI Realtime API with WebRTC, uses `OPENAI_REALTIME_MODEL` for spoken interaction, and forwards cinema/TV database questions to a FastAPI/FastMCP text2sql API.

The app serves a minimal web UI on port `3000`. The browser creates an `RTCPeerConnection`, sends microphone audio to the model, plays model audio output, and opens an `oai-events` data channel for Realtime events and function calls.

## Features

- OpenAI Realtime WebRTC call setup with `OPENAI_REALTIME_MODEL`, defaulting to `gpt-realtime-2`.
- Server-side `/session` endpoint using `OPENAI_API_KEY`.
- Multipart call creation against `https://api.openai.com/v1/realtime/calls` with string fields named `sdp` and `session`.
- Browser microphone input and model audio output through `RTCPeerConnection`.
- `oai-events` data channel for Realtime event handling.
- Function tools named `query_text2sql` plus dedicated entity detail tools.
- Text2sql result cards with infinite-scroll pagination and click-through entity detail pages.
- Compact result-display mode that hides the app title and agent status while search results or entity pages are visible, leaving a one-row control header above the results panel.
- Edge-to-edge iOS landscape layout for short viewports, including `viewport-fit=cover`, so the result UI uses the full available screen height without an outer app margin.
- Text question input beside Start/Stop for mixed voice/text turns. `Enter` submits and `Shift+Enter` inserts a new line.
- Back and Forward buttons beside the text input for navigating previously displayed result and detail pages.
- PNG app icon configured for browser tabs, web app metadata, and iPhone Add to Home Screen.
- Server-side Realtime voice selection through `AGENT_VOICE`.
- Burger menu with Settings and About screens, subtitle URL override controls, reserved language/voice slots, and full About credits/attribution (publisher, data sources, powered-by row, OpenAI Realtime, and TMDb/IMDb/Wikipedia/Wikidata legal notices).
- Cold-load splash screen with a localized hook line, the `Voice Movie Database` title, skip support, and a handoff into the launch showcase.
- Rolling retained context in `localStorage` so reconnects can continue with prior user requests and tool results during the current page lifetime.
- Web Worker keepalive on the `oai-events` data channel to keep ICE/NAT alive during silent periods, including in unfocused windows.
- Disconnect watchdog with self-heal check that avoids tearing down sessions that recover on their own.
- Multi-attempt reconnect (up to 5) that resumes from retained context.
- New conversation button that clears the screen and retained context, and stops any current spoken or text answer.
- Interruptible assistant speech with the microphone kept open while audio is playing.
- Client diagnostics written to `logs/client.log`.
- Docker deployment support behind Nginx at `/voice-agent/`.

## Project Layout

```text
app/
  main.py                 FastAPI app, Realtime session endpoint, text2sql proxy
  static/
    index.html            Minimal UI
    app.js                WebRTC client, Realtime event loop, tool handling
    styles.css            UI and result-card styling
UI.md                     Stateful UI behavior reference
AGENTS.md                 Agent-facing repository instructions
deploy/
  nginx-voice-agent-location.conf
logs/
  client.log              Browser/client diagnostics
Dockerfile
.dockerignore
.gitignore
.env.example
requirements.txt
```

## Environment

Create `.env` from `.env.example`:

```text
OPENAI_API_KEY=sk-your-key-here
OPENAI_TEXT_MODEL=gpt-5.1
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
ENABLE_STRUCTURED_CARD_FOCUS=true
ENABLE_SPOKEN_SUBTITLES=false
ENABLE_USER_TRANSCRIPT_SUBTITLES=false

TEXT2SQL_BASE_URL=http://your_host:8000
TEXT2SQL_API_KEY_NAME=X-API-Key
TEXT2SQL_API_KEY_VALUE=your_api_key_value
TEXT2SQL_ROWS_PER_PAGE=50
```

Do not bake `.env` into the Docker image or commit it to git. `.dockerignore` and `.gitignore` exclude local secrets and runtime logs. Provide secrets at runtime with `--env-file`.

## Local Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env`, then run:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

For microphone testing, Chrome or Edge on localhost is usually the most reliable local browser path.

Apple Watch browsers do not expose the same browser microphone/WebRTC capture path required by the voice Start button. On watchOS, use typed questions in the text box, or use voice from iPhone Safari.

## Realtime Session Flow

1. The browser asks for microphone access with `navigator.mediaDevices.getUserMedia`.
2. The browser creates an `RTCPeerConnection`.
3. The microphone track is added to the peer connection.
4. The browser creates an SDP offer.
5. The browser posts the SDP offer to local `/session`.
6. FastAPI posts multipart form data to OpenAI:

```text
POST https://api.openai.com/v1/realtime/calls
Authorization: Bearer $OPENAI_API_KEY
Content-Type: multipart/form-data; boundary=...

field: sdp      browser SDP offer as text
field: session  JSON Realtime session config as text
```

7. OpenAI returns an SDP answer.
8. The browser sets the SDP answer as the remote description.
9. Realtime events and tool calls are exchanged over the `oai-events` data channel.

## Agent Harness

This app is an agent harness: it keeps a conversational model session alive, lets the model choose tools, executes those tools outside the model, feeds tool outputs back into the same conversation, and preserves compact context across WebRTC reconnects.

The harness is split across the FastAPI backend and the browser client.

Server-side harness:

- `app/main.py::realtime_session_config()` creates the Realtime session definition: model, instructions, audio input/output settings, turn detection, tools, and `tool_choice`.
- `app/main.py::detail_tool_definitions()` creates the dedicated entity detail tool schemas from `DETAIL_ENTITY_CONFIG`.
- `POST /session` receives the browser SDP offer, combines it with the Realtime session config, calls `https://api.openai.com/v1/realtime/calls`, and returns the OpenAI SDP answer.
- `POST /tool/text2sql` adapts `query_text2sql` tool calls to the upstream text2sql API.
- `GET /tool/detail/{entity}/{id}?ui_language=...` adapts dedicated detail tool calls to the upstream entity detail API.

Browser-side harness:

- `app/static/app.js::start()` creates the `RTCPeerConnection`, captures microphone audio, creates the `oai-events` data channel, attaches remote model audio, sends the SDP offer to `/session`, and installs reconnect handlers.
- `app/static/app.js::handleServerEvent()` is the Realtime event loop. It tracks speech commits, transcripts, active responses, audio playback, response completion, errors, and function-call outputs.
- `app/static/app.js::handleFunctionCall()` is the tool-dispatch loop. It deduplicates `call_id`, parses model arguments, calls the local tool adapter, renders the result in the UI, stores compact tool context, sends `function_call_output` back to Realtime, and asks the model to continue with `response.create`.
- `app/static/app.js::sendEvent()` is the shared primitive for sending Realtime client events over the data channel.
- `app/static/app.js::addRetainedContext()`, `retainedContextText()`, and `seedRetainedContext()` maintain the compact context replay used after reconnects.

In other words, the model does the planning and tool selection, while the browser owns the Realtime control loop and the FastAPI server owns privileged network calls and API keys.

## Realtime Session Config

The server creates a session with:

- model: `OPENAI_REALTIME_MODEL`, default `gpt-realtime-2`
- voice: selected server-side by `AGENT_VOICE`, default `ash`
- input transcription: `gpt-4o-transcribe`
- turn detection: server VAD
- tools: `query_text2sql` plus dedicated detail tools for movies, series, seasons, episodes, persons, companies, networks, collections, topics, lists, movements, technicals, genres, groups, deaths, awards, nominations, and locations
- optional spoken-card focus tool: `focus_result_card`, enabled by default with `ENABLE_STRUCTURED_CARD_FOCUS=true`

Supported voice values in this app:

```text
alloy
ash
ballad
coral
echo
sage
shimmer
verse
marin
cedar
```

The voice is configured server-side with the `.env` `AGENT_VOICE` value. The server validates it before inserting it into `audio.output.voice`.

Important: Realtime voice selection must happen before the session produces audio. Change `AGENT_VOICE`, then start a new session.

## Text2SQL Tool Flow

The model can call:

```json
{
  "name": "query_text2sql",
  "arguments": {
    "query": "List movies directed by Francois Truffaut",
    "ui_language": "en"
  }
}
```

The browser receives the function call on `oai-events`, then posts to:

```text
POST /tool/text2sql
```

If `ui_language` is missing or stale, the browser and server derive it from the latest user input: French speech transcripts and French typed text send `fr`; English and every other language send `en`. The same detected value is reused for follow-up detail calls unless a new user turn changes the conversation language.

The FastAPI adapter posts to `{TEXT2SQL_BASE_URL}/search/text2sql` with:

```json
{
  "question": "List movies directed by Francois Truffaut",
  "ui_language": "en",
  "page": 1,
  "rows_per_page": 50,
  "retrieve_from_cache": true,
  "store_to_cache": true,
  "complex_question_processing": false
}
```

If the next page is requested, the adapter can send:

```json
{
  "question": "List movies directed by Francois Truffaut",
  "question_hashed": "<hash from previous response>",
  "ui_language": "en",
  "page": 2,
  "rows_per_page": 50,
  "retrieve_from_cache": true,
  "store_to_cache": true,
  "complex_question_processing": false
}
```

The hash is an optimistic cache pointer for pagination. The adapter still sends the
original `question` with it so an upstream cache miss can fall back to normal
text-to-SQL processing instead of surfacing as an error.

Authentication is configured by:

```text
TEXT2SQL_BASE_URL=http://www.vaugouin.com:8186
TEXT2SQL_API_KEY_NAME=X-API-Key
TEXT2SQL_API_KEY_VALUE=...
```

## Detail Tool Flow

When the model needs detail fields for a specific entity, it can call a dedicated detail tool. The browser receives the Realtime function call and proxies it through:

```text
GET /tool/detail/{entity}/{id}?ui_language=en
```

For browser-managed embedded-relation pagination, the same local detail routes also accept `collection`, `page`, and `rows_per_page`, for example `GET /tool/detail/person/31?ui_language=en&collection=movie_cast&page=2`. These query parameters are forwarded to the upstream entity endpoint and are used by the UI rail controls; the model-facing detail tools remain limited to entity identifiers plus `ui_language`.

The local adapter forwards to the text2sql API detail endpoints documented in `C:\Users\vaugo\Code\fastapi-text2sql\README.md`:

| Realtime tool | Upstream endpoint | ID |
|---|---|---|
| `get_movie_detail` | `GET /movies/{id}?ui_language=...` | `ID_MOVIE` |
| `get_series_detail` | `GET /series/{id}?ui_language=...` | `ID_SERIE` |
| `get_season_detail` | `GET /seasons/{id_serie}/{season_number}?ui_language=...` | `ID_SERIE`, `SEASON_NUMBER` |
| `get_episode_detail` | `GET /episodes/{id_serie}/{season_number}/{episode_number}?ui_language=...` | `ID_SERIE`, `SEASON_NUMBER`, `EPISODE_NUMBER` |
| `get_person_detail` | `GET /persons/{id}?ui_language=...` | `ID_PERSON` |
| `get_company_detail` | `GET /companies/{id}?ui_language=...` | `ID_COMPANY` |
| `get_network_detail` | `GET /networks/{id}?ui_language=...` | `ID_NETWORK` |
| `get_collection_detail` | `GET /collections/{id}?ui_language=...` | `ID_T2S_COLLECTION` |
| `get_topic_detail` | `GET /topics/{id}?ui_language=...` | `ID_TOPIC` |
| `get_list_detail` | `GET /lists/{id}?ui_language=...` | `ID_T2S_LIST` |
| `get_movement_detail` | `GET /movements/{id}?ui_language=...` | `ID_MOVEMENT` |
| `get_technical_detail` | `GET /technicals/{id}?ui_language=...` | `ID_TECHNICAL` |
| `get_genre_detail` | `GET /genres/{id}?ui_language=...` | `ID_GENRE` |
| `get_group_detail` | `GET /groups/{id}?ui_language=...` | `ID_GROUP` |
| `get_death_detail` | `GET /deaths/{id}?ui_language=...` | `ID_DEATH` |
| `get_award_detail` | `GET /awards/{id}?ui_language=...` | `ID_AWARD` |
| `get_nomination_detail` | `GET /nominations/{id}?ui_language=...` | `ID_NOMINATION` |
| `get_location_detail` | `GET /locations/{wikidata_id}?ui_language=...` | `ID_WIKIDATA`, for example `Q90` |

The adapter normalizes `ui_language` to `en` or `fr` and forwards it to detail endpoints. For Realtime audio, typed Realtime turns, `/text-chat`, and idle dictation, the app detects French from the user's latest transcript or typed message and sends `fr`; unsupported languages and English send `en`. Localized detail responses are collapsed under canonical field names such as `MOVIE_TITLE`, `LIST_NAME`, `DESCRIPTION`, and `ITEM_LABEL`; separate `*_FR` fields are not expected from detail calls. For example, if the user asks for a movie plot, the model should first identify the movie with `query_text2sql` if needed, then call `get_movie_detail` with the returned `ID_MOVIE`, and answer from the returned `PLOT` field. Series pages expose season summaries that open `get_season_detail` with `ID_SERIE` and `SEASON_NUMBER`; season pages render the returned `episodes` summaries, and selecting one opens `get_episode_detail` with its three-part key. If the user asks about a technical format such as `Technicolor`, the model should identify it with `query_text2sql` if needed, then call `get_technical_detail` with the returned `ID_TECHNICAL`. Movie detail responses can also include a `technicals` collection with technical entries such as sound systems and film formats. Technical detail responses can include associated `movies` and same-type `siblings`. Movie and series detail responses can include `posters` and `backdrops` image collections.

The local adapter returns compact fields used by the browser and the model:

```json
{
  "answer": "...",
  "error": "",
  "result_count": 50,
  "visible_results": [],
  "rows": [],
  "page": 1,
  "rows_per_page": 50,
  "question_hashed": "...",
  "has_more": true,
  "sql_query": "...",
  "diagnostic": {
    "reason": "entity_unresolved",
    "retryable": false,
    "unresolved_entities": ["Rohmer"]
  }
}
```

The `diagnostic` object is a compact, actionable reason why a query produced nothing, recovered from upstream signals that the trimmed tool output otherwise drops (on an empty result the model would only see `answer="" error="" result_count=0` and could not tell an unresolved entity from a genuinely empty database). `reason` is one of:

| `reason` | Meaning | Suggested recovery |
|---|---|---|
| `ok` | The query returned rows. | None. |
| `transient` | Retryable upstream error (e.g. provider quota `429`). `retryable` is true and `retry_after_seconds`/`error_code` may be present. | Retry the same query after `retry_after_seconds`. |
| `no_sql` | The model failed to generate SQL. | Decompose into sub-questions and re-query each. |
| `sql_error` | SQL was generated but the request still carried an error. | Reformulate the question. |
| `entity_unresolved` | One or more spoken entities did not resolve; their names are in `unresolved_entities`. | Re-query with a spelling/name variant, or ask the user to clarify. |
| `ambiguous` | The question was too vague for the API to build a query. | Ask the user to narrow it, or decompose. |
| `empty_result` | SQL ran but matched no rows. | Relax a filter (year, genre) and re-query. |

The Realtime and `/text-chat` prompts act on `diagnostic` (shared `RECOVERY_INSTRUCTIONS` in `app/main.py`): on an empty or failed result the agent reads `diagnostic.reason` and makes a bounded, grounded recovery attempt — re-query with an alternate name on `entity_unresolved`, relax a filter on `empty_result`, decompose on `ambiguous`/`no_sql` — at most two attempts, then it states plainly that nothing was found. Recovery always re-queries the database; it never answers from pretraining, and it never fabricates a result. The browser forwards `diagnostic` to the Realtime model in the `query_text2sql` tool output, and `/text-chat` includes it in the server-side tool result. It is also recorded in the `tool_call_success` client log event (`diagnostic` field), so offline log harvests can auto-classify real failures by `reason`: the browser logs it on the Realtime/voice path, and `/text-chat` logs it server-side for typed queries (`"source": "text-chat"`). `client.log` is filtered server-side (`HARNESS_LOG_EVENTS` in `app/main.py`) to keep only harness-relevant events — tool calls, queries, and their diagnostics; UI/transport telemetry (focus, visibility, WebRTC/ICE, keepalive, mic, wake-lock, …) is dropped at write time.

## Structured Card Focus

When `ENABLE_STRUCTURED_CARD_FOCUS` is true, the Realtime session includes a browser-handled `focus_result_card` tool. After a `query_text2sql` result page is rendered, the browser adds a compact `visible_results` list to the tool output sent back to the model. Each entry contains the visible 1-based card index, title, and subtitle/year when available. Before the voice model speaks about a specific visible card, it can silently call `focus_result_card` with that index, and the browser highlights the card immediately. User-facing phrasing uses titles and subtitle/year disambiguators instead of reciting card numbers unless the user explicitly asks for numbered output.

Set `ENABLE_STRUCTURED_CARD_FOCUS=false` to remove the tool and the related instruction from new Realtime sessions. For local testing, add `?structuredCardFocus=0` to the app URL before starting a voice session; the browser forwards that override to `/session`.

## Native Subtitles

`ENABLE_SPOKEN_SUBTITLES` controls whether Realtime voice-mode assistant answers also appear in the native bottom subtitle overlay. It defaults to `false`, so normal voice sessions keep speaking without captions unless this demo/recording feature is explicitly enabled.

The browser forwards `spoken_subtitles=0` or `1` to `/session` when the page URL contains `?spokenSubtitles=0`, `?spokenSubtitles=1`, `?spoken_subtitles=0`, or `?spoken_subtitles=1`. The server returns the resolved value as `X-Spoken-Subtitles`, and the browser only feeds Realtime assistant transcripts to `#subtitleOverlay` when that header is `1`.

When active, `response.output_audio_transcript.delta` and `response.audio_transcript.delta` feed a pending subtitle queue instead of rendering immediately. The browser starts releasing readable chunks only after `output_audio_buffer.started`, paces them from the audio-start timestamp, keeps the last chunk visible while audio is still playing, and clears pending voice subtitles on barge-in, typed Realtime interruption, New conversation, or output cancellation. `response.output_audio_transcript.done` supplies the final transcript so the last chunk can be flushed without racing ahead of speech. Text-mode `/text-chat` subtitles continue to use the same overlay and are unaffected by this flag.

`ENABLE_USER_TRANSCRIPT_SUBTITLES` controls whether completed Realtime voice input transcripts appear in the native top user subtitle lane. It defaults to `false`. The browser forwards `user_transcript_subtitles=0` or `1` to `/session` when the page URL contains `?userTranscriptSubtitles=0`, `?userTranscriptSubtitles=1`, `?user_transcript_subtitles=0`, or `?user_transcript_subtitles=1`. The server returns the resolved value as `X-User-Transcript-Subtitles`, and the browser only feeds `conversation.item.input_audio_transcription.completed` text to `#userSubtitleOverlay` when that header is `1`.

## App Menu

The burger button in the control row opens a right-side drawer. It is keyboard accessible, traps focus while open, closes from the close button, backdrop, or `Escape`, and restores focus to the burger button or the element that opened it.

Settings exposes two real controls: **Assistant subtitles** and **User transcript lane**. These controls update the current page URL with `spokenSubtitles=0/1` and `userTranscriptSubtitles=0/1`, which the browser already forwards to `/session` as `spoken_subtitles` and `user_transcript_subtitles` on the next Realtime session negotiation. They do not edit `.env`; server defaults still come from `ENABLE_SPOKEN_SUBTITLES` and `ENABLE_USER_TRANSCRIPT_SUBTITLES` when no URL override is present.

About credits the publisher (A Fistful of Reels, linking to its X profile), the AI agents, and the OpenAI Realtime API voice; shows a data-sources logo row (the official TMDb logo plus IMDb, Wikipedia, Wikidata, YouTube) and a "Powered by" technology logo wall (white monochrome brand SVGs bundled under `static/icons/tech/`, with text chips for components lacking an official icon); and carries the required legal attributions (the TMDb non-endorsement notice, an IMDb credit, and the Wikipedia CC BY-SA / Wikidata CC0 notice) plus a copyright line.

## Launch Splash And Showcase

On the first cold page load, the app shows a full-screen splash before the sample showcase. The splash displays one hardcoded localized hook line and the `Voice Movie Database` title for about 1.5 seconds. The browser starts loading `GET /tool/samples` during that hold, then hands off to the normal launch showcase: the title flies toward the real top-of-screen header while the showcase fades in beneath it.

- The splash is cold-load only. It is not replayed by **New conversation**, history navigation, or result/detail re-renders.
- Tapping the splash or pressing `Escape` skips it immediately.
- `prefers-reduced-motion` is honored: the splash uses a brief static hold and cuts to the showcase without the title fly animation.
- The browser fetches the questions from the local `GET /tool/samples?ui_language=...` proxy, which forwards to the upstream text2sql `GET /samples` endpoint (the API key is injected server-side). The launch showcase has no user query to detect a language from, so it requests English (`ui_language=en`) by default. After a successful load, the browser keeps the samples in memory so **New conversation** can repopulate the launch view immediately.
- The `/samples` response is a category tree where each sample carries a `simulated_result` preview (entity rows hydrated with title/poster, or a single scalar value). The app flattens the tree, keeps only samples with a renderable preview, and round-robins across top-level categories so the showcase mixes topics rather than clustering one category.
- Layout is a horizontal marquee: the groups (each a question chip followed inline by its result poster cards) are spread across a few stacked lanes, and every lane scrolls right-to-left so cards enter from the right edge, cross the screen, and exit on the left, looping seamlessly. Lanes run at slightly different speeds for a natural wall effect, and the marquee pauses on hover and while the tab is hidden. The result cards reuse the standard search-result card renderer.
- Question chips stay on one line when short, but wrap to multiple lines for long questions and preserve embedded newlines for multi-line questions (clamped so an unusually long question cannot blow out the lane height).
- Clicking a sample question runs it as a real query through the normal text input flow; clicking a poster opens that entity's detail page.
- The showcase is dismissed on the first real interaction — typing a question, starting a voice session, or any rendered result/detail — and does not reappear for the rest of the session. **New conversation** returns to the launch state and brings the showcase back.
- `prefers-reduced-motion` is honored: the animations stop and the showcase becomes a static, manually scrollable list. If the samples request fails, the app silently skips the showcase and the rest of the UI is unaffected.

## Frontend Result Display

When a text2sql result arrives, the app renders result cards in the UI in addition to the spoken answer.

When the results panel contains a search result page or an entity detail page, the app switches to a compact display mode: the `Voice Movie Database` title and the status row are hidden, leaving only the Start/Stop, Back, Forward, text input with its conditional submit button, and New Conversation controls above the result content. Clearing the conversation restores the full header.

On short landscape viewports, including iOS Safari on iPhone 15 Pro Max, the app shell removes the outer page padding and square-corners the main panel so result/detail pages fill the available browser viewport from the top edge.

Search result answer panels include an icon-only query-details toggle on the right side of the answer panel. The toggle uses a down-oriented triangle when closed, switches to an up triangle when open, and opens or closes the SQL/justification details in a compact dock directly below the answer panel.

Click-through behavior:

- Cards for records with a supported entity ID open the matching in-app detail page instead of navigating away.
- Supported click-through records include movies, series, seasons, episodes, people, companies, networks, collections, topics, lists, movements, technicals, genres, groups, deaths, awards, nominations, and Wikidata-backed locations.
- The detail view uses the same local `GET /tool/detail/{entity}/{id}?ui_language=...` adapter as Realtime detail tool calls, then renders the returned record content in the results panel.
- Entity detail tool outputs keep compact `wikipedia_content` available to the model for grounding background, history, biography, plot-context, and explanatory answers, but the UI does not render Wikipedia content sections on detail pages.
- Normal detail answers stay concise. When the user explicitly asks "tell me more", "in detail", "the full story", or a similar verbose follow-up, the app treats that single turn as a verbose detail request: it relaxes the model-facing `wikipedia_content` caps for the relevant detail tool output and instructs the model to give a longer paraphrased answer grounded in the returned Wikipedia sections. The raw Wikipedia sections are still not rendered as UI content and should not be read verbatim.
- Entity detail pages use the same click-through behavior for their embedded relation cards. For example, a movie page's cast, topics, collections, awards, companies, and similar page elements can be clicked to replace the current page with that related entity detail page.
- Embedded relation sections on movie, series, person, and other entity detail pages render as single-row horizontal rails. Upstream detail endpoints return the first page of each related collection plus per-collection totals. Rails show the loaded count when pagination metadata is present. When the user scrolls or slides close to the right edge of a paginatable rail, the next targeted collection page is fetched automatically. The returned cards are appended to the right side of the existing rail without rebuilding the detail page or moving the current horizontal position. The rail can still be moved with the left/right controls or native horizontal scrolling, and every returned card remains clickable.
- The Back and Forward controls maintain a client-side page history across text2sql result pages, loaded result pages, direct detail tool pages, and clicked entity detail pages.

Image behavior:

- TMDb `POSTER_PATH`, `PROFILE_PATH`, and `LOGO_PATH` values render through `https://image.tmdb.org/t/p/...`.
- Company and network visuals prefer the **padded 2:3 logo masters** generated by the sibling `synthetic-images` repo (real logo letterboxed onto an off-white canvas with a readability halo) and served by `tmdb-front`'s Apache at `https://www.vaugouin.com/synthetic-images/...`. Having no database access, the browser derives each master URL deterministically — `sha256("<class>:<id>|logo-pad|<style version>")` truncated to 32 hex chars — probes it, and swaps it in only when the file exists; on 404 the raw TMDb logo (or text fallback) stays. This applies to search result cards, company/network detail-page main images, and embedded `Companies`/`Networks` relation rails. The `SYNTHETIC_STYLE_VERSION` constant in `app.js` must be kept in sync with `STYLE_VERSION` in the synthetic-images `.env`; a mismatch degrades gracefully to raw logos.
- `WIKIPEDIA_IMAGE_PATH` values render as Wikipedia/Wikimedia images when provided by the upstream API.
- Wikipedia images are used on primary entity detail pages for topics, collections, lists, movements, technicals, groups, deaths, awards, nominations, and locations when no TMDb poster/profile/logo is present.
- Embedded relation rails also use `WIKIPEDIA_IMAGE_PATH`, including topics, lists, collections, movements, technicals, awards, and nominations on movie/series detail pages, plus technical siblings on technical detail pages and groups, deaths, awards, and nominations on person detail pages.
- Search result cards, embedded relation cards, and primary detail-page poster/portrait images set both `alt` and `title` attributes from the displayed entity title, so hovering over a picture shows its text label.
- Static frontend assets are referenced with a version query in `index.html`; bump that version when changing `app.js` or `styles.css` so browsers fetch the current UI code after deployment or reload.

Pagination behavior:

- First page is shown immediately.
- Infinite scroll loads additional pages while `has_more` is true.
- `TEXT2SQL_ROWS_PER_PAGE` controls the page size.
- A `Load more` button remains available if automatic loading stops.
- Entity-detail rail pagination is independent from text2sql search pagination. Detail rails use the upstream detail response's top-level `pagination` map and load targeted collection pages through `collection`, `page`, and `rows_per_page` query parameters.

Detail page header behavior:

- Movie, series, person, and other entity detail pages show their key metrics directly under the title/tagline before cast, relation rails, or other content sections.
- Movie and series detail pages label the people section as `Cast`, render every cast member returned by the API in one horizontal rail, and render the full returned crew in a separate `Crew` rail with the same sliding behavior.
- Series detail pages render the `/series/{id}` `seasons` collection as a clickable `Seasons` rail above the `Cast` rail; selecting a season opens `/seasons/{id_serie}/{season_number}`.
- Season detail pages show air date, episode count, rating, parent-series navigation, a clickable `Episodes` rail above `Cast`, cast, and crew returned by `/seasons/{id_serie}/{season_number}`. Each episode card opens its `/episodes/{id_serie}/{season_number}/{episode_number}` page.
- Episode detail pages show air date, runtime, rating, parent-series and parent-season navigation, cast, crew, and still images returned by `/episodes/{id_serie}/{season_number}/{episode_number}`.
- Movie detail pages render the `/movies/{id}` `technicals` collection as a `Technicals` rail directly below the `Crew` rail when technical entries are returned by the API. Each technical card is clickable and opens `/technicals/{id}` through the local detail adapter.
- Movie and series director metrics are clickable when the API returns a matching person record, and open that person's detail page in the same results panel.
- Movie and series `Crew` rails collapse repeated records for the same person into one clickable card and concatenate their crew departments, for example `Writing, Production, Directing`.
- Series detail pages show `First aired`, `Seasons`, `Episodes`, and `IMDb` in this top metric area.
- Movie detail pages show release date, runtime, IMDb rating, and director when those fields are available.
- Person detail pages show `Born`, `Died`, `Known for`, and `Country` in the same top metric area. When `Country` is a 2-letter country code, the UI displays the corresponding Unicode flag emoji next to the code, for example `🇺🇸 US`.
- Person detail pages use the `/persons/{id}` `portraits` array to show a swipe-only portrait viewer in the main picture area, with `PROFILE_PATH` as a fallback.
- Movie and series detail pages use the `/movies/{id}` and `/series/{id}` `posters` arrays to show a swipe-only poster viewer in the main picture area, with `POSTER_PATH` as a fallback.
- Movie and series detail pages use the `/movies/{id}` and `/series/{id}` `backdrops` arrays to show a wide swipeable backdrop viewer below the poster, with `BACKDROP_PATH` as a fallback. Clicking a backdrop toggles fullscreen zoom. Sliding horizontally moves to the previous or next backdrop. A top-right play button starts a slideshow across all available backdrops and changes to a stop button while the slideshow is running; the control remains visible in normal and fullscreen modes.
- Clicking the main portrait, poster, logo, or Wikipedia image on any entity detail page expands the current image to a full-screen viewer. Clicking the full-screen image or pressing `Escape` returns it to the normal detail-page position.
- Collection, topic, list, movement, technical, group, death, award, nomination, company, network, and location detail pages show available type/count/rating metrics in the top metric area. Technical detail pages use the localized `DESCRIPTION` value as their display title, show `TECHNICAL_TYPE` as the type metric, and render associated movies plus same-type sibling technicals as clickable rails.
- Genre detail pages (`get_genre_detail` → `GET /genres/{id}`) use the localized `GENRE_NAME` as their title and render the genre's best-rated member `movies` and `series` as clickable rails. Genres currently have no own image or Wikidata/Wikipedia block (the `T_WC_TMDB_GENRE` table has no `ID_WIKIDATA` yet), so the detail poster falls back to the genre name.

## Retained Context

Realtime sessions do not survive a WebRTC reconnect. To reduce context loss, the browser stores a compact rolling context in `localStorage`:

```text
voice-agent-context-v1
```

The retained context includes:

- user speech transcripts
- text2sql tool queries and compact results
- entity detail tool context, including the current entity, endpoint, and ID
- assistant output transcripts

When a new data channel opens, the app seeds the new session with retained context. If a reconnect happens mid-answer, the resume prompt also includes that retained context.

This is not the same as preserving the original OpenAI session. It is a pragmatic client-side continuity layer for dropped WebRTC sessions.

Current implementation note: `loadRetainedContext()` exists, and context is saved under `voice-agent-context-v1`, but page load currently calls `clearRetainedContext()`. That means retained context is used for continuity within the current browser page lifetime and reconnect flow, but it is not restored after a full page refresh unless startup is changed to initialize `retainedContext = loadRetainedContext()` instead of clearing it.

## Text Input

The UI includes a multiline question box beside the microphone controls. The microphone start control uses a layered `👄` and `❌` visual, the audio stop control is shown as `👄`, and the adjacent green microphone toggle shows `👂🏻` when input is open or `👂🏻` with `❌` when input is closed. The next green toggle is the Look control; it starts as `Look Off` with `👁️` plus `❌`, and switches to `Look On` with `👁️` when clicked. A round white submit button with a black up arrow appears immediately to the right of the question box whenever it contains non-whitespace text; clicking it submits the same way as pressing `Enter`.

When the Start or Stop control is shown, its session button uses the green active-control background.

For the complete stateful reference of Start/Stop, text entry, answer/results panel, status panel, subtitles, history, New conversation, hidden audio/log elements, and dynamic detail viewer controls, see `UI.md`.

The Start control remains visible and available while the user types text. Pressing Start switches into the Realtime voice path; pressing `Enter` or the submit arrow sends the typed text through the current text/voice routing rules.

When no Realtime session is running and the text box is empty, the microphone toggle becomes a dictation control. Clicking it records browser microphone audio with `MediaRecorder`, auto-stops after speech followed by silence or after a 30-second cap, posts the raw audio to `/transcribe`, and sends the returned transcript through `/text-chat` for a text answer and the usual result rendering.

The Start button remains visible while idle dictation is recording, so the user can still switch into the Realtime voice path from the same control row.

Pressing `Enter` after Start has begun a Realtime session sends the typed message through that Realtime path, regardless of whether the microphone toggle is open or closed. If the data channel is still opening, typed turns are queued until it is ready and then submitted before a spoken response is requested. If an earlier spoken answer is active, it is interrupted before the new turn is sent. The turn uses `OPENAI_REALTIME_MODEL`, may use the same tools as spoken turns, and plays the new answer through Realtime audio output. When no Realtime session is running, pressing `Enter` sends text to the server-side `/text-chat` endpoint. Press `Shift+Enter` to add a new line without submitting.

## App Icon

The app uses `app/static/icons/voice-agent-1254x1254.png` as its browser favicon, Apple touch icon, and web manifest icon. The manifest is served from `/static/site.webmanifest`, with `start_url` and `scope` pointing back to the app root so iPhone home-screen shortcuts launch `/` instead of `/static/`. Modern browsers and iOS Safari can use the PNG directly; an `.ico` file is optional legacy fallback and is not required for browser tabs or iPhone Add to Home Screen.

The `/transcribe` endpoint forwards browser-recorded dictation audio to the OpenAI audio transcription API with `OPENAI_TRANSCRIPTION_MODEL`, defaulting to `gpt-4o-transcribe`, and returns the transcript text to the browser.

The `/text-chat` endpoint calls the OpenAI Responses API with `OPENAI_TEXT_MODEL`, defaulting to `gpt-5.1`. The client sends compact retained conversation context with the text message so follow-up typed or dictated turns can stay coherent. To guarantee the same visible behavior as the audio agent, the endpoint always executes `query_text2sql` once for the submitted message before asking the text model to answer. It returns that forced tool output to the browser for card rendering, provides it to the model as grounded context, and still exposes every detail lookup tool so the text model can request entity pages when needed.

When text-mode tool calls return data, the browser renders those results in the same results panel used by voice-mode tool calls. For example, a typed movie search populates text2sql result cards, and a typed detail request can still render the matching entity detail page.

Text model output is displayed as subtitle-style labels fixed near the bottom of the app. Long responses are split into readable chunks that preserve reply structure, including numbered and bulleted list boundaries, and appear and disappear after a duration based on the amount of text. Realtime voice output can use the same bottom overlay when `ENABLE_SPOKEN_SUBTITLES=true` or a `?spokenSubtitles=1` URL override is active for the session. Realtime voice input can show the completed user question in the top subtitle lane when `ENABLE_USER_TRANSCRIPT_SUBTITLES=true` or a `?userTranscriptSubtitles=1` URL override is active for the session.

User-facing assistant feedback does not mention backend identifiers such as IMDb IDs, Wikidata IDs, TMDb IDs, TVDB IDs, `ID_*` fields, or other database IDs. Entities are represented by cards and detail links in the UI, so subtitles and spoken answers use names and titles, adding the visible year or subtitle when duplicate titles need disambiguation.

When assistant speech transcripts or subtitle chunks reference a search result by number, ordinal, visible card title, or title plus year/subtitle, the matching card receives a temporary spoken-focus highlight and the previous spoken-focus card is cleared. Result numbers are tracked internally and are not shown as badges on the cards. Duplicate bare-title matches resolve with nearby year, ordinal, or card-index context first; if no disambiguator is present, repeated same-title mentions are assigned to the lowest-index duplicate not already matched in that text, rather than defaulting to the later duplicate. Subtitle highlights happen as each subtitle chunk appears. Realtime spoken-answer highlights can also be driven by `focus_result_card` tool calls when structured card focus is enabled; transcript-derived cues remain as the fallback and are paced from the `output_audio_buffer.started` event so final transcript events do not jump the UI ahead of audible playback.

The question box grows vertically as lines are added, up to a capped height where it scrolls internally.

## Switching Audio To Text

Typed text has two paths. Once a Realtime session has started, the browser queues typed input until its data channel is ready when necessary, cancels a generating response and clears playing output audio as needed, then sends the input into that same WebRTC Realtime conversation; the new answer is spoken using `OPENAI_REALTIME_MODEL`, independent of the microphone toggle state. Otherwise, typed text posts to `/text-chat`, which calls a standard OpenAI text model through the Responses API, runs the application tool loop server-side, renders returned tool results, and displays the final text response as subtitle output.

Idle dictation uses the text path too: it records audio locally, transcribes it through `/transcribe`, then submits the transcript to `/text-chat`. It does not create a Realtime WebRTC session and it does not produce model audio.

## Connection Resilience

Three layers protect the WebRTC session from idle-time drops and transient network blips.

### Keepalive heartbeat

Every 2 seconds the client sends a no-op `session.update` (with `session.type=realtime`, an idempotent merge) on the `oai-events` data channel. This keeps the SCTP/DTLS/UDP path actively exchanging packets, which:

- prevents NAT mappings (especially aggressive carrier-grade NAT) from aging out during silent periods such as post-response audio playout or in-flight tool calls,
- keeps Firefox's ICE consent freshness check (RFC 7675, ~15s timeout) satisfied.

The interval timer runs inside a dedicated Web Worker rather than on the main thread. Browser `setInterval` is throttled aggressively in background tabs and unfocused windows, sometimes enough to miss multiple 2-second fires; Worker timers are not subject to that throttling, so the cadence holds while the user is doing something else. The main thread translates each worker `tick` message into a data-channel send. If Worker creation fails (CSP, very old browsers), the code falls back to main-thread `setInterval` and logs `keepalive_started` with `mode=interval`.

A keepalive is also sent immediately on `visibilitychange` to visible and on window `focus`, to pump a packet the moment the user returns rather than waiting for the next scheduled tick.

### Disconnect watchdog

`peer_connection_state === "disconnected"` is officially transient per the WebRTC spec — the connection can recover on its own. Instead of immediately scheduling a reconnect (which would tear down a working session), the client starts an 8-second watchdog. When the watchdog fires it re-checks the current state and only schedules a reconnect if the connection is still bad. `failed` triggers a reconnect immediately at 500 ms.

The reconnect timer itself also re-checks `pc.connectionState` and `dc.readyState` before tearing down — if the connection self-healed during the wait, the rebuild is aborted (`reconnect_aborted_self_healed`) and the existing session continues.

### Multi-attempt reconnect

`maxReconnectAttempts` is 5. The retry counter resets to 0 every time the peer reaches `connected`, so transient drops over a long session never lock the user out. When all attempts are exhausted, the UI shows `Disconnected` and the user is prompted to start a new session manually.

Retained context (see above) is replayed into the new session on reconnect, and a "the connection dropped while you were answering" resume prompt is sent if there was an in-flight response or tool call.

## Diagnostics

Client diagnostics are written to:

```text
logs/client.log
```

Logged signals include:

- Realtime events
- microphone track state
- remote audio element state
- WebRTC connection and ICE state
- selected candidate stats on disconnect/failure
- page lifecycle and visibility events
- iOS/Safari capability snapshots
- reconnect attempts
- retained-context seeding

Useful events:

```text
realtime_support
webrtc_unavailable
peer_connection_state
peer_connection_stats
media_track_state
remote_audio_element
page_lifecycle
page_visibility
context_seeded
context_retained
dictation_started
dictation_transcribe_sent
dictation_transcribed
dictation_error
look_toggle
realtime_text_sent
realtime_text_error
realtime_text_queued
keepalive_started
keepalive_stopped
keepalive_send_error
keepalive_worker_error
keepalive_worker_unavailable
disconnect_watchdog_check
reconnect_scheduled
reconnect_aborted_self_healed
reconnect_resume_sent
reconnect_failed
reconnect_abandoned
data_channel_close
```

## iPhone and Safari Notes

The public deployment must be opened as HTTPS:

```text
https://www.vaugouin.com/voice-agent/
```

The internal Nginx-to-container hop can still use:

```nginx
proxy_pass http://voice-agent:3000/;
```

That is normal Docker reverse-proxy architecture. Browser secure-context checks apply to the public page origin, not to the private proxy hop.

If iOS logs show:

```json
{
  "isSecureContext": true,
  "hasRTCPeerConnection": false,
  "hasWebkitRTCPeerConnection": false,
  "hasMediaDevices": false,
  "hasGetUserMedia": false
}
```

then HTTPS is not the problem. Safari is hiding WebRTC and microphone APIs in that browser context. Check:

- whether the page is opened directly in Safari, not an embedded in-app browser
- Lockdown Mode
- Safari Advanced Feature Flags
- enterprise/MDM/profile restrictions
- Screen Time or content restrictions

## Docker Build and Run

On the VPS:

```bash
cd /home/debian/docker/voice-agent
docker build -t voice-agent:latest .
docker rm -f voice-agent
docker run -d \
  --name voice-agent \
  --restart unless-stopped \
  --network reverseproxy \
  -p 3000:3000 \
  --env-file /home/debian/docker/voice-agent/.env \
  -v /home/debian/docker/voice-agent/logs:/app/logs \
  voice-agent:latest
```

The host-mounted logs folder keeps browser diagnostics outside the container:

```text
/home/debian/docker/voice-agent/logs/client.log
```

## Nginx

Use `deploy/nginx-voice-agent-location.conf` inside the HTTPS server block:

```nginx
location = /voice-agent {
  return 301 /voice-agent/;
}

location /voice-agent/ {
  proxy_pass http://voice-agent:3000/;
  proxy_http_version 1.1;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header X-Forwarded-Prefix /voice-agent;

  proxy_connect_timeout 600s;
  proxy_send_timeout 600s;
  proxy_read_timeout 600s;
  send_timeout 600s;
}
```

After changes:

```bash
docker exec reverseproxy nginx -t
docker exec reverseproxy nginx -s reload
```

Adjust the container name if your Nginx container is not named `reverseproxy`.

## Cache Busting

The HTML references static assets with version query strings:

```html
styles.css?v=20260702-mic-always-enabled
app.js?v=20260702-mic-always-enabled
```

When changing frontend behavior, bump the version to force Safari and other browsers to fetch the new asset after deployment.

## Common Troubleshooting

### `WebRTC is unavailable`

Check `logs/client.log` for `realtime_support`. Confirm:

```json
"isSecureContext": true
"hasRTCPeerConnection": true
"hasMediaDevices": true
"hasGetUserMedia": true
```

If `isSecureContext` is false, use HTTPS. If secure context is true but WebRTC APIs are missing, the issue is browser/runtime policy.

On Apple Watch, this is expected: the watch browser can load the page and use typed text, but the Realtime voice path depends on `RTCPeerConnection` and `navigator.mediaDevices.getUserMedia`, which are not available there.

### `microphone permission denied`

Allow microphone access for the site. On iPhone, this must be done in Safari for the HTTPS origin.

### Answers stop mid-sentence

Check the resilience signals first:

```text
keepalive_started              confirms the heartbeat is running, with mode=worker or mode=interval
disconnect_watchdog_check      fires 8s after a disconnected event; stillBad=false means self-heal worked
reconnect_aborted_self_healed  reconnect was scheduled but the peer recovered before tear-down
reconnect_scheduled            a real reconnect is in flight, with reason and attempt number
```

Then the underlying signals:

```text
peer_connection_state
peer_connection_stats
remote_audio_element
page_lifecycle
media_track_state
```

If `keepalive_started` reports `mode=interval` instead of `mode=worker`, the Web Worker fallback engaged and the heartbeat may be subject to background-tab throttling. If keepalives stop firing for several seconds before a disconnect, the timer was throttled — typically because the window/tab lost focus on a browser that doesn't isolate the Worker properly.

### Second question does not respond

Check:

```text
activeResponseId
activeAudioResponseId
toolCallsInFlight
awaitingToolResponse
data_channel_close
```

The client mutes the microphone while the assistant is speaking or while tool output is pending, then re-enables it when the response is complete. If the microphone toggle is manually closed, the track stays disabled until the user opens it again.

## Verification

Syntax checks:

```powershell
python -m py_compile .\app\main.py
node --check .\app\static\app.js
```

Local smoke test:

1. Start the app on port `3000`.
2. Open `http://127.0.0.1:3000/`.
3. Click `Start`.
4. Ask by voice: `List movies directed by Francois Truffaut`.
5. Type a second question in the question box and press `Enter`.
6. Confirm spoken answers and result cards.
7. Type a multiline question with `Shift+Enter`, then press `Enter` to submit.
8. With no Realtime session running and an empty text box, click the microphone toggle, ask a short question, and confirm the transcript is answered through text mode.
