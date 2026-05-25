# UI State Reference

This document describes the current browser UI behavior implemented by `app/static/index.html`, `app/static/app.js`, and `app/static/styles.css`.

The app has one persistent shell, one control row, one status row, one hidden audio element, one results area, one subtitle overlay, and several dynamic controls created by JavaScript. Most visibility is driven by these state variables:

- `sessionRunning`: true while a Realtime WebRTC audio session is considered active.
- `textChatInFlight`: true while a typed question is being processed by `/text-chat`.
- `questionInput.value`: determines whether the typed-question path is active.
- `resultsPanel.hidden`: determines whether result/detail content is visible and whether compact results mode is active.
- `currentSearchState`: stores pagination state for text2sql result pages.
- `loadingMore`: true while another page of text2sql rows is loading.
- `autoPagesLoaded`: counts automatic infinite-scroll page loads before the manual Load more button is shown.
- `pageHistory` and `pageHistoryIndex`: drive Back and Forward button enablement.
- `subtitleQueue` and `subtitleTimer`: drive subtitle overlay visibility and sequencing.
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

- Start/Stop button slot.
- Microphone open/closed toggle slot.
- Back button.
- Forward button.
- Text entry.
- New conversation button.

The row uses flex layout, bottom alignment, 10px gaps, and wrapping when the viewport is narrow.

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
hideStartForText = hasQuestionText() || textChatInFlight
startButton.hidden = sessionRunning || hideStartForText
startButton.disabled = sessionRunning || hideStartForText
```

Start is visible only when all of these are true:

- no audio session is running
- the text input is empty after trimming whitespace
- no text response is in flight

Start is hidden when any of these are true:

- `sessionRunning` is true
- the text input contains non-whitespace text
- a typed question is being processed

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
- After `sessionRunning = false`, Start may reappear if the text input is empty and `textChatInFlight` is false.

### Stop Button

Element: `#stopButton`

Purpose: manually stops a Realtime WebRTC microphone session.

Visual:

- Uses the lips icon text from `index.html`.
- Dark tertiary background.
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

Purpose: manually opens or closes microphone input during a running Realtime WebRTC session.

Visual:

- Sits immediately to the right of the Start/Stop slot in its own 52px slot.
- Uses the same green button background and 52px icon-control style as the microphone session controls.
- Shows `👂🏻` when the microphone is open.
- Shows `👂🏻` with `❌` layered over it when the microphone is closed.

State:

- `userMicrophoneOpen` stores the user's manual microphone preference.
- The toggle is disabled while no local microphone track exists.
- When no audio session is running, the control displays the closed state.
- The app can still temporarily mute the microphone while tool output or assistant audio is pending; those automatic gates do not flip `userMicrophoneOpen`.

Click behavior:

1. Does nothing until a session is running and a local microphone track exists.
2. Toggles `userMicrophoneOpen`.
3. Calls `syncMicrophone("manual microphone toggle")`.
4. Updates the local audio track's `enabled` state through `setMicrophoneEnabled()`.

## Text Entry

Element: `#questionInput`

Purpose: submits typed questions through `/text-chat` and renders tool results in the same results area used by voice.

Visual:

- Multiline `textarea`.
- Placeholder: `Type a question`.
- Minimum height: 42px.
- Maximum height: 180px.
- Grows vertically with content until max height, then scrolls internally.
- Flexes to fill remaining width in the control row.

Default state:

- Empty.
- Visible.
- Enabled. The code does not disable the textarea during audio or text requests.

Input synchronization:

`syncQuestionInputUi()` runs on `input`, `change`, `keyup`, `paste`, and `cut`.

It does two things:

- Resizes the textarea using `scrollHeight`, capped by CSS `max-height`.
- Calls `updateSessionButtons()` immediately and again on a zero-delay timer.

Start-button interaction:

- Any non-whitespace text hides and disables the Start button.
- Removing all text makes Start visible again if no audio session is running and no typed response is in flight.

Keyboard rules:

- `Enter` submits the typed question.
- `Shift+Enter` inserts a newline.
- `Enter` is ignored during IME composition.
- Empty or whitespace-only text does not submit.

Submit behavior in `sendTextMessage()`:

1. Reads `questionInput.value.trim()`.
2. Returns immediately if the trimmed value is empty.
3. If a Realtime response is active on an open data channel, sends `response.cancel` and clears active response IDs.
4. If any audio connection objects exist (`pc`, `dc`, or `localStream`), calls `stop()`.
5. Sets `textChatInFlight = true`, which keeps Start hidden.
6. Clears the textarea.
7. Resizes the textarea back down.
8. Saves the submitted text as `lastUserTranscript`.
9. Adds the user text to retained context.
10. Sets status to `Thinking in text` with live dot.
11. Calls `/text-chat`.

Typed response success:

- Each returned `query_text2sql` tool output renders through `renderText2SqlResult()`.
- Each returned entity detail tool output renders through `renderEntityDetailOutput()`.
- Returned assistant text is added to retained context.
- Returned assistant text is also shown through the subtitle overlay.
- Status becomes `Text response` with live dot.
- `textChatInFlight` is set back to false.
- Start reappears only if the text input remains empty and no audio session is running.

Typed response failure:

- Subtitle overlay shows `Text response failed: ...`.
- Status becomes `Text error` with error dot.
- Error is logged.
- `textChatInFlight` is set back to false.

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
- `Connected`: when the data channel opens, after `response.done`, and after self-healed reconnect.
- `Listening`: on `input_audio_buffer.speech_started`, unless microphone input is currently gated by tool work.
- `Thinking`: on `input_audio_buffer.committed`.
- `Responding`: on `response.created`.
- `Error`: on Realtime error events, except `conversation_already_has_active_response`.
- `Reconnecting`: during scheduled reconnect attempts.
- `Disconnected`: when reconnects are abandoned or reconnect fails.
- `Thinking in text`: after typed question submit.
- `Text response`: after typed response success.
- `Text error`: after typed response failure.

Status visibility rule summary:

```text
status visible = resultsPanel.hidden
status hidden = !resultsPanel.hidden
```

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
- If no displayable rows exist, the grid shows `No displayable rows.`

For exactly one row:

- The app renders a single detail-style record result instead of a grid.
- Pagination controls are refreshed afterward.

Card click behavior:

- Cards with supported entity IDs open in-app detail pages.
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
- clears pagination state
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
- does not render `wikipedia_content` sections; that collection is reserved for model grounding when answering entity-detail questions
- preserves `ID_WIKIDATA` from args when needed
- series detail pages render returned `seasons` as a clickable `Seasons` rail above the `Cast` rail, injecting the parent `ID_SERIE` needed by the composite season route
- season detail pages render parent-series navigation and metrics, then a clickable `Episodes` rail from returned `episodes` summaries above the `Cast` rail, followed by crew; each episode card inherits the season composite route context and opens its full episode page
- episode detail pages render parent-series and parent-season navigation, metrics, cast, crew, and returned still-image cards
- technical detail pages use `DESCRIPTION` / `DESCRIPTION_FR` as the title, show `TECHNICAL_TYPE` as a type metric, and render associated `movies` plus same-type `siblings` as clickable rails when returned

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
- clears pending reconnect resume state
- clears last transcript/tool variables
- clears partial input transcripts

`startNewConversation()` calls `clearConversationUi()` and then also clears retained context and page history.

## Subtitles Panel

Element: `#subtitleOverlay`

Purpose: shows assistant text output as temporary readable captions. It is used for typed assistant responses and typed response errors. It is not currently fed by live audio transcript deltas in `handleServerEvent()`.

Visual:

- Fixed position.
- Horizontally centered.
- 22px from the bottom.
- Maximum width: `min(860px, calc(100vw - 32px))`.
- Dark translucent background.
- White bold centered text.
- Pointer events disabled.
- High z-index over normal content.

Default state:

- Hidden.
- Empty text.

Input:

- `showSubtitleText(text)` normalizes and splits text into chunks.
- Chunks prefer sentence boundaries.
- Each chunk is capped around 150 characters. Longer sentences are sliced into 150-character pieces.

Display sequence:

1. `subtitleQueue` is replaced with the new chunks.
2. `showNextSubtitle()` clears any existing subtitle timer.
3. The next chunk is shifted from the queue.
4. If no chunk exists, the overlay is hidden and text is cleared.
5. If a chunk exists, the overlay becomes visible and its text is set.
6. A timer schedules the next chunk.

