# UI State Reference

This document describes the current browser UI behavior implemented by `app/static/index.html`, `app/static/app.js`, and `app/static/styles.css`.

The app has one persistent shell, one control row, one status row, one hidden audio element, one results area, one assistant subtitle overlay, one opt-in user transcript subtitle lane, and several dynamic controls created by JavaScript. Most visibility is driven by these state variables:

- `sessionRunning`: true while a Realtime WebRTC audio session is considered active.
- `textChatInFlight`: true while a typed question is being processed by `/text-chat`.
- `textChatAbortController`: aborts the current `/text-chat` request when a newer text turn or New conversation cancels it.
- `dictationActive`: true while the idle microphone dictation recorder is capturing audio for `/transcribe`.
- `dictationTranscribing`: true while captured idle dictation audio is being transcribed and submitted to `/text-chat`.
- `questionInput.value`: determines whether the typed-question path is active.
- `userLookOpen`: stores the Look toggle state. It is `false` on page load and flips only when the Look button is clicked.
- `pendingRealtimeTextTurns`: typed turns submitted after Start while the Realtime data channel is still opening; they are sent when the channel opens.
- `resultsPanel.hidden`: determines whether result/detail content is visible and whether compact results mode is active.
- `launchShowcaseDismissed`: true once the launch showcase has been dismissed by the first user interaction; blocks it from reappearing until a new conversation resets it.
- `launchShowcaseRaf`: holds the active `requestAnimationFrame` id for the showcase's horizontal marquee, or `null` when the showcase is not animating.
- `launchShowcaseData`: stores the last successful `/tool/samples` response so New conversation can render the launch showcase without waiting on another fetch.
- `launchShowcaseLoading`: true while a launch showcase sample request is in flight.
- `currentSearchState`: stores pagination state for text2sql result pages.
- `activeUiLanguage`: stores the detected API language for the latest user turn or rendered result page; it is `fr` for detected French input and `en` for English or unsupported languages.
- `loadingMore`: true while another page of text2sql rows is loading.
- `autoPagesLoaded`: counts automatic infinite-scroll page loads before the manual Load more button is shown.
- `pageHistory` and `pageHistoryIndex`: drive Back and Forward button enablement.
- `subtitleQueue` and `subtitleTimer`: drive text-mode assistant subtitle overlay visibility and sequencing; Realtime assistant subtitles reuse the overlay and timer through their audio-paced queue.
- `userSubtitleTimer`: drives the opt-in user transcript subtitle lane duration.
- `activeSpokenCardIndex`: stores the currently highlighted result-card number while the assistant is enumerating visible cards.
- `spokenAudioHighlightCues`, `spokenAudioHighlightTimer`, and `spokenAudioHighlightPlaying`: pace Realtime spoken-answer card highlights from audio playback start instead of applying full transcript matches immediately.
- `structuredCardFocusActive`: true when the current Realtime session was created with the browser-handled `focus_result_card` tool enabled.
- `spokenSubtitlesActive`: true when the current Realtime session returned `X-Spoken-Subtitles: 1`, enabling assistant voice-mode subtitles in the bottom overlay.
- `userTranscriptSubtitlesActive`: true when the current Realtime session returned `X-User-Transcript-Subtitles: 1`, enabling user voice-mode transcripts in the top lane.
- `realtimeSpokenSubtitleBuffer`, `realtimeSpokenSubtitleChunks`, `realtimeSpokenSubtitleIndex`, `realtimeSpokenSubtitlePlaying`, `realtimeSpokenSubtitleStartedAt`, `realtimeSpokenSubtitleFinal`, `realtimeSpokenSubtitleAudioStopped`, `realtimeSpokenSubtitleLastText`, and `realtimeSpokenSubtitleSawDelta`: track and audio-pace the assistant transcript text used for the bottom subtitle overlay during Realtime voice output.
- `activeResponseId`, `activeAudioResponseId`, `toolCallsInFlight`, and `awaitingToolResponse`: drive microphone muting and status transitions during Realtime responses and tool work.

## Static Shell

### `main`

`main` is the page-level layout container.

- Default layout: full viewport minimum height with 12px outer padding.
- Mobile layout at `max-width: 768px`: outer padding becomes 10px.
- Short landscape layout at `orientation: landscape` and `max-height: 520px`: outer padding becomes 0, so the app can fill iOS landscape viewports edge to edge.

### `.panel`

`.panel` is the main app surface.

- Default layout: grid, 18px gap, 20px padding, 1px border, 8px radius, dark background, and shadow.
- Mobile layout at `max-width: 768px`: padding becomes 12px.
- Short landscape layout: minimum height becomes `100dvh`, border is removed, and radius becomes 0.
- Results mode: `.panel.resultsMode` is added whenever `resultsPanel.hidden === false`.
- Results mode reduces the panel gap to 12px and top padding to 12px.
- Short landscape results mode sets top padding to 0.

### App Header

Element: `.appHeader`, containing the `Voice Movie Database` title.

- Visible by default.
- Hidden when `.panel.resultsMode` is active.
- Results mode is active whenever the results panel is visible, including loading states, result pages, and detail pages.
- Clearing the conversation hides the results panel and makes the header visible again.

## Control Row

The control row is `.controls`. It contains, in order:

- App menu button.
- Start/Stop button slot.
- Microphone open/closed toggle slot.
- Look on/off toggle slot.
- Back button.
- Forward button.
- Text entry.
- Submit question button.
- New conversation button.

The row uses flex layout, bottom alignment, 10px gaps, and wrapping when the viewport is narrow.

## App Menu Button And Drawer

Elements:

- `#appMenuButton`
- `#appMenuBackdrop`
- `#appMenuDrawer`
- `#appMenuCloseButton`
- `#spokenSubtitlesMenuToggle`
- `#userTranscriptSubtitlesMenuToggle`

Purpose: opens a compact right-side drawer with Settings and About content.

Default state:

- `#appMenuButton` is visible in the control row with `aria-expanded="false"`.
- `#appMenuBackdrop` is hidden.
- `#appMenuDrawer` is hidden.
- `body.appMenuOpen` is not present.

Open behavior:

1. Click `#appMenuButton`.
2. Sync the Settings toggles from the current URL preferences.
3. Unhide `#appMenuBackdrop` and `#appMenuDrawer`.
4. Add `body.appMenuOpen` to prevent background scrolling.
5. Set `#appMenuButton[aria-expanded="true"]`.
6. Move focus into the drawer, preferring `#appMenuCloseButton`.

Close behavior:

- Click `#appMenuCloseButton`.
- Click `#appMenuBackdrop`.
- Press `Escape` while the drawer is open.

Closing hides the drawer and backdrop, removes `body.appMenuOpen`, sets `#appMenuButton[aria-expanded="false"]`, and restores focus to the element that opened the drawer when it is still connected.

Keyboard behavior:

- `Tab` and `Shift+Tab` stay inside the open drawer.
- `Escape` closes the drawer before it can reach the fullscreen image viewer handler.
- The drawer has `role="dialog"`, `aria-modal="true"`, and `aria-labelledby="appMenuTitle"`.

Settings:

- **Assistant subtitles** toggles the page URL between `spokenSubtitles=1` and `spokenSubtitles=0`, deleting any snake_case duplicate parameter.
- **User transcript lane** toggles the page URL between `userTranscriptSubtitles=1` and `userTranscriptSubtitles=0`, deleting any snake_case duplicate parameter.
- These controls affect the URL override that `realtimeSessionUrl()` forwards on the next `/session` call. They do not edit server environment defaults.
- With no URL override present, both toggles render unchecked because the documented server defaults are disabled.

About:

- Shows OpenAI Realtime API voice credit.
- Shows TMDb API attribution.
- States that search and detail answers are grounded in the Agent BBB movie and TV database.

## Start And Stop Buttons

### Shared Slot

Elements:

- `#startButton`
- `#stopButton`
- parent `.sessionButtonSlot`

Both buttons occupy the same grid cell inside `.sessionButtonSlot`, so only one should be visible at a time. Both are 52px-wide controls. `button[hidden]` uses `display: none`.

### Start Button

Element: `#startButton`

Purpose: starts a Realtime WebRTC microphone session.

Visual:

- Uses a layered lips-and-cross visual made from lips and cross icon text in `.startMicIcon`.
- Green background inherited from the base `button` style.
- 52px minimum width.

Default state after page initialization:

- `sessionRunning = false`
- `textChatInFlight = false`
- empty text input
- Start is visible and enabled.
- If WebRTC or `navigator.mediaDevices.getUserMedia` is unavailable, Start remains visible but disabled and its title/label explains the missing capability.

Visibility and disabled rules are controlled by `updateSessionButtons()`:

```text
startButton.hidden = sessionRunning
startButton.disabled = sessionRunning || realtimeUnavailableReason()
```

Start is visible only when all of these are true:

- no audio session is running

Start is hidden when any of these are true:

- `sessionRunning` is true

Click behavior:

1. Calls `start()`.
2. Sets `manuallyStopped = false`.
3. Marks the conversation active, which reveals the New conversation button.
4. Sets `sessionRunning = true`, causing Start to hide and Stop to show.
5. Sets status to `Requesting microphone`, or `Reconnecting` for reconnects.
6. Requests a wake lock when available.
7. Verifies WebRTC and `getUserMedia` support.
8. Creates `RTCPeerConnection`.
9. Creates the `oai-events` data channel.
10. Requests microphone capture.
11. Adds the local microphone audio track to the peer connection.
12. Creates an SDP offer.
13. Calls `/session`.
14. Applies the SDP answer.

Start error behavior:

- If start fails, the click handler sets `sessionRunning = false`, shows `Start failed`, `Voice not supported here`, or `Microphone permission denied`, and logs the detailed failure.
- If the error appears to be microphone permission denial, it logs a specific permission message and shows `Microphone permission denied`.
- After `sessionRunning = false`, Start reappears unless Realtime voice is unsupported.

### Stop Button

Element: `#stopButton`

Purpose: manually stops a Realtime WebRTC microphone session.

Visual:

- Uses the lips icon text from `index.html`.
- Green background matching the Start control.
- 52px minimum width.

Default state:

- Hidden and disabled after page initialization.

Visibility and disabled rules are controlled by `updateSessionButtons()`:

```text
stopButton.hidden = !sessionRunning
stopButton.disabled = !sessionRunning
```

Stop is visible and enabled only while `sessionRunning` is true.

Click behavior:

1. Calls `stop()`.
2. Sets `manuallyStopped = true`.
3. Clears reconnect timers.
4. Releases the wake lock.
5. Closes the data channel and peer connection.
6. Stops local microphone tracks.
7. Clears active response IDs and tool/microphone gate counters.
8. Clears handled Realtime function call IDs.
9. Clears pending reconnect resume data.
10. Sets `sessionRunning = false`.
11. Sets status to `Idle`.

Important distinction:

- Stop ends audio transport only.
- Stop does not clear the visible results panel.
- Stop does not clear retained context.
- New conversation is the control that clears the UI and retained context.

## Microphone Toggle

Element: `#microphoneToggleButton`

Purpose: manually opens or closes microphone input during a running Realtime WebRTC session. When no Realtime session is running and the text box is empty, the same control starts and stops idle dictation for text-mode answers.

Visual:

- Sits immediately to the right of the Start/Stop slot in its own 52px slot.
- Uses the same green button background and 52px icon-control style as the microphone session controls.
- Shows `👂🏻` when the microphone is open.
- Shows `👂🏻` with `❌` layered over it when the microphone is closed.

State:

- `userMicrophoneOpen` stores the user's manual microphone preference during Realtime sessions.
- The toggle is disabled during Realtime sessions while no local microphone track exists.
- When no audio session is running, the control displays the closed state unless idle dictation is recording.
- Idle dictation is available only when the browser supports `getUserMedia`, `MediaRecorder`, and the question input is empty.
- While idle dictation is active, the control displays the open state; clicking it stops the recording and submits it for transcription.
- While idle dictation audio is being transcribed or `/text-chat` is in flight, the control is disabled.
- The app can still temporarily mute the microphone while tool output or assistant audio is pending; those automatic gates do not flip `userMicrophoneOpen`.

Click behavior:

Realtime session:

1. Does nothing until a session is running and a local microphone track exists.
2. Toggles `userMicrophoneOpen`.
3. Calls `syncMicrophone("manual microphone toggle")`.
4. Updates the local audio track's `enabled` state through `setMicrophoneEnabled()`.

Idle dictation:

1. Starts microphone capture with `MediaRecorder`.
2. Sets status to `Dictation listening`.
3. Auto-stops after detected speech followed by silence, no speech for the no-speech timeout, the max duration cap, or a second click.
4. Sends the audio blob to `/transcribe`.
5. Sends the returned transcript to `/text-chat` and renders text-mode results.

## Look Toggle

Element: `#lookToggleButton`

Purpose: toggles the browser UI's Look state. This is currently visual state management only; it does not start a camera or vision request.

Visual:

- Sits immediately to the right of the microphone toggle in its own 52px slot.
- Uses the same green button background and 52px icon-control style as the microphone controls.
- Shows the eye icon when Look is on.
- Shows the eye icon with a cross layered over it when Look is off.

State:

- `userLookOpen` starts as `false`.
- The initial state is Look Off.
- The button remains enabled in all current app states.
- `aria-pressed` mirrors `userLookOpen`.
- The title and accessible label are `Look Off` when off and `Look On` when on.

Click behavior:

1. Toggles `userLookOpen`.
2. Calls `updateLookToggle()`.
3. Logs `look_toggle` through client diagnostics.

## Text Entry

Elements:

