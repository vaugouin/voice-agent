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
- Voice selector for Realtime voices.
- Rolling retained context in `localStorage` so reconnects can continue with prior user requests and tool results during the current page lifetime.
- Web Worker keepalive on the `oai-events` data channel to keep ICE/NAT alive during silent periods, including in unfocused windows.
- Disconnect watchdog with self-heal check that avoids tearing down sessions that recover on their own.
- Multi-attempt reconnect (up to 5) that resumes from retained context.
- New conversation button that clears the screen and retained context.
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
- `GET /tool/detail/{entity}/{id}` adapts dedicated detail tool calls to the upstream entity detail API.

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
- voice: selected by the UI, default `ash`
- input transcription: `gpt-4o-transcribe`
- turn detection: server VAD
- tools: `query_text2sql` plus dedicated detail tools for movies, series, seasons, episodes, persons, companies, networks, collections, topics, lists, movements, technicals, groups, deaths, awards, nominations, and locations

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
  "question_hashed": "<hash from previous response>",
  "ui_language": "en",
  "page": 2,
  "rows_per_page": 50,
  "retrieve_from_cache": true,
  "store_to_cache": true,
  "complex_question_processing": false
}
```

Authentication is configured by:

```text
TEXT2SQL_BASE_URL=http://www.vaugouin.com:8186
TEXT2SQL_API_KEY_NAME=X-API-Key
TEXT2SQL_API_KEY_VALUE=...
```

## Detail Tool Flow

When the model needs detail fields for a specific entity, it can call a dedicated detail tool. The browser receives the Realtime function call and proxies it through:

```text
GET /tool/detail/{entity}/{id}
```

The local adapter forwards to the text2sql API detail endpoints documented in `C:\Users\vaugo\Code\fastapi-text2sql\README.md`:

| Realtime tool | Upstream endpoint | ID |
|---|---|---|
| `get_movie_detail` | `GET /movies/{id}` | `ID_MOVIE` |
| `get_series_detail` | `GET /series/{id}` | `ID_SERIE` |
| `get_season_detail` | `GET /seasons/{id_serie}/{season_number}` | `ID_SERIE`, `SEASON_NUMBER` |
| `get_episode_detail` | `GET /episodes/{id_serie}/{season_number}/{episode_number}` | `ID_SERIE`, `SEASON_NUMBER`, `EPISODE_NUMBER` |
| `get_person_detail` | `GET /persons/{id}` | `ID_PERSON` |
| `get_company_detail` | `GET /companies/{id}` | `ID_COMPANY` |
| `get_network_detail` | `GET /networks/{id}` | `ID_NETWORK` |
| `get_collection_detail` | `GET /collections/{id}` | `ID_T2S_COLLECTION` |
| `get_topic_detail` | `GET /topics/{id}` | `ID_TOPIC` |
| `get_list_detail` | `GET /lists/{id}` | `ID_T2S_LIST` |
| `get_movement_detail` | `GET /movements/{id}` | `ID_MOVEMENT` |
| `get_technical_detail` | `GET /technicals/{id}` | `ID_TECHNICAL` |
| `get_group_detail` | `GET /groups/{id}` | `ID_GROUP` |
| `get_death_detail` | `GET /deaths/{id}` | `ID_DEATH` |
| `get_award_detail` | `GET /awards/{id}` | `ID_AWARD` |
| `get_nomination_detail` | `GET /nominations/{id}` | `ID_NOMINATION` |
| `get_location_detail` | `GET /locations/{wikidata_id}` | `ID_WIKIDATA`, for example `Q90` |

For example, if the user asks for a movie plot, the model should first identify the movie with `query_text2sql` if needed, then call `get_movie_detail` with the returned `ID_MOVIE`, and answer from the returned `PLOT` field. Series pages expose season summaries that open `get_season_detail` with `ID_SERIE` and `SEASON_NUMBER`; season pages render the returned `episodes` summaries, and selecting one opens `get_episode_detail` with its three-part key. If the user asks about a technical format such as `Technicolor`, the model should identify it with `query_text2sql` if needed, then call `get_technical_detail` with the returned `ID_TECHNICAL`. Movie detail responses can also include a `technicals` collection with technical entries such as sound systems and film formats. Technical detail responses can include associated `movies` and same-type `siblings`. Movie and series detail responses can include `posters` and `backdrops` image collections.

The local adapter returns compact fields used by the browser and the model:

```json
{
  "answer": "...",
  "error": "",
  "result_count": 50,
  "rows": [],
  "page": 1,
  "rows_per_page": 50,
  "question_hashed": "...",
  "has_more": true,
  "sql_query": "..."
}
```

## Frontend Result Display

When a text2sql result arrives, the app renders result cards in the UI in addition to the spoken answer.

When the results panel contains a search result page or an entity detail page, the app switches to a compact display mode: the `Voice Movie Database` title and the status row are hidden, leaving only the Start/Stop, Back, Forward, text input with its conditional submit button, and New Conversation controls above the result content. Clearing the conversation restores the full header.

On short landscape viewports, including iOS Safari on iPhone 15 Pro Max, the app shell removes the outer page padding and square-corners the main panel so result/detail pages fill the available browser viewport from the top edge.

Search result answer panels include an icon-only query-details toggle on the right side of the answer panel. The toggle uses a down-oriented triangle when closed, switches to an up triangle when open, and opens or closes the SQL/justification details in a compact dock directly below the answer panel.

Click-through behavior:

- Cards for records with a supported entity ID open the matching in-app detail page instead of navigating away.
- Supported click-through records include movies, series, seasons, episodes, people, companies, networks, collections, topics, lists, movements, technicals, groups, deaths, awards, nominations, and Wikidata-backed locations.
- The detail view uses the same local `GET /tool/detail/{entity}/{id}` adapter as Realtime detail tool calls, then renders the returned record content in the results panel.
- Entity detail tool outputs keep compact `wikipedia_content` available to the model for grounding background, history, biography, plot-context, and explanatory answers, but the UI does not render Wikipedia content sections on detail pages.
- Entity detail pages use the same click-through behavior for their embedded relation cards. For example, a movie page's cast, topics, collections, awards, companies, and similar page elements can be clicked to replace the current page with that related entity detail page.
- Embedded relation sections on movie, series, person, and other entity detail pages render as single-row horizontal rails. When the upstream API returns more cards than fit on screen, the rail can be moved with the left/right controls or native horizontal scrolling, and every returned card remains clickable.
- The Back and Forward controls maintain a client-side page history across text2sql result pages, loaded result pages, direct detail tool pages, and clicked entity detail pages.

Image behavior:

- TMDb `POSTER_PATH`, `PROFILE_PATH`, and `LOGO_PATH` values render through `https://image.tmdb.org/t/p/...`.
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
- Collection, topic, list, movement, technical, group, death, award, nomination, company, network, and location detail pages show available type/count/rating metrics in the top metric area. Technical detail pages use `DESCRIPTION` / `DESCRIPTION_FR` as their display title, show `TECHNICAL_TYPE` as the type metric, and render associated movies plus same-type sibling technicals as clickable rails.

## Retained Context

Realtime sessions do not survive a WebRTC reconnect. To reduce context loss, the browser stores a compact rolling context in `localStorage`:

```text
voice-agent-context-v1
```

The retained context includes:

- user speech transcripts
- text2sql tool queries and compact results
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

Text model output is displayed as subtitle-style labels fixed near the bottom of the app. Long responses are split into readable chunks that preserve reply structure, including numbered and bulleted list boundaries, and appear and disappear after a duration based on the amount of text.

When assistant speech transcripts or subtitle chunks enumerate a search result by number, ordinal, or visible card title, the matching card receives a temporary spoken-focus highlight and the previous spoken-focus card is cleared. Result numbers are tracked internally and are not shown as badges on the cards. Subtitle highlights happen as each subtitle chunk appears. Realtime spoken-answer highlights are paced from the `output_audio_buffer.started` event so final transcript events do not jump the UI ahead of audible playback.

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
styles.css?v=20260531-start-visible-with-text
app.js?v=20260531-start-visible-with-text
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
