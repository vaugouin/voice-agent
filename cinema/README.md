# Cinema mode: scripted two-voice episodes (VOICE-AGENT-235, APP-IDEAS-010)

An episode is a **scenario**: a JSON file with one beat per spoken line, two voices (a candide who asks, an expert who answers from the database), and a visual brick per beat. The app plays it back: pre-rendered audio drives the timeline, the bricks animate on cue. Nothing is generated live.

Design: `~/Nestor/projets/t2s-backlog/app-ideas-010-generated-podcast-video.md`. Ticket: `repos/voice-agent.md`, VOICE-AGENT-235.

## Files

- `scenarios/<slug>.json`: the scenario, committed. Written by hand or by Claude from the test sheet of the pair; every factual line carries its source.
- `assets/<slug>/`: built from the scenario by `uv run tools/build-cinema-assets.py cinema/scenarios/<slug>.json`. **Not committed**: frames come from the film copies on the NAS, audio is rebuilt from the scenario.
  - `frames/<movie_id>-<HHhMMmSSs>.jpg`: one frame per `quoted_frame` / `split_frames` brick, ffmpeg on the copy named in `meta.copies`, 1920 px wide.
  - `images/poster-<movie_id>.jpg`, `images/cover-<source_work_id>.jpg`: the title-card pictures (TMDb `poster_path`, Wikipedia `cover_url` from `meta`).
  - `audio/<beat>.wav`: one line per beat, OpenAI `gpt-4o-mini-tts` with the `voice` and `instructions` of `meta.voices`; `audio/gap-<ms>.wav` the silences (350 ms between lines, plus `pause_after_ms`).
  - `episode.wav` / `episode.mp3`: the lines and silences concatenated; `timeline.json`: the scenario with `start_ms` / `duration_ms` per beat and the asset path of each brick, what the player reads; `transcript.txt`: `[MM:SS] voice: line` on the real durations.
  - Idempotent: an asset on disk is kept unless `--force`; `--only frames|images|audio|timeline` runs one step. A changed line needs its wav deleted or `--force`.

## Playing an episode

Open the app with `?cinema=<slug>` (for example `http://127.0.0.1:3000/?cinema=yojimbo-fistful`): the live app is hidden, the stage loads `assets/<slug>/timeline.json` and `episode.mp3` (served by the `/cinema` mount when the folder exists), shows the first brick and waits for Play. `&autoplay=1` tries to start at once (browsers may block it). Space or K plays and pauses, the arrow keys seek by five seconds, Home restarts. Bricks follow the audio clock, so pause and seek keep them in step; the scheduler mirrors the spoken-card cue engine of the live app (one timer, a sorted queue). A `hold` brick keeps the previous picture.

## The scenario contract (`version: 1`)

```
meta        id, title, language, target_minutes (indicative only: no cap, the longer the better), length_policy, voices {candide, expert}, works[], source_works[], copies{}, fetched
beats[]     id, voice (candide | expert), track (fact | performance), text, source, brick, pause_after_ms
```

**Two tracks.** A `fact` beat states something the database or the film attests, and its `source` says where. A `performance` beat is the staging (reactions, transitions, the hook) and carries `{"type": "none"}`. The generator may rewrite performance lines freely; it may not touch a fact line without re-checking its source.

**Sources** (`source` is one object or a list):

| type | fields | means |
| --- | --- | --- |
| `fiche` | `ref` (`movies/<id>` or `sourceworks/<id>`), `segment` (a `wikipedia_content` title), optional `quote` (verbatim) | the API sheet's Wikipedia text |
| `field` | `ref`, `field`, `value` | a structured column of the sheet |
| `graph` | `ref` (`movies/<id>.based_on`), `value` (source work id) | a `based_on` edge |
| `subtitle` | `movie_id`, `copy`, `timecode`, `line` | a line of the subtitle synced to that copy |
| `none` | | performance track |

**Bricks** (`brick.type`), four for the prototype:

| type | fields | shows |
| --- | --- | --- |
| `title_card` | `movie_id` or `source_work_id`, optional `caption` | poster or cover, title, year, runtime; two ids give a diptych |
| `quoted_frame` | `movie_id`, `copy`, `timecode`, `caption` | the frame at that timecode of that copy, caption under it |
| `split_frames` | `left`, `right` (each a `quoted_frame`), `caption` | two frames side by side |
| `quote_card` | `text`, `attribution` | a verbatim quotation, full screen |
| `hold` | | keep the previous brick |

**Copies** (`meta.copies`): the exact file each timecode refers to, with the subtitle it was read from. A timecode is only valid for its copy: PAL subtitles run 4 % faster than Blu-ray ones.

**Timing.** `start_ms` and `duration_ms` are absent in the hand-written scenario; the audio build fills them in from the rendered lines, and that is the timeline the player uses.

## Rules carried over from the design note

- When the `based_on` graph asserts a link the Wikipedia text disputes, the expert says both.
- The fact track reads the structured fields as well as the text (Techniscope is in `FILM_TECHNOLOGY`, nowhere in the text).
- A frame is a still, commented and credited, with the same status as a TMDb backdrop; no moving extract beyond a few seconds.
- Quotations stay in their original language; the dialogue language is the content language (English for this pair).