- `.questionComposer`
- `#questionInput`
- `#submitQuestionButton`

Purpose: submits typed questions either through an active connected Realtime session for spoken answers, or through `/text-chat` for text-only answers, and renders tool results in the same results area used by voice.

Visual:

- Multiline `textarea`.
- Placeholder: `Type a question`.
- Minimum height: 42px.
- Maximum height: 180px.
- Grows vertically with content until max height, then scrolls internally.
- `.questionComposer` flexes to fill remaining width in the control row and keeps the textarea and submit button together when the row wraps.
- The textarea flexes to fill remaining space inside `.questionComposer`.
- The submit button appears immediately to the right of the textarea as a round white control with a black up arrow.

Default state:

- Empty.
- Visible.
- Enabled. The code does not disable the textarea during audio or text requests.
- Submit button hidden while the textarea is empty.

Input synchronization:

`syncQuestionInputUi()` runs on `input`, `change`, `keyup`, `paste`, and `cut`.

It does three things:

- Resizes the textarea using `scrollHeight`, capped by CSS `max-height`.
- Shows `#submitQuestionButton` when the trimmed input is non-empty and hides it when the input is empty or whitespace-only, including after paste and cut operations.
- Calls `updateSessionButtons()` immediately and again on a zero-delay timer.

Start-button interaction:

- Typing text does not hide or disable the Start button.
- Start remains available while text is present so the user can switch into the Realtime voice path without clearing the text box.

Keyboard rules:

- `Enter` submits the typed question.
- Clicking the visible up-arrow submit button submits the typed question using the same path as `Enter`.
- `Shift+Enter` inserts a newline.
- `Enter` is ignored during IME composition.
- Empty or whitespace-only text does not submit.

Submit behavior in `sendTextMessage()`:

1. Reads `questionInput.value.trim()`.
2. Returns immediately if the trimmed value is empty.
3. If a Realtime session is running, enters the typed Realtime path, regardless of whether microphone input is open or manually closed.
4. If that session is still opening and its data channel is not open yet, queues the typed turn and sends it when the channel opens; queued text is not added to retained context until it is sent.
5. Once the data channel is open, sends `response.cancel` when a Realtime response is still generating, and sends `output_audio_buffer.clear` when its spoken audio is playing.
6. Sends the typed message as an `input_text` conversation item followed by `response.create`.
7. Keeps the audio session connected so the new response plays through the remote audio stream.
8. Otherwise, if a Realtime response is active on an open data channel, sends `response.cancel`; if any audio connection objects exist (`pc`, `dc`, or `localStream`), calls `stop()`.
9. For the `/text-chat` path, sets `textChatInFlight = true`; Start remains visible unless a Realtime session is running.
10. Clears and resizes the textarea, hides the submit button, saves the submitted text as `lastUserTranscript`, and adds it to retained context.
11. For the Realtime typed path, sets status to `Connecting for voice reply` while queued and `Thinking` once sent; for the `/text-chat` path, sets status to `Thinking in text`.
12. For the `/text-chat` path, calls `/text-chat`.

Realtime typed response behavior:

- Available from the time the audio session starts, whether microphone input is open or manually closed; turns submitted before the data channel opens are queued for Realtime delivery, and multiple queued turns are inserted before one response is requested.
- Interrupts any current spoken answer immediately before submitting the new typed turn.
- Uses the same Realtime conversation, tool calls, rendered tool results, spoken response playback, and retained-context handling as spoken turns.
- Does not set `textChatInFlight` or stop the active audio transport.

`/text-chat` response success:

- Each returned `query_text2sql` tool output renders through `renderText2SqlResult()`.
- Each returned entity detail tool output renders through `renderEntityDetailOutput()`.
- Returned tool outputs are added to retained context so follow-up turns can refer to the latest search or entity detail.
- A generic verbose follow-up such as `tell me more` can reuse the latest retained entity detail context and request a longer Wikipedia-grounded answer for that turn.
- Returned assistant text is added to retained context.
- Returned assistant text is also shown through the subtitle overlay.
- Status becomes `Text response` with live dot.
- `textChatInFlight` is set back to false.
- Start remains visible after `/text-chat` completes unless a Realtime session is running or Realtime voice is unsupported.

`/text-chat` response failure:

- Subtitle overlay shows `Text response failed: ...`.
- Status becomes `Text error` with error dot.
- Error is logged.
- `textChatInFlight` is set back to false.

## Idle Dictation

Elements:

- `#microphoneToggleButton`
- Browser `MediaRecorder`
- Local `POST /transcribe`
- Local `POST /text-chat`

Purpose: lets the user speak a text-mode question without starting the Realtime WebRTC voice session.

Availability:

- No Realtime session is running.
- The question box is empty.
- No `/text-chat` response is in flight.
- The browser exposes `navigator.mediaDevices.getUserMedia`.
- The browser exposes `MediaRecorder`.

Flow:

1. Clicking the closed microphone toggle starts dictation.
2. The Start button remains visible while dictation is active or transcribing.
3. The status becomes `Requesting microphone`, then `Dictation listening`.
4. The recorder captures browser microphone audio in a supported format, preferring WebM/Opus.
5. The recorder auto-stops after speech followed by silence, no detected speech for the no-speech timeout, the max duration cap, or a second microphone-toggle click.
6. The status becomes `Transcribing speech`.
7. The browser posts the raw audio blob to `/transcribe`.
8. If the transcript is non-empty, the browser submits that transcript through the same `/text-chat` path as typed text, with log source `dictation`.
9. If no transcript is returned, the status becomes `No speech detected` and the subtitle overlay reports that no question was heard.

## Status Panel

Element: `.status`, containing:

- `#statusDot`
- `#statusText`

Purpose: reports coarse connection, listening, thinking, response, and error state.

Default state:

- Visible.
- Text: `Idle`.
- Dot: neutral gray.

Results mode:

- The entire status row is hidden when `.panel.resultsMode` is active.
- This means status is not visible whenever result or detail content is visible.
- The underlying status text and dot classes still update while hidden.

Status API:

```text
setStatus(text, state = "idle")
```

`setStatus()` always updates the text. It sets dot classes as follows:

- `state === "live"` adds `.live` and removes `.error`.
- `state === "error"` adds `.error` and removes `.live`.
- any other state removes both `.live` and `.error`.

Dot colors:

- neutral: gray
- live: green
- error: red

Known status texts and transitions:

- `Idle`: initial page state, after Stop, after New conversation.
- `Requesting microphone`: immediately after starting a new audio session.
- `Creating Realtime call`: after local SDP offer creation and before `/session` completes.
- `Connecting for voice reply`: after text is submitted during Realtime connection setup and before its data channel opens.
- `Connected`: when the data channel opens, after `response.done`, and after self-healed reconnect.
- `Listening`: on `input_audio_buffer.speech_started`, unless microphone input is currently gated by tool work.
- `Thinking`: on `input_audio_buffer.committed`, or after a typed turn is sent through an active Realtime session.
- `Responding`: on `response.created`.
- `Error`: on Realtime error events, except `conversation_already_has_active_response`.
- `Reconnecting`: during scheduled reconnect attempts.
- `Disconnected`: when reconnects are abandoned or reconnect fails.
- `Thinking in text`: after `/text-chat` question submit.
- `Text response`: after `/text-chat` response success.
- `Text error`: after `/text-chat` response failure.
- `Realtime text error`: if a typed Realtime turn cannot be fully sent because its data channel closes.
- `Dictation listening`: while idle microphone dictation is recording.
- `Transcribing speech`: after idle dictation recording stops and before the transcript is submitted to `/text-chat`.
- `No speech detected`: when idle dictation produced no usable transcript.
- `Dictation error`: when recording or transcription fails.

Status visibility rule summary:

```text
status visible = resultsPanel.hidden
status hidden = !resultsPanel.hidden
```

## Launch Showcase

Element: `#launchShowcase`, a `<section>` created by `app.js` and inserted into `.panel` immediately after the status row (outside `#resultsPanel`, so it does not trigger compact results mode and the header/status stay visible).

Purpose: at launch, while there is no user query, fills the main content area with an auto-scrolling wall of suggested sample questions and their result previews.

Default state: `hidden`. Populated by `maybeShowLaunchShowcase()`, which runs once on page load and again at the end of `startNewConversation()`.

Population and visibility:

- `maybeShowLaunchShowcase()` no-ops when `launchShowcaseDismissed` is true, when `resultsPanel.hidden === false`, or when `sessionRunning` or `textChatInFlight` is true.
- If `launchShowcaseData` is already cached, it renders and unhides `#launchShowcase` immediately. Otherwise it fetches `GET /tool/samples?ui_language=...` (defaults to English, `en`, since there is no user query to detect a language from). On success it caches the categories, renders, and unhides `#launchShowcase`. On any failure it silently leaves the showcase hidden.
- Content: a `.showcaseViewport` containing a few stacked `.showcaseLane` rows, each holding a `.showcaseLaneTrack` of `.showcaseGroup` blocks. Each group is a `.showcaseQuestion` chip (a button) followed inline by standard `.search-poster-card` cards (or a `.showcaseScalar` value for scalar previews). Each lane's groups are rendered twice so the marquee wraps seamlessly. Only samples whose `simulated_result` has renderable rows are shown, round-robined across top-level categories and then distributed across lanes.
- The `.showcaseQuestion` chip uses `white-space: pre-line` with an 8-line clamp: short questions stay on one line, long questions wrap to multiple lines, and multi-line questions keep their newline breaks (carriage returns are normalized to `\n` in `buildShowcaseGroup`). The full text is always available via the chip's `title` tooltip.

Motion:

- `startShowcaseMarquee()` drives a continuous leftward `translateX` on each lane's track via `requestAnimationFrame` (id stored in `launchShowcaseRaf`), wrapping after one copy's width, so cards enter from the right, cross the screen, and exit on the left. Lanes run at slightly different speeds.
- The marquee pauses on pointer hover over the viewport and while `document.hidden` is true.
- Under `prefers-reduced-motion: reduce`, `startShowcaseMarquee()` returns without animating and each lane becomes `overflow-x: auto` (static, manually scrollable).

Interaction and dismissal:

- Clicking a `.showcaseQuestion` calls `runShowcaseQuestion()`, which dismisses the showcase, sets `questionInput.value`, and calls `submitQuestion()` — running it as a normal typed query. Clicking a poster card opens that entity's detail page like any result card.
- `dismissLaunchShowcase()` cancels the animation frame, sets `launchShowcaseDismissed = true`, and hides/empties the section. It is called on the first non-empty `questionInput` input event, on `start()` (voice session), and at the top of `renderText2SqlResult()`, `renderEntityDetailOutput()`, and `showRecordDetail()`.
- Once dismissed, the showcase stays hidden for the rest of the session. `startNewConversation()` resets `launchShowcaseDismissed` to false and calls `maybeShowLaunchShowcase()` again, so the full reset returns to the launch state with the showcase. If samples were already loaded earlier in the page lifetime, this uses the cached sample data and renders immediately.

## Answer And Results Panel

Element: `#resultsPanel`

Children:

- `#resultsContent`
- `#resultsLoader`
- `#loadMoreButton`
- `#resultsEnd`

Purpose: hosts text2sql answers, result cards, entity detail pages, loading placeholders, pagination state, and errors.

Default state:

- `hidden`.
- Empty `#resultsContent`.
- Loader hidden.
- Load more button hidden.
- End marker hidden.

Global results-mode effect:

- A `MutationObserver` watches the `hidden` attribute on `#resultsPanel`.
- When the results panel becomes visible, `.panel.resultsMode` is added.
- When the results panel becomes hidden, `.panel.resultsMode` is removed.
- Results mode hides the app header and status row.

### Loading Search Results

`setLoadingResults(query)` is called when the Realtime model calls `query_text2sql`.

It:

- marks the conversation active
- shows `#resultsPanel`
- clears previous results
- hides loader, Load more, and end marker
- clears current pagination state
- resets loading flags
- renders one `.answerBlock`

Loading answer text:

- `Searching: {query}` if a query string exists.
- `Searching...` otherwise.

### Text2SQL Answer Block

Created by `renderText2SqlResult()` for search output.

Element: `.answerBlock`

Content:

- `.answerText`: answer text from `output.answer`, `upstream.answer`, or `Results for: {query}`.
- optional `.errorText`: rendered if `output.error` or `upstream.error` exists.
- optional `.queryDetailsToggle`: rendered only when at least one query-detail string exists.
- global `#queryDetailsDock`: inserted after the answer block when a toggle exists.

Query details content is assembled from:

- upstream justification
- SQL query
- total processing time

Query details toggle states:

- Closed: `aria-expanded="false"`, right-pointing triangle text.
- Open: `aria-expanded="true"`, up-pointing triangle text.
- Opening one toggle closes all other query details toggles.
- Closing hides and clears `#queryDetailsDock`.

### Search Result Cards

For multi-row text2sql results:

- Results render inside `.search-poster-results`.
- Cards render inside `.search-poster-card-grid`.
- Supported entity rows become poster/result cards.
- Supported entity IDs include `ID_MOVIE`, `ID_SERIE`, composite season keys (`ID_SERIE` plus `SEASON_NUMBER` on an `ID_SEASON` row), composite episode keys (`ID_SERIE`, `SEASON_NUMBER`, and `EPISODE_NUMBER` on an `ID_EPISODE` row), `ID_PERSON`, `ID_COMPANY`, `ID_NETWORK`, `ID_T2S_COLLECTION`, `ID_TOPIC`, `ID_T2S_LIST`, `ID_MOVEMENT`, `ID_TECHNICAL`, `ID_GROUP`, `ID_DEATH`, `ID_AWARD`, `ID_NOMINATION`, and `ID_WIKIDATA`.
- Aggregate rows become aggregate cards.
- Company and network cards asynchronously upgrade their visual to the padded 2:3 logo master (`applySyntheticLogo()`): the deterministic master URL is probed off-screen and swapped in only on a successful load, so the raw TMDb logo — or the text fallback tile when the row has no `LOGO_PATH` — remains until the master exists. No layout shift occurs; only the `img` src (or fallback replacement) changes.
- If no displayable rows exist, the grid shows `No displayable rows.`
- Every card gets an internal `data-result-index` attribute matching its 1-based position in the current grid.
- Supported poster/detail cards also store normalized title text for spoken-card matching; the title is not displayed as a badge.
- When assistant subtitles or Realtime output-audio transcript deltas enumerate a visible card by number, simple ordinal word, or visible card title, `setActiveSpokenCard()` adds `.isSpokenActive` to the matching card and removes that class from the previous card.
- While a card is active, the grid gets `.hasSpokenActive`; inactive sibling cards are dimmed and the active card receives a cyan outline/glow.
- The active card is scrolled into view with `scrollIntoView({ block: "nearest", inline: "nearest" })`.
- Subtitle chunks without a fresh card reference keep the current highlight until another card is referenced or subtitle playback ends.
- Realtime `focus_result_card` tool calls highlight the requested visible card immediately when structured card focus is active. Realtime output-audio transcript deltas and final transcripts still enqueue fallback card-reference cues; the app starts playing those cues when `output_audio_buffer.started` arrives, estimating their timing from the reference position in the transcript so the UI does not jump to the final card before audio playback reaches it.
- The spoken-card highlight is cleared when subtitle playback ends, audio output stops, a new Realtime response starts, results are replaced, or the conversation is cleared.

### Realtime Spoken-Answer Highlight Sync

Purpose: keep search-result card highlighting close to the audible Realtime answer without letting final transcript events jump the UI ahead of speech playback.

Important limitation:

- The Realtime events used here do not provide per-word audio timestamps to the client.
- The sync is therefore paced from transcript text position and audio playback start, not sample-accurate audio timing.
- This is different from subtitles: subtitle-card highlighting is exact to the displayed subtitle chunk because `showNextSubtitle()` applies the highlight when the chunk appears.

Realtime input events:

- `response.created` calls `resetSpokenAudioHighlightState()`, clearing previous cues, timers, transcript buffer, and the current card highlight.
- `response.output_audio_transcript.delta` and `response.audio_transcript.delta` append text to `assistantSpokenHighlightBuffer`.
- `response.output_audio_transcript.done` stores the full assistant transcript in retained context, replaces `assistantSpokenHighlightBuffer` with the final transcript, and enqueues cues from that final text.
- `output_audio_buffer.started` starts cue playback by setting `spokenAudioHighlightPlaying = true` and `spokenAudioHighlightStartedAt = Date.now()`.
- `output_audio_buffer.stopped` calls `resetSpokenAudioHighlightState()`, clearing timers, cues, buffer, and highlight.

Structured focus path:

- New Realtime sessions default to structured card focus unless the server has `ENABLE_STRUCTURED_CARD_FOCUS=false` or the page URL contains `?structuredCardFocus=0`.
- The browser sends the URL override to `/session` as `structured_card_focus=0` or `1`.
- `/session` returns `X-Structured-Card-Focus`; the browser stores this in `structuredCardFocusActive`.
- When active, `query_text2sql` tool output sent back to the model includes `visible_results`, a compact list of visible result-card indexes and titles.
- If the model calls `focus_result_card`, `handleFunctionCall()` highlights the requested visible card immediately, sends a small `function_call_output`, and creates the next Realtime response so spoken output can continue.
- If structured focus is disabled for the session, the tool is not included in the Realtime session config. Transcript-derived cue matching below remains the fallback behavior.

Cue detection:

1. `spokenCardMatchesFromText(text)` scans the transcript buffer for visible-card references.
2. It recognizes numeric references such as `1.`, `2:`, `card 3`, `result 4`, and `#5`.
3. It recognizes ordinal and spoken-number references such as `first`, `second`, `movie one`, or `option two`.
4. It recognizes visible card titles by comparing normalized transcript text with each card's hidden normalized title metadata.
5. It also stores a title key without a leading article, so `The Matrix` can match either `the matrix` or `matrix`.
6. Every match becomes a cue shaped like `{ index, position }`, where `index` is the card's internal 1-based `data-result-index` and `position` is the character position of the reference in the normalized transcript.
7. Cues are deduplicated with the key `index:Math.round(position / 8)` so repeated parsing of growing transcript deltas does not enqueue the same reference repeatedly.
8. Cues are sorted by transcript position, then card index.

Cue timing:

```text
dueMs = spokenAudioHighlightInitialDelayMs + cue.position * spokenAudioHighlightMsPerChar
delayMs = max(spokenAudioHighlightMinDelayMs, dueMs - elapsedMs)
```

Current constants:

```text
spokenAudioHighlightInitialDelayMs = 450
spokenAudioHighlightMsPerChar = 52
spokenAudioHighlightMinDelayMs = 80
```

Playback behavior:

1. Cue playback does not start merely because a transcript delta or final transcript arrives.
2. Cue playback starts only after `output_audio_buffer.started`.
3. `scheduleNextSpokenAudioHighlightCue()` looks at the first queued cue and schedules a timer using the formula above.
4. When the timer fires, the cue is removed from the queue and `setActiveSpokenCard(cue.index)` highlights that card.
5. `setActiveSpokenCard()` clears the previous active card before adding `.isSpokenActive` and `aria-current="true"` to the next card.
6. The next cue is scheduled after the current cue fires.

Late result rendering:

- If Realtime transcript text arrives before cards exist, there may be no cue matches yet.
- After `renderText2SqlResult()` renders cards, it checks whether `assistantSpokenHighlightBuffer` already has text.
- If so, it calls `enqueueSpokenAudioHighlightCues(assistantSpokenHighlightBuffer)` so title/number matches can be discovered once the card metadata exists.

Practical accuracy:

- The cue order is deterministic and follows transcript order.
- The timing is an estimate based on average character pace from audio playback start.
- It prevents the most obvious bad behavior: a complete final transcript selecting the last mentioned card before the voice has reached it.
- It can still drift if the spoken response has pauses, unusually fast or slow delivery, or transcript text that differs materially from audible phrasing.

For exactly one row:

- The app renders a single detail-style record result instead of a grid.
- Pagination controls are refreshed afterward.

Card click behavior:

- Cards with supported entity IDs open in-app detail pages.
- Clicked detail fetches carry the active `ui_language` from the current result page; direct detail tool calls use the detected language from the latest user audio transcript or typed message.
- Opening a detail page replaces the results content.
- Detail page entries are pushed into page history unless restoring history.

