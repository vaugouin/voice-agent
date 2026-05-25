# Agent Instructions

This file is for agent-facing operating context only. Do not use it as a second README.

## Documentation Boundaries

- `README.md` is the source of truth for project overview, features, setup, install, deploy, human-facing security notes, performance notes, troubleshooting, environment variables, and verification commands.
- `UI.md` is the source of truth for stateful UI behavior: Start/Stop, text entry, answer/results panel, status panel, subtitles, history, New conversation, hidden audio/log elements, and dynamic detail viewer controls.
- `AGENTS.md` should contain only instructions that help future coding agents work safely in this repository.
- Do not duplicate README material here. If you need overview/setup/deploy/troubleshooting context, read `README.md`.
- Do not duplicate UI state tables here. If you need UI visibility, disabled-state, or transition rules, read `UI.md`.
- For any project update, keep documentation aligned:
  - Update `README.md` for user-facing behavior, configuration, setup, deployment, troubleshooting, or verification changes.
  - Update `UI.md` for UI state, visibility, controls, panels, or interaction changes.
  - Update this file only when agent workflow or safety context changes.

## First Checks For Any Task

- Run `git status --short` before editing. This workspace commonly has existing uncommitted changes; preserve them unless the user explicitly asks to revert them.
- Read the smallest relevant files before changing code. Common entry points are:
  - `app/main.py` for FastAPI routes, Realtime session config, text-chat flow, tool adapters, and server-side settings.
  - `app/static/app.js` for WebRTC lifecycle, Realtime event handling, text input behavior, result rendering, retained context, reconnect logic, and UI state.
  - `app/static/index.html` for static controls and asset version query strings.
  - `app/static/styles.css` for responsive layout, result/detail presentation, and iOS landscape behavior.
  - `UI.md` before changing visible UI behavior.
  - `README.md` before changing human-facing behavior or configuration.
- For any task that asks about the text2SQL API, uses a text2SQL endpoint, changes text2SQL tool behavior, or depends on text2SQL response shapes, read the upstream API documentation first: `C:\Users\vaugo\Code\fastapi-text2sql\README.md`. Treat it as the source of truth for available endpoints, entity IDs, response fields, embedded relations, and current first-class entities.

## Editing Rules Specific To This App

- Frontend asset cache busting matters. When changing `app/static/app.js` or `app/static/styles.css`, bump the query string versions in `app/static/index.html` and keep the README cache-busting section aligned.
- Keep the browser UI and `UI.md` in sync. If a visibility rule changes, document the state transition, not just the visual result.
- Avoid adding user-facing project explanations to `AGENTS.md`; put them in `README.md` or `UI.md` as appropriate.
- Keep generated UI text and labels consistent with existing controls. The UI is compact and utility-focused, especially in result/detail mode.
- Preserve the current text/audio split unless the user asks to change it: audio uses the Realtime WebRTC path; typed text posts to `/text-chat`.
- Treat `resultsPanel.hidden` as an important state signal. It drives compact result mode through `.panel.resultsMode`, hiding the app header and status row.
- Treat `updateSessionButtons()` as the source of truth for Start/Stop visibility and disabled state.
- Treat `setStatus()` as the source of truth for status text and dot state.
- Treat `renderText2SqlResult()` and `renderEntityDetailOutput()` as the primary result/detail rendering boundaries.
- If you alter Realtime session shapes, tool schemas, model configuration, or OpenAI API usage, check current official OpenAI docs before assuming API details.

## UI And Browser Verification

- After meaningful frontend changes, verify in a browser, not only by reading code.
- For local browser verification, the app normally runs at `http://127.0.0.1:3000/`.
- For iOS landscape or viewport-sensitive layout work, verify an iPhone 15 Pro Max landscape-sized viewport around `932x430` and confirm the relevant media query behavior.
- For canvas-free DOM UI work, a computed-style or DOM check is often enough when screenshots are not required by the user.
- For result/detail rendering changes, exercise the state that makes `#resultsPanel` visible so compact mode is covered.

## Runtime And State Pitfalls

- The visible voice selector mentioned historically is not present in the current `index.html`; current voice selection is server-side through `AGENT_VOICE`. Re-check the DOM and README before changing voice behavior.
- `clearConversationUi()` clears result UI state but does not explicitly clear the subtitle timer. If changing reset behavior, decide whether subtitles should also be cleared and document it in `UI.md`.
- `stop()` stops audio transport but does not clear results or retained context. `startNewConversation()` is the full reset path.
- Retained context is used during the current page lifetime and reconnect flow. Page load currently clears stored context instead of restoring it.
- WebRTC reconnect logic is deliberately conservative: disconnected state gets a grace watchdog; failed state reconnects quickly; self-healed connections should not be torn down.
- Keepalive behavior is part of connection stability. Be careful when touching Worker fallback, data-channel no-op sends, visibility/focus keepalives, or reconnect timers.
- The text input remains enabled in all current states. If that changes, update both the code and `UI.md`.

## Verification Discipline

- Run the relevant checks from the README Verification section after code changes.
- For backend-only changes, at minimum compile-check the touched Python.
- For frontend JavaScript changes, at minimum syntax-check the touched JavaScript and do a browser smoke test when behavior changes.
- Documentation-only changes do not require runtime tests, but still check the diff for accidental README/AGENTS/UI duplication.
