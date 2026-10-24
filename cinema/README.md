# Cinema mode: scripted two-voice episodes (VOICE-AGENT-235, APP-IDEAS-010)

An episode is a **scenario**: a JSON file with one beat per spoken line, two voices (a candide who asks, an expert who answers from the database), and a visual brick per beat. The app plays it back: pre-rendered audio drives the timeline, the bricks animate on cue. Nothing is generated live.

Design: `~/Nestor/projets/t2s-backlog/app-ideas-010-generated-podcast-video.md`. Ticket: `repos/voice-agent.md`, VOICE-AGENT-235.

## Files

- `scenarios/<slug>.json`: the scenario, committed. Written by hand or by Claude from the test sheet of the pair; every factual line carries its source.
- `assets/<slug>/`: built from the scenario by `uv run tools/build-cinema-assets.py cinema/scenarios/<slug>.json`. **Not committed**: frames come from the film copies on the NAS, audio is rebuilt from the scenario.
  - `frames/<movie_id>-<HHhMMmSSs>.jpg`: one frame per `frame` / `quoted_frame` / `split_frames` brick, ffmpeg on the copy named in `meta.copies`, up to 2560 px wide, black bars cropped. The file is named after the cited timecode, but the frame taken is the **sharpest** one (ffmpeg `blurdetect`) in a window from half a second before to two and a half seconds after it: a subtitle's timecode is the start of a line, often a camera move or a cut. `frames/frames.json` keeps, per frame, the cited timecode, the one taken, the crop and the blur score; `timeline.json` carries the taken timecode as `taken`. A brick may set `"exact": true` (the cited frame itself) or `"window": [-0.5, 1.0]`.
  - `images/poster-<movie_id>.jpg`, `images/cover-<source_work_id>.jpg`: the title-card pictures (TMDb `poster_path`, Wikipedia `cover_url` from `meta`); `images/person-<person_id>.jpg`: the portraits (TMDb profile, `h632`, from `meta.persons`); `images/wall-<movie|tv>-<id>.jpg`: the poster walls (TMDb `w500`, from `meta.related`).
  - `audio/<beat>.wav`: one line per beat, OpenAI `gpt-4o-mini-tts` with the `voice` and `instructions` of `meta.voices`, plus the beat's own `delivery` hint appended as "This line: …"; a voice with `pitch_semitones` is then lowered by ffmpeg (`rubberband`, formants shifted). `audio/<beat>.json` is the signature of what was synthesized (model, voice, instructions, delivery, text, pitch): the next build redoes only the lines whose signature changed. `audio/gap-<ms>.wav` the silences (350 ms between lines, plus `pause_after_ms`).
  - With `meta.tts.provider = "gemini"` (or `--tts gemini`): `audio/x-<beat>.wav`, one **exchange** per Gemini 3.8 Flash TTS multi-speaker request (a run of consecutive lines under 1800 characters, named after its first line, both voices in one take, each line's `delivery` passed as the turn's `style`, the vocal tags and `|backchannels|` of `beat.speech` inline). faster-whisper (`small`, CPU) then hears where each line starts and the exchange is cut into the per-line wavs, by bytes; `audio/exchanges.json` keeps each line's exchange and bounds (`confidence` `heard` or `estimated`), and the timeline glues the lines of one exchange without inserting a gap, so the conversation keeps the pauses the model played. An exchange is redone when any of its lines changed. The OpenAI provider stays the fallback (`--tts openai`), one request per line, `text` only.
  - `episode.wav` / `episode.mp3`: the lines and silences concatenated. The mp3 is **constant bitrate** (128 kb/s): with a variable one, Chrome's seeks landed up to a second away from the time asked for near the end of a twenty-minute file, and the lines on screen no longer matched the voice. `timeline.json`: the scenario with `start_ms` / `duration_ms` per beat and the asset path of each brick, what the player reads; `transcript.txt`: `[MM:SS] voice: line` on the real durations.
  - Idempotent: a frame or an image on disk is kept unless `--force`; a line is redone when its signature changed; `--only frames|images|audio|timeline` runs one step.

## Playing an episode

Open the app with `?cinema=<slug>` (for example `http://127.0.0.1:3000/?cinema=yojimbo-fistful`): the live app is hidden, the stage loads `assets/<slug>/timeline.json` and `episode.mp3` (served by the `/cinema` mount when the folder exists), shows the first brick and waits for Play. `&autoplay=1` tries to start at once (browsers may block it). Space or K plays and pauses, the arrow keys seek by five seconds, Home restarts. Bricks follow the audio clock, so pause and seek keep them in step; the scheduler mirrors the spoken-card cue engine of the live app (one timer, a sorted queue). A `hold` brick keeps the previous picture.

## The scenario contract (`version: 2`)

```
meta        id, title, language, target_minutes (indicative only: no cap, the longer the better), length_policy,
            voices {candide, expert: voice, instructions, pitch_semitones, gemini_voice}, tts {provider, model, fallback},
            register, works[], source_works[], copies{},
            persons[] (person_id, name, profile_path), related[] (kind movie|tv, id, title, year, poster_path), fetched
beats[]     id, voice (candide | expert), track (fact | performance), text, speech, delivery, source, brick, pause_after_ms
```