### Entity Detail Loading

`setLoadingEntityDetail(toolName, args)` is called when a Realtime entity-detail tool call starts.

It:

- marks the conversation active
- shows the results panel
- clears query details
- clears previous content
- hides loader, Load more, and end marker
- clears search pagination state and any previous detail pagination state
- renders a detail placeholder with title `Loading details...`

### Entity Detail Output

`renderEntityDetailOutput(output, args)` handles entity-detail tool responses.

It:

- marks the conversation active
- shows the results panel
- clears query details
- clears previous content
- hides loader, Load more, and end marker
- clears pagination state

If `output.error` exists:

- renders a detail page titled `Unable to load details`
- displays the error

If no detail object exists:

- renders a detail page titled from the entity label or `Details`
- displays `No detail record returned.`

If detail exists:

- renders the entity detail page
- stores the full detail record, detail args, `ui_language`, and upstream `pagination` map as the current detail state
- does not render `wikipedia_content` sections; that collection is reserved for model grounding when answering entity-detail questions
- preserves `ID_WIKIDATA` from args when needed
- series detail pages render returned `seasons` as a clickable `Seasons` rail above the `Cast` rail, injecting the parent `ID_SERIE` needed by the composite season route
- season detail pages render parent-series navigation and metrics, then a clickable `Episodes` rail from returned `episodes` summaries above the `Cast` rail, followed by crew; each episode card inherits the season composite route context and opens its full episode page
- episode detail pages render parent-series and parent-season navigation, metrics, cast, crew, and returned still-image cards
- technical detail pages use localized `DESCRIPTION` as the title, show `TECHNICAL_TYPE` as a type metric, and render associated `movies` plus same-type `siblings` as clickable rails when returned
- company and network detail pages asynchronously swap their main logo visual to the padded 2:3 master (`applySyntheticLogo()`) when the deterministically derived URL loads; embedded `Companies`/`Networks` relation rails on any detail page apply the same upgrade per rail item, keyed on the item's `ID_COMPANY`/`ID_NETWORK`. On 404 the raw TMDb logo or text fallback stays

### Entity Detail Rail Pagination

Entity detail pages can paginate embedded relation rails independently from search results.

State:

- `currentDetailState`: stores the active detail tool, base detail args, current detail record, `ui_language`, per-collection errors, and render container.
- `loadingDetailCollections`: tracks collection names currently loading a targeted next page.

Rail behavior:

- Rails are paginatable only when the current detail record has `pagination[collectionName]`.
- The rail header shows `{loaded} of {total}` when pagination metadata is available.
- There is no rail-level `More` button.
- When the user scrolls or slides close to the right edge of a paginatable rail, the UI automatically calls the same local detail route with `collection`, `page + 1`, `rows_per_page`, and `ui_language`.
- The targeted response is merged into the existing detail record's matching array.
- The matching `pagination[collectionName]` entry is updated from the targeted response.
- The existing rail DOM is updated in place: the count/error state changes in the rail header, and returned cards are appended to the right edge of the current rail.
- Loading additional rail items does not rerender the current detail page or replace existing rail cards, and the rail's current horizontal position is left unchanged.
- If a rail load fails, automatic retry is suppressed until the user scrolls that rail again near the right edge.
- If the user navigates away while a collection page is loading, the response is ignored.
- If the request fails, the rail shows `Load failed`; the tooltip contains the error detail.
- Search pagination controls (`#resultsLoader`, `#loadMoreButton`, `#resultsEnd`) remain hidden on detail pages.

### Pagination Loader, Load More, And End Marker

Elements:

- `#resultsLoader`
- `#loadMoreButton`
- `#resultsEnd`

State is controlled by `refreshPaginationControls()`.

When there are no more results:

- loader hidden
- Load more hidden
- end marker hidden if no cards are loaded
- end marker visible with `No more results ({count} retrieved)` if cards are loaded

When more results exist:

- end marker hidden
- loader visible only while `loadingMore === true`
- loader text: `Loading more ({count} retrieved)`
- Load more hidden while loading
- Load more hidden while `autoPagesLoaded < maxAutoPages`
- Load more visible after automatic loading reaches `maxAutoPages`
- Load more text: `Load more ({count} retrieved)`

Automatic pagination:

- `maybeLoadNextPage()` runs on window scroll and resize.
- It does nothing if there is no current search state, no more results, already loading, or automatic load count reached `maxAutoPages`.
- It preloads when the bottom of `#resultsPanel` is within `max(window.innerHeight, 900)` pixels of the viewport bottom.

Manual pagination:

- Clicking Load more calls `loadNextPage({ isAuto: false })`.
- Manual loads reset `autoPagesLoaded` to 0 after success.

### Results Clearing

`clearConversationUi()` hides and clears the results panel.

It also:

- clears query details
- hides loader, Load more, and end marker
- clears search pagination state
- clears detail pagination state
- clears pending reconnect resume state
- clears last transcript/tool variables
- clears partial input transcripts

`startNewConversation()` calls `clearConversationUi()` and then also clears retained context and page history.

## Assistant Subtitles Panel

Element: `#subtitleOverlay`

Purpose: shows assistant text output as temporary readable captions. It is used for typed assistant responses, typed response errors, and opt-in Realtime voice-mode assistant subtitles when the session has spoken subtitles enabled.

Visual:

- Fixed position.
- Horizontally centered.
- 22px from the bottom.
- Maximum width: `min(860px, calc(100vw - 32px))`.
- Dark translucent background.
- White bold centered text.
- Pointer events disabled.
- High z-index over normal content.
- Preserves intentional subtitle line breaks with `white-space: pre-line`.
- Wraps long words instead of overflowing the overlay.

Default state:

- Hidden.
- Empty text.

Input:

- `showSubtitleText(text)` removes explicit backend/database ID mentions, then normalizes and splits text into chunks.
- `appendRealtimeSpokenSubtitleDelta(delta)` appends Realtime assistant transcript deltas to `realtimeSpokenSubtitleBuffer` when `spokenSubtitlesActive` is true, then rebuilds the stable pending chunk list without rendering immediately.
- `completeRealtimeSpokenSubtitle(transcript)` replaces the buffer with the sanitized final transcript, includes the trailing chunk, and lets the audio-paced queue display any remaining text.
- The cleanup targets phrases such as IMDb IDs, Wikidata IDs, TMDb IDs, TVDB IDs, `ID_*` fields, and entity/database ID labels. Entity cards and detail links carry those identifiers internally, so subtitles use names, titles, and visible result numbers instead.
- Inline numbered items such as `4. The Barefoot Contessa (1954)` are promoted to structural subtitle blocks before chunking.
- Numbered list items are kept as separate chunks when practical so spoken-card highlighting can move from card to card.
- Paragraph chunks prefer sentence boundaries.
- Each chunk targets around 150 characters. Long structural blocks may run longer to avoid orphaned list markers; very long blocks are split into readable pieces.

