"""Start the server with `.env` overrides given on the command line (VOICE-AGENT-176).

    python -m app                                  # same as: uvicorn app.main:app --host 127.0.0.1 --port 3000
    python -m app --no-subtitles                   # both native subtitle lanes off, whatever .env says
    python -m app --spoken-subtitles off --user-subtitles on
    python -m app --env AGENT_SOUL=scholar --env ENABLE_STRUCTURED_CARD_FOCUS=false
    python -m app --no-subtitles --show-config     # print what the server would resolve, then exit

Why a launcher: `uvicorn app.main:app` has no application options, and the flags are read
from the environment by `app.main` at request time. `load_dotenv()` never overwrites a
variable that already exists in the process, so anything set here BEFORE `app.main` is
imported beats `.env`. Precedence, highest first: command line > process environment >
`.env` > code default. The subtitle flags keep their per-session URL overrides
(`?spokenSubtitles=0/1`, `?userTranscriptSubtitles=0/1`), which beat all of the above for
that one session.

The keys overridden here are listed in `VOICE_AGENT_CLI_OVERRIDES` so the startup banner
in `app.main` can say where each subtitle default came from.
"""

from __future__ import annotations

import argparse
import os
import sys

SPOKEN_SUBTITLES = "ENABLE_SPOKEN_SUBTITLES"
USER_SUBTITLES = "ENABLE_USER_TRANSCRIPT_SUBTITLES"
CLI_OVERRIDES_VAR = "VOICE_AGENT_CLI_OVERRIDES"
SUBTITLE_KEYS = (SPOKEN_SUBTITLES, USER_SUBTITLES)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app",
        description="Run the voice-agent server, optionally overriding .env from the command line.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Precedence, highest first: command line > process environment > .env > code default.\n"
            "Per-session URL parameters (?spokenSubtitles=0/1, ?userTranscriptSubtitles=0/1) still\n"
            "override the server default for that session."
        ),
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1).")
    parser.add_argument("--port", type=int, default=3000, help="Port (default: 3000).")
    parser.add_argument("--reload", action="store_true", help="uvicorn auto-reload (dev only).")
    lanes = parser.add_mutually_exclusive_group()
    lanes.add_argument(
        "--no-subtitles", action="store_true",
        help=f"Turn both native subtitle lanes off for every session "
             f"({SPOKEN_SUBTITLES}=false, {USER_SUBTITLES}=false).",
    )
    lanes.add_argument(
        "--subtitles", action="store_true",
        help="Turn both native subtitle lanes on for every session.",
    )
    parser.add_argument(
        "--spoken-subtitles", choices=["on", "off"], default=None,
        help=f"Assistant (bottom) subtitle lane, sets {SPOKEN_SUBTITLES}.",
    )
    parser.add_argument(
        "--user-subtitles", choices=["on", "off"], default=None,
        help=f"User transcript (top) subtitle lane, sets {USER_SUBTITLES}.",
    )
    parser.add_argument(
        "--env", action="append", default=[], metavar="KEY=VALUE",
        help="Override any .env key for this run (repeatable), e.g. --env AGENT_SOUL=scholar.",
    )
    parser.add_argument(
        "--show-config", action="store_true",
        help="Print the resolved subtitle flags and every override, then exit without serving.",
    )
    return parser


def overrides_from_args(args: argparse.Namespace, parser: argparse.ArgumentParser) -> dict[str, str]:
    """Translate the flags into environment assignments. Specific lane flags beat the
    two-lane shortcuts, and --env beats everything (last one wins)."""
    overrides: dict[str, str] = {}
    if args.no_subtitles:
        overrides[SPOKEN_SUBTITLES] = "false"
        overrides[USER_SUBTITLES] = "false"
    if args.subtitles:
        overrides[SPOKEN_SUBTITLES] = "true"
        overrides[USER_SUBTITLES] = "true"
    if args.spoken_subtitles:
        overrides[SPOKEN_SUBTITLES] = "true" if args.spoken_subtitles == "on" else "false"
    if args.user_subtitles:
        overrides[USER_SUBTITLES] = "true" if args.user_subtitles == "on" else "false"
    for item in args.env:
        key, sep, value = item.partition("=")
        key = key.strip()
        if not sep or not key:
            parser.error(f"--env expects KEY=VALUE, got {item!r}")
        overrides[key] = value.strip()
    return overrides


def apply_overrides(overrides: dict[str, str]) -> None:
    """Must run BEFORE `app.main` is imported: its `load_dotenv()` fills only the keys that
    are still missing from the process environment."""
    os.environ.update(overrides)
    if overrides:
        os.environ[CLI_OVERRIDES_VAR] = ",".join(sorted(overrides))


def show_config(overrides: dict[str, str]) -> None:
    from dotenv import load_dotenv  # same loader, same file lookup as app.main

    load_dotenv()
    for key in SUBTITLE_KEYS:
        value = os.getenv(key)
        source = "command line" if key in overrides else ("environment or .env" if value is not None else "code default")
        print(f"{key}={value if value is not None else 'false'}  ({source})")
    for key in sorted(overrides):
        if key not in SUBTITLE_KEYS:
            print(f"{key}={os.environ[key]}  (command line)")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    overrides = overrides_from_args(args, parser)
    apply_overrides(overrides)

    if args.show_config:
        show_config(overrides)
        return 0

    import uvicorn  # after the overrides: the app module is imported by uvicorn, not here

    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