Duration rule:

```text
duration = max(3500ms, min(12000ms, text.length * 65ms))
```

Visibility rules:

- Visible only while a chunk is actively being displayed.
- Hidden after the queue is exhausted.
- A new call to `showSubtitleText()` replaces any existing queue.

Known producers:

- typed response success: displays returned assistant text
- typed response failure: displays `Text response failed: ...`

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

Purpose: resets the visible conversation, retained context, page history, and active audio connection.

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
2. Clears reconnect timers.
3. Releases wake lock.
4. Cleans up the audio connection.
5. Clears the results UI.
6. Clears retained context.
7. Hides itself.
8. Clears page history.
9. Sets `sessionRunning = false`.
10. Sets status to `Idle`.

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

| State | Start | Stop | Mic toggle | Text input | Status row | Results panel | Header | New conversation | Subtitles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fresh page | visible/enabled | hidden | closed/disabled | visible/enabled/empty | visible, `Idle` | hidden | visible | hidden | hidden |
| Voice unsupported browser | visible/disabled | hidden | closed/disabled | visible/enabled | visible, `Idle` or unsupported error after failed start | hidden | visible | hidden | hidden |
| Text typed, no session | hidden | hidden | closed/disabled | visible/enabled/non-empty | visible | unchanged | depends on results | unchanged | unchanged |
| Starting audio | hidden | visible/enabled | closed until track exists | visible/enabled | visible unless results shown, `Requesting microphone` | unchanged | depends on results | visible | unchanged |
| Audio connected | hidden | visible/enabled | open/enabled unless manually closed | visible/enabled | visible unless results shown, `Connected` | unchanged | depends on results | visible | unchanged |
| Listening | hidden | visible/enabled | open/enabled unless manually closed | visible/enabled | visible unless results shown, `Listening` | unchanged | depends on results | visible | unchanged |
| Thinking/responding by audio | hidden | visible/enabled | follows manual open/closed state | visible/enabled | visible unless results shown, `Thinking` or `Responding` | may become visible if tools run | hidden if results visible | visible | unchanged |
| Tool search loading | depends on session/text | depends on session | depends on session/manual state | visible/enabled | hidden | visible with searching answer block | hidden | visible | unchanged |
| Search results visible | depends on session/text | depends on session | depends on session/manual state | visible/enabled | hidden | visible with answer/cards | hidden | visible | unchanged |
| Detail page visible | depends on session/text | depends on session | depends on session/manual state | visible/enabled | hidden | visible with detail page | hidden | visible | unchanged |
| Typed request in flight | hidden | hidden unless audio stop occurred first | closed/disabled unless audio still running | visible/enabled/cleared | visible unless results shown, `Thinking in text` | may update | depends on results | active if results render | may show after response |
| Typed response complete | visible if input empty and no session | hidden | closed/disabled | visible/enabled | visible unless results shown, `Text response` | visible if tools returned UI | hidden if results visible | visible if results rendered | visible while chunks play |
| Error | depends on session/text | depends on session | depends on session/manual state | visible/enabled | visible unless results shown, error text | unchanged | depends on results | unchanged | may show text error |
| Stop clicked | visible if input empty | hidden | closed/disabled | visible/enabled | visible unless results shown, `Idle` | unchanged | depends on results | unchanged | unchanged |
| New conversation clicked | visible | hidden | closed/disabled | visible/enabled | visible, `Idle` | hidden and cleared | visible | hidden | existing subtitle timer is not explicitly cleared |

## Implementation Notes For Future Changes

- `updateSessionButtons()` is the single source of truth for Start/Stop visibility and disabled state, and it refreshes the microphone toggle.
- `setStatus()` is the single source of truth for status text and dot color.
- `resultsPanel.hidden` is the trigger for compact results mode.
- `renderText2SqlResult()` owns the answer block, result cards, query details toggle, and search pagination state.
- `renderEntityDetailOutput()` owns entity-detail result states.
- `showSubtitleText()` owns subtitle queue replacement and display.
- `clearConversationUi()` clears results but does not explicitly clear subtitles.
- `startNewConversation()` is the full UI/context reset path.
- The text input remains enabled in all current states; changing that would require new explicit disabled-state rules.