Display sequence:

1. `subtitleQueue` is replaced with the new chunks.
2. `showNextSubtitle()` clears any existing subtitle timer.
3. The next chunk is shifted from the queue.
4. If no chunk exists, the overlay is hidden, text is cleared, and spoken-card highlighting is cleared.
5. If a chunk exists, the overlay becomes visible and its text is set.
6. If the chunk references a visible result-card number, ordinal, or title, the matching card is highlighted immediately and any previous card highlight is removed.
7. A timer schedules the next chunk.

Duration rule:

```text
duration = max(3500ms, min(12000ms, text.length * 65ms))
```

Visibility rules:

- Visible only while a chunk is actively being displayed.
- Hidden after the queue is exhausted.
- A new call to `showSubtitleText()` replaces any existing queue.
- New conversation clears the current queue, cancels the timer, hides the overlay, and clears any spoken-card highlight.
- Realtime voice-mode subtitle chunks do not render on transcript arrival. They start only after `output_audio_buffer.started`, advance from the audio-start timestamp using the estimated spoken-character pace, keep the last visible chunk while audio is still playing, and hide only after `output_audio_buffer.stopped` plus a short hold.
- Realtime barge-in, a new typed Realtime turn, New conversation, or Realtime output cancellation clears the pending Realtime subtitle chunks and visible voice subtitle.

Known producers:

- typed response success: displays returned assistant text
- typed response failure: displays `Text response failed: ...`
- Realtime voice response transcript deltas and final transcripts, only when `ENABLE_SPOKEN_SUBTITLES=true` or the current session URL override enables spoken subtitles

Voice-mode enablement:

- `ENABLE_SPOKEN_SUBTITLES` defaults to false.
- A page URL can override it for the next Realtime session with `?spokenSubtitles=1`, `?spokenSubtitles=0`, `?spoken_subtitles=1`, or `?spoken_subtitles=0`.
- The App Menu **Assistant subtitles** toggle writes the camelCase URL override.
- The browser forwards the override to `/session` as `spoken_subtitles=0` or `1`.
- `/session` returns `X-Spoken-Subtitles`; the browser stores the value in `spokenSubtitlesActive`.
- When a Realtime `response.created` event arrives, the browser clears the previous Realtime subtitle buffer and, if spoken subtitles are active, hides any previous visible assistant subtitle before the new answer begins.
- `output_audio_buffer.started` switches `realtimeSpokenSubtitlePlaying` on and starts scheduling chunks from the audio clock. `output_audio_buffer.stopped` switches it off, flushes the final chunk if needed, and then hides the overlay after the hold time.

## User Transcript Subtitle Lane

Element: `#userSubtitleOverlay`

Purpose: shows the completed Realtime voice input transcript as a temporary top user subtitle lane. It is distinct from the assistant-only `#subtitleOverlay`.

Visual:

- In-panel lane below the status row and above the results/audio area.
- Centered with maximum width `min(860px, 100%)`.
- Amber accent border and dark translucent background.
- Bold centered text.
- Pointer events disabled.
- Preserves intentional line breaks with `white-space: pre-line`.
- Wraps long words instead of overflowing.

Default state:

- Hidden.
- Empty text.

Input:

- `conversation.item.input_audio_transcription.completed` stores non-empty text in `lastUserTranscript`.
- The same event calls `showUserSubtitleText(lastUserTranscript)` when `userTranscriptSubtitlesActive` is true.
- The lane normalizes whitespace but otherwise shows what the transcription returned.

Duration rule:

```text
duration = max(3500ms, min(9000ms, text.length * 55ms))
```

Voice-mode enablement:

- `ENABLE_USER_TRANSCRIPT_SUBTITLES` defaults to false.
- A page URL can override it for the next Realtime session with `?userTranscriptSubtitles=1`, `?userTranscriptSubtitles=0`, `?user_transcript_subtitles=1`, or `?user_transcript_subtitles=0`.
- The App Menu **User transcript lane** toggle writes the camelCase URL override.
- The browser forwards the override to `/session` as `user_transcript_subtitles=0` or `1`.
- `/session` returns `X-User-Transcript-Subtitles`; the browser stores the value in `userTranscriptSubtitlesActive`.
- New conversation and subtitle cleanup hide the lane and clear its active timer.

## History Buttons

Elements:

- `#historyBackButton`
- `#historyForwardButton`

Purpose: navigate among rendered search pages and entity/detail pages within the results panel.

Default state:

- Both visible.
- Both disabled.

Enabled rules from `updateHistoryButtons()`:

```text
Back disabled = pageHistoryIndex <= 0
Forward disabled = pageHistoryIndex < 0 || pageHistoryIndex >= pageHistory.length - 1
```

History entries are pushed for:

- text2sql search pages
- single record detail pages opened from results
- entity detail tool outputs

History is not pushed while restoring history.

Click behavior:

- Back calls `goHistory(-1)`.
- Forward calls `goHistory(1)`.
- The selected history entry is re-rendered with `skipHistory: true`.

New conversation behavior:

- Clears all page history.
- Disables both buttons.

## New Conversation Button

Element: `#newConversationButton`

Purpose: resets the visible conversation, retained context, page history, active audio connection, and any assistant output currently playing or queued.

Default state:

- Hidden.

Visibility:

- Controlled by `setConversationActive(active)`.
- Hidden when `active` is false.
- Visible when `active` is true.

The app marks the conversation active when:

- Start is clicked and `start()` begins.
- Search results start loading.
- Entity details start loading.
- Results or detail output renders.
- A single record detail page opens.

Click behavior:

1. Sets `manuallyStopped = true`.
2. Clears queued Realtime typed turns.
3. Cancels idle dictation.
4. Clears subtitle output, including the assistant queue, assistant timer, user transcript lane, and user transcript timer.
5. Aborts any in-flight `/text-chat` request so stale text output cannot render after reset.
6. Sends Realtime `response.cancel` and `output_audio_buffer.clear` when a response or output audio is active.
7. Clears the remote audio element and active spoken-card highlight.
8. Clears reconnect timers.
9. Releases wake lock.
10. Cleans up the audio connection.
11. Clears the results UI.
12. Clears retained context.
13. Hides itself.
14. Clears page history.
15. Sets `sessionRunning = false`.
16. Sets status to `Idle`.

## Hidden Audio Element

Element: `#remoteAudio`

Purpose: plays remote model audio output from the WebRTC peer connection.

Attributes:

- `autoplay`

Visibility:

- No visible UI is rendered for this element.

Runtime behavior:

- When a remote track arrives, `remoteAudio.srcObject` is set to the first remote stream.
- Diagnostics are logged for audio element events such as `play`, `playing`, `pause`, `waiting`, `stalled`, `error`, and related states.

## Hidden Log Element

Element: `#log`

Purpose: stores client-side log entries in the DOM.