**Voices.** `meta.voices` names the OpenAI voice of each speaker and its standing instructions (affect, pacing, intonation, emphasis: the whole persona, not one adjective). A beat's `delivery` is the direction for that one line ("Genuinely incredulous, laughing a little."), appended to the instructions when it is synthesized; it is what keeps twenty minutes from sounding read. Chosen on samples the 2026-10-24: `marin` for the candide, `cedar` lowered two semitones for the expert (the sincerity of cedar, the depth of onyx). `gemini_voice` is the prebuilt Gemini voice of the speaker (thirty names, `Laomedeia`, `Algenib`, … in the speech-generation docs) when `meta.tts.provider` is `gemini`; the same `delivery` becomes the turn's `style`.

**Speech.** `text` is what the screen shows and the transcript keeps: clean. `speech`, optional, is what the voice says when it differs: the same words plus Gemini's inline vocal tags in angle brackets (`<laugh>`, `<chuckle>`, `<gasp>`, `<sigh>`, `<short pause>`, `<long pause>`; a capitalized word is stressed) and `|backchannels|`, a reaction the other speaker voices over the line ("Fifteen percent of the worldwide receipts. |wow| Plus over…"). The OpenAI provider ignores `speech`. Never put a fact in `speech` that is not in `text`.

**Register** (`meta.register`, since the 2026-10-24 rewrite). The first script was a lecture with interjections: 88 % of the words were the expert's facts, 48 words per expert line on average. NotebookLM's episodes run about half facts, half performance, with turns of ten to twenty words and the candide carrying a third of the words. The rewrite cut every expert paragraph into turns of about twenty words, gave the candide reactions, relays ("Exactly.", "Which means?") and sourced lines of her own (she reads the subtitles), added a cold open in the second person before the titles, a mission and sources ritual, one contestation beat per segment ("I need to play devil's advocate"), an explicit gear shift ("Leave the plot."), and a two-branch question to close, never answered, with a "next time you…". Every fact line kept the exact source object of the line it was cut from.

**Two tracks.** A `fact` beat states something the database or the film attests, and its `source` says where. A `performance` beat is the staging (reactions, transitions, the hook) and carries `{"type": "none"}`. The generator may rewrite performance lines freely; it may not touch a fact line without re-checking its source.

**Sources** (`source` is one object or a list):

| type | fields | means |
| --- | --- | --- |
| `fiche` | `ref` (`movies/<id>` or `sourceworks/<id>`), `segment` (a `wikipedia_content` title), optional `quote` (verbatim) | the API sheet's Wikipedia text |
| `field` | `ref`, `field`, `value` | a structured column of the sheet |
| `graph` | `ref` (`movies/<id>.based_on`), `value` (source work id) | a `based_on` edge |
| `subtitle` | `movie_id`, `copy`, `timecode`, `line` | a line of the subtitle synced to that copy |
| `none` | | performance track |

**Bricks** (`brick.type`):

| type | fields | shows |
| --- | --- | --- |
| `title_card` | `movie_id` or `source_work_id`, optional `caption` | poster or cover, title, year, runtime; two ids give a diptych |
| `quoted_frame` | `movie_id`, `copy`, `timecode`, `caption` | the frame at that timecode of that copy, the quoted line under it |
| `frame` | same fields | the same, with a descriptive caption instead of a quotation (the action between two lines) |
| `split_frames` | `left`, `right` (each a frame spec), `caption` | two frames side by side |
| `portraits` | `people[]` (`person_id`, `caption`), optional `caption` | a row of TMDb portraits with a caption under each (a pseudonym, a refusal, a credit); a person without a photo gets their initials |
| `poster_wall` | `items[]` (`kind`, `id`), optional `caption` | the posters of the films and series a line names, title and year under each |
| `quote_card` | `text`, `attribution` | a verbatim quotation, full screen |
| `hold` | | keep the previous brick |

A story told over several lines wants a frame every few lines, not one picture held for a minute: the Yojimbo / Fistful episode changes its picture on 44 of its 85 beats.

**Copies** (`meta.copies`): the exact file each timecode refers to, with the subtitle it was read from. A timecode is only valid for its copy: PAL subtitles run 4 % faster than Blu-ray ones.

**Timing.** `start_ms` and `duration_ms` are absent in the hand-written scenario; the audio build fills them in from the rendered lines, and that is the timeline the player uses.

## Rules carried over from the design note

- When the `based_on` graph asserts a link the Wikipedia text disputes, the expert says both.
- The fact track reads the structured fields as well as the text (Techniscope is in `FILM_TECHNOLOGY`, nowhere in the text).
- A frame is a still, commented and credited, with the same status as a TMDb backdrop; no moving extract beyond a few seconds.
- Quotations stay in their original language; the dialogue language is the content language (English for this pair).