Default state:

- Hidden.

Runtime behavior:

- `log(label, value)` prepends `.logEntry` nodes.
- The element remains hidden in the current UI.

## Image And Detail Viewer Controls

These controls are created dynamically only for entity/detail pages that contain visual media.

### Portrait, Poster, Logo, Wikipedia Image, And Backdrop Viewers

Generated detail media uses `.personPortraitViewer` and related classes.

Default behavior:

- Normal mode: media is shown inside the detail page.
- Clicking the main portrait, poster, logo, Wikipedia image, or backdrop toggles fullscreen when supported.
- Fullscreen mode adds `.isFullscreen`.
- `body.imageViewerOpen` disables page scrolling.
- Pressing `Escape` closes fullscreen image viewing.

### Detail Media Navigation

For multi-image viewers:

- Previous and next buttons are rendered as `.portraitNav` controls.
- A `.personPortraitCounter` displays current image position.
- Swiping/clicking navigation changes the active image.

### Backdrop Slideshow

For backdrop viewers with slideshow support:

- `.slideshowToggle` appears in the top-right of the viewer.
- It starts or stops a slideshow across available backdrops.
- The control remains visible in normal and fullscreen modes.

## Voice Selection

There is no rendered voice selector in the current `index.html`.

Voice selection is currently server-side:

- `AGENT_VOICE` controls the configured Realtime voice.
- The server validates it against supported values before creating the Realtime session.
- Changing voice requires changing configuration and starting a new session.

If a visible voice selector is added later, this document should be updated with its state, validation, and session-lifecycle rules.

## State Summary

| State | Start | Stop | Mic toggle | Look toggle | Text input | Status row | Results panel | Header | New conversation | Subtitles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fresh page | visible/enabled | hidden | closed/enabled if dictation is supported | off/enabled | visible/enabled/empty | visible, `Idle` | hidden | visible | hidden | hidden |
| Voice unsupported browser | visible/disabled | hidden | closed/enabled for dictation if supported, otherwise disabled | follows user state/enabled | visible/enabled | visible, `Idle` or unsupported error after failed start | hidden | visible | hidden | hidden |
| Text typed, no session | visible/enabled | hidden | closed/disabled | follows user state/enabled | visible/enabled/non-empty | visible | unchanged | depends on results | unchanged | unchanged |
| Idle dictation listening | visible/enabled | hidden | open/enabled | follows user state/enabled | visible/enabled/empty | visible unless results shown, `Dictation listening` | unchanged | depends on results | visible | unchanged |
| Idle dictation transcribing | visible/enabled until `/text-chat` starts | hidden | closed/disabled | follows user state/enabled | visible/enabled/empty | visible unless results shown, `Transcribing speech`, then `Thinking in text` | may update | depends on results | visible | may show after response |
| Starting audio | hidden | visible/enabled | closed until track exists | follows user state/enabled | visible/enabled | visible unless results shown, `Requesting microphone` | unchanged | depends on results | visible | unchanged |
| Audio connected | hidden | visible/enabled | open/enabled unless manually closed | follows user state/enabled | visible/enabled | visible unless results shown, `Connected` | unchanged | depends on results | visible | unchanged |
| Listening | hidden | visible/enabled | open/enabled unless manually closed | follows user state/enabled | visible/enabled | visible unless results shown, `Listening` | unchanged | depends on results | visible | unchanged |
| Thinking/responding by audio | hidden | visible/enabled | follows manual open/closed state | follows user state/enabled | visible/enabled | visible unless results shown, `Thinking` or `Responding` | may become visible if tools run | hidden if results visible | visible | may show top user transcript and bottom assistant transcript when their subtitle flags are active |
| Typed Realtime turn | hidden | visible/enabled | follows manual open/closed state | follows user state/enabled | visible/enabled/cleared | visible unless results shown, `Thinking`, `Responding`, then `Connected` | may become visible if tools run | hidden if results visible | visible | may show bottom assistant transcript when spoken subtitles are active |
| Tool search loading | depends on session/text | depends on session | depends on session/manual state | follows user state/enabled | visible/enabled | hidden | visible with searching answer block | hidden | visible | unchanged |
| Search results visible | depends on session/text | depends on session | depends on session/manual state | follows user state/enabled | visible/enabled | hidden | visible with answer/cards | hidden | visible | unchanged |
| Detail page visible | depends on session/text | depends on session | depends on session/manual state | follows user state/enabled | visible/enabled | hidden | visible with detail page | hidden | visible | unchanged |
| `/text-chat` request in flight | visible/enabled unless Realtime is unsupported | hidden unless audio stop occurred first | closed/disabled unless audio still running | follows user state/enabled | visible/enabled/cleared | visible unless results shown, `Thinking in text` | may update | depends on results | active if results render | may show after response |
| `/text-chat` response complete | visible if input empty and no session | hidden | closed/enabled if dictation is supported and no session | follows user state/enabled | visible/enabled | visible unless results shown, `Text response` | visible if tools returned UI | hidden if results visible | visible if results rendered | visible while chunks play |
| Error | depends on session/text | depends on session | depends on session/manual state | follows user state/enabled | visible/enabled | visible unless results shown, error text | unchanged | depends on results | unchanged | may show text error |
| Stop clicked | visible if input empty | hidden | closed/enabled if dictation is supported | follows user state/enabled | visible/enabled | visible unless results shown, `Idle` | unchanged | depends on results | unchanged | unchanged |
| New conversation clicked | visible | hidden | closed/enabled if dictation is supported | follows user state/enabled | visible/enabled | visible, `Idle` | hidden and cleared | visible | hidden | hidden and timer cleared |

## Implementation Notes For Future Changes

- `updateSessionButtons()` is the single source of truth for Start/Stop visibility and disabled state, and it refreshes the microphone toggle.
- When `sessionRunning` is false, `#microphoneToggleButton` belongs to the idle dictation flow, not the Realtime microphone track.
- `updateLookToggle()` is the source of truth for the Look button's icon, title, and `aria-pressed` state.
- `setStatus()` is the single source of truth for status text and dot color.
- `resultsPanel.hidden` is the trigger for compact results mode.
- `renderText2SqlResult()` owns the answer block, result cards, query details toggle, and search pagination state.
- `renderEntityDetailOutput()` owns entity-detail result states.
- `setActiveSpokenCard()` owns spoken-card highlight exclusivity; call `clearActiveSpokenCard()` before replacing result content.
- `showSubtitleText()` owns assistant subtitle queue replacement and display.
- `showUserSubtitleText()` owns the top user transcript lane display.
- `clearConversationUi()` clears results but does not explicitly clear subtitles.
- `startNewConversation()` is the full UI/context reset path; it calls `cancelAssistantOutput()` before clearing the UI so active audio, in-flight text responses, and subtitle playback stop immediately.
- The text input remains enabled in all current states; changing that would require new explicit disabled-state rules.
