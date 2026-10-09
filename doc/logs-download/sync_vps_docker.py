#!/usr/bin/env python3
r"""
sync_vps_docker.py — Additive, one-way mirror refresh: VPS -> local.

Pulls NEW and NEWER files from the VPS down into the local copy, over SFTP
(Paramiko). It is intentionally *additive*:

  * Copies a file if it does not exist locally (NEW) or if its byte size differs
    from the remote (content changed). The decision is size-first: a same-size
    file whose local timestamp merely drifted is NOT re-downloaded — its mtime is
    realigned locally instead, so an external tool touching the mirror can't cause
    an endless re-copy loop. Use --strict-mtime for the old timestamp-trusting
    behavior.
  * Creates any missing local directories.
  * By default NEVER deletes anything locally: files removed on the VPS stay in
    the mirror. Opt in with VPS_DELETE=true in .env to also remove local files and
    folders that no longer exist on the VPS. Deletion only happens inside folders this run
    actually listed on the VPS: excluded paths, skipped symlinks, other roots, and
    folders whose remote listing failed are never touched.
  * One-way only (remote -> local). Local changes are never pushed up.
  * Deletion can be set per folder pair: a [keep] tag on a pair turns it off
    there, a [delete] tag turns it on, whatever VPS_DELETE says.
  * Resilient to dropped SFTP sessions: if the SSH transport dies mid-walk, the
    session is rebuilt and the failing operation retried, and a failure in one
    top-level root is isolated so the remaining roots still sync — so a single
    channel blip no longer aborts the whole run and silently starves the tail
    of the alphabet.

By default it runs as **root** so it can read EVERYTHING (incl. root-owned TLS
private keys and the ChromaDB store).

What it mirrors is a list of folder pairs in the .env, one per line:

  VPS_SYNC_1=/home/debian/docker -> T:\...\ovh-pv7\home\debian\docker
  VPS_SYNC_2=/home/debian/docker/damp-vaugouin-com/mariadb_backups -> T:\...\mariadb_backups [keep]

Pairs run in natural suffix order (2 before 10). A relative local folder resolves
against the .env's folder. A pair may sit inside another one only if its local
folder sits at the same relative place as its remote folder: the outer pair then
leaves that subtree entirely to the inner pair (copy and deletion), which is what
makes [keep] on an inner pair safe. Any other overlap, and any duplicate remote or
local folder, stops the run before connecting. --sync "remote -> local" replaces
the .env pairs for a one-off run; --only <suffix> runs a subset.

The pre-2026-10 keys VPS_REMOTE / VPS_LOCAL / VPS_EXTRA_ROOTS are refused with the
equivalent VPS_SYNC lines printed; `--migrate-env` rewrites the .env in place
(backup kept, --dry-run to preview).
Trim content with an exclude config file (see --exclude-file / sync_exclude.conf):
the heavy raw database files are excluded there, while the ChromaDB vector store
under shared_data is kept.

Exclude rules (from the config file and/or --exclude):
  * A line starting with '/' is an ABSOLUTE remote path — that path and
    everything under it is skipped
    (e.g. /home/debian/docker/damp-vaugouin-com/mariadb_data/data).
  * Any other line is a NAME or GLOB matched against a file/dir name at any
    level (e.g. __pycache__, .git, *.log).
  * Lines starting with '#' and blank lines are ignored.

Credentials live in a `.env` file beside this script (see .env.example) and are
loaded automatically. Real environment variables override .env; CLI flags
override both. Recognised keys: VPS_HOST, VPS_PORT, VPS_USER, VPS_SYNC_<suffix>,
VPS_KEY_FILE, VPS_KEY_PASSPHRASE, VPS_SSH_PASSWORD, VPS_DELETE. The .env is
git/docker-ignored.

VPS_KEY_FILE accepts three path forms, all resolved by resolve_path():
`~/.ssh/id_ed25519` (portable, preferred), `%USERPROFILE%\.ssh\id_ed25519` /
`$HOME/...` (environment variables), and a RELATIVE path, which is anchored to
the .env's own folder — never to the shell's current directory, so the same
.env works whichever folder the script is launched from.

Usage (PowerShell):
  pip install paramiko
  copy .env.example .env   # then edit .env and set VPS_SSH_PASSWORD
  python sync_vps_docker.py              # root@host, full tree minus excludes
  python sync_vps_docker.py --dry-run    # show what WOULD be copied
  python sync_vps_docker.py --dry-run    # with VPS_DELETE=true, also shows what WOULD be deleted
  python sync_vps_docker.py --user debian  # non-root (skips root-owned files)

Root login: if the server only allows root by password (no root SSH key), set
VPS_SSH_PASSWORD in .env. More secure: add a root authorized_key and use
--key-file. Rotate any password ever pasted in plaintext.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import posixpath
import shutil
import stat
import sys
import time
from getpass import getpass

import paramiko

# --------------------------------------------------------------------------- #
# Connection config (VPS_HOST, VPS_PORT, VPS_USER, the password, ...) and the
# folder pairs (VPS_SYNC_<suffix>) are NOT hardcoded here: they live in .env
# (git/docker-ignored, see .env.example) or on the command line. The argparse
# defaults below read it straight from the environment; VPS_HOST and at least one
# pair are required (validated after parsing), while VPS_PORT/VPS_USER fall back
# to generic, non-sensitive literals if the .env omits them.
# --------------------------------------------------------------------------- #

# Config files sit next to this script unless overridden on the command line.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_EXCLUDE_FILE = os.path.join(_SCRIPT_DIR, "sync_exclude.conf")
DEFAULT_ENV_FILE = os.path.join(_SCRIPT_DIR, ".env")

# One log file per run records every file actually copied. It lives in a logs/
# subfolder beside this script and is named sync_vps_docker_<YYYYMMDD>_<HHMMSS>.log
# (the run's start time). Not written in --dry-run (nothing is copied then).
DEFAULT_LOG_DIR = os.path.join(_SCRIPT_DIR, "logs")

# A file counts as "newer" only if it is more than this many seconds newer than
# the local copy. Guards against filesystem timestamp-resolution jitter.
MTIME_TOLERANCE = 2.0

# Suffix for partial downloads so an interrupted transfer is never mistaken for a
# complete file on the next run.
PART_SUFFIX = ".part-sync"

# Network timeouts (seconds). Generous so a large directory listing or a slow
# transfer over a high-latency link does not abort mid-run. The SFTP channel
# timeout is the important one for big dirs (e.g. an API logs/ folder with tens
# of thousands of files): listdir_attr / get must not give up too early.
CONNECT_TIMEOUT = 60.0     # TCP connect + SSH banner + auth
SFTP_TIMEOUT = 600.0       # per-SFTP-operation (listdir/get) channel timeout

# When the SSH transport drops mid-walk, rebuild the session rather than aborting
# the whole run. Each rebuild retries this many times with a linear backoff.
RECONNECT_ATTEMPTS = 5
RECONNECT_BACKOFF = 3.0        # seconds; grows per attempt (attempt * backoff)
RECONNECT_BACKOFF_MAX = 30.0   # cap on the per-attempt sleep


class Stats:
    def __init__(self) -> None:
        self.copied_new = 0
        self.copied_newer = 0
        self.skipped = 0
        self.reconciled = 0
        self.failed = 0
        self.dirs_created = 0
        self.bytes_copied = 0
        self.excluded = 0
        self.reconnects = 0
        self.deleted_files = 0
        self.deleted_dirs = 0


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024
    return f"{n:.1f}TB"


def _fmt_time(epoch: float | None) -> str:
    """Local-time 'YYYY-MM-DD HH:MM:SS' for an epoch timestamp ('' if unknown)."""
    if not epoch:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch))


class CopyLog:
    """Append one tab-separated line per copied file to a per-run log file.

    Columns: copy operation time, full remote path, full local path, and the
    source file's own modification time. Opened lazily so no empty file is left
    behind when a run copies nothing; a ``None`` path (e.g. --dry-run) disables
    logging entirely and every call becomes a no-op.
    """

    _HEADER = "copy_time\tremote_path\tlocal_path\tsource_mtime\n"

    def __init__(self, path: str | None) -> None:
        self.path = path
        self.fh = None
        self.opened = False   # stays True after close() so the summary can report it

    def _ensure_open(self) -> None:
        if self.fh is not None or not self.path:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.fh = open(self.path, "a", encoding="utf-8")
        self.fh.write(self._HEADER)
        self.opened = True

    def record(self, remote_path: str, local_path: str, source_mtime: float | None) -> None:
        if not self.path:
            return
        self._ensure_open()
        copy_time = time.strftime("%Y-%m-%d %H:%M:%S")
        self.fh.write(f"{copy_time}\t{remote_path}\t"
                      f"{os.path.abspath(local_path)}\t{_fmt_time(source_mtime)}\n")
        self.fh.flush()

    def record_delete(self, remote_path: str, local_path: str, kind: str) -> None:
        """Log a local deletion (VPS_DELETE); the last column reads DELETED (<kind>)."""
        if not self.path:
            return
        self._ensure_open()
        op_time = time.strftime("%Y-%m-%d %H:%M:%S")
        self.fh.write(f"{op_time}\t{remote_path}\t"
                      f"{os.path.abspath(local_path)}\tDELETED ({kind})\n")
        self.fh.flush()

    def close(self) -> None:
        if self.fh is not None:
            try:
                self.fh.close()
            except OSError:
                pass
            self.fh = None


def load_dotenv(path: str | None) -> None:
    """Load KEY=VALUE pairs from a .env file into os.environ.

    Existing environment variables win (we never override them). Supports
    optional `export ` prefixes and single/double-quoted values.
    """
    if not path or not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            os.environ.setdefault(key, val)


def resolve_path(path: str | None, base: str) -> str | None:
    """Expand ~ and %VARS%/$VARS in *path*, then anchor a relative one to *base*.

    Paramiko opens ``key_filename`` verbatim: it expands nothing, so a value like
    ``%USERPROFILE%\\.ssh\\id_ed25519`` or ``~/.ssh/id_ed25519`` would be taken as a
    literal filename and auth would fail with a misleading "authentication failed".

    A *relative* value resolves against this script's config folder (the .env's own
    directory), NOT the shell's current directory — otherwise the same .env would
    work when launched from the script folder and break from anywhere else, which
    is exactly how this script is normally run (``python doc\\...\\sync_vps_docker.py``
    from the repo root). Every other default here is anchored the same way
    (_SCRIPT_DIR), so this keeps one rule for the whole file.
    """
    if not path:
        return path
    expanded = os.path.expanduser(os.path.expandvars(path))
    if not os.path.isabs(expanded):
        expanded = os.path.join(base, expanded)
    return os.path.normpath(expanded)


class SyncPair:
    """One `remote -> local` mirror, read from a VPS_SYNC_<suffix> line or --sync."""

    def __init__(self, label: str, remote: str, local: str, delete: bool) -> None:
        self.label = label
        self.remote = remote
        self.local = local
        self.delete = delete


SYNC_KEY_PREFIX = "VPS_SYNC_"
SYNC_ARROW = "->"
# Trailing tags on a pair line, overriding VPS_DELETE for that pair only.
SYNC_TAGS = {"[keep]": False, "[delete]": True}
# Keys of the pre-VPS_SYNC layout. Their presence stops the run (see --migrate-env).
LEGACY_KEYS = ("VPS_REMOTE", "VPS_LOCAL", "VPS_EXTRA_ROOTS")
LEGACY_DEFAULT_REMOTE = "/home/debian/docker"


def _sync_key_order(label: str) -> tuple:
    """Natural order of the key suffixes: 2 before 10, numbers before names."""
    return (0, int(label), "") if label.isdigit() else (1, 0, label.lower())


def parse_sync_pair(label: str, text: str, config_dir: str, default_delete: bool) -> SyncPair:
    """Parse `remote -> local [keep|delete]`; raise ValueError with a readable reason."""
    value = text.strip()
    delete = default_delete
    lowered = value.lower()
    for tag, tag_delete in SYNC_TAGS.items():
        if lowered.endswith(tag):
            value = value[: -len(tag)].rstrip()
            delete = tag_delete
            break
    else:
        if value.endswith("]") and "[" in value:
            raise ValueError(f"unknown tag {value[value.rfind('['):]!r} "
                             f"(use {' or '.join(SYNC_TAGS)})")
    remote, arrow, local = value.partition(SYNC_ARROW)
    remote, local = remote.strip(), local.strip()
    if not arrow:
        raise ValueError(f"no '{SYNC_ARROW}' between the remote and the local folder")
    if not remote.startswith("/"):
        raise ValueError(f"remote path must be absolute (start with /), got {remote!r}")
    if not local:
        raise ValueError("local folder is empty")
    remote = posixpath.normpath(remote)
    return SyncPair(label, remote, resolve_path(local, config_dir), delete)


def check_sync_pairs(pairs: list[SyncPair]) -> list[str]:
    """Return the configuration errors that make a set of pairs unsafe to run.

    Nesting is allowed only when it mirrors the VPS: a pair whose local folder
    sits inside another pair's local folder must also sit, at the same relative
    place, inside that pair's remote folder. The outer pair then skips that
    subtree (copy AND deletion), and the inner pair's own rules apply there, so
    `[keep]` on an inner pair really protects it. Any other overlap would let the
    outer pair's deletion pass wipe files the inner pair just copied.
    """
    errors: list[str] = []

    def key(path: str) -> str:
        return os.path.normcase(os.path.normpath(path))

    for i, a in enumerate(pairs):
        for b in pairs[i + 1:]:
            if a.remote == b.remote:
                errors.append(f"VPS_SYNC_{a.label} and VPS_SYNC_{b.label} read the same "
                              f"remote folder {a.remote}")
            if key(a.local) == key(b.local):
                errors.append(f"VPS_SYNC_{a.label} and VPS_SYNC_{b.label} write to the same "
                              f"local folder {a.local}")
    for outer in pairs:
        for inner in pairs:
            if outer is inner or key(outer.local) == key(inner.local):
                continue
            try:
                rel_local = os.path.relpath(key(inner.local), key(outer.local))
            except ValueError:   # different drives
                continue
            if rel_local.startswith(os.pardir):
                continue
            # inner.local is inside outer.local: the remotes must nest the same way.
            expected = posixpath.join(outer.remote, *rel_local.split(os.sep))
            if inner.remote.lower() != expected.lower():
                errors.append(
                    f"VPS_SYNC_{inner.label} writes inside VPS_SYNC_{outer.label}'s local "
                    f"folder, so its remote must be {expected}, got {inner.remote}. "
                    f"Otherwise VPS_SYNC_{outer.label} would copy over or delete its files.")
    return errors


def legacy_sync_lines(values: dict[str, str]) -> tuple[list[str], list[str]]:
    """Translate VPS_REMOTE / VPS_LOCAL / VPS_EXTRA_ROOTS into VPS_SYNC_n lines.

    Reproduces the old mapping exactly, including the derived local base, and
    returns (lines, warnings). A warning is raised when VPS_LOCAL does not end with
    the VPS_REMOTE tail: the old base was then wrong, and so are the destinations
    derived from it (on 2026-10-08 it climbed to C:\\).
    """
    remote = (values.get("VPS_REMOTE") or LEGACY_DEFAULT_REMOTE).rstrip("/") or "/"
    local = values.get("VPS_LOCAL") or ""
    warnings: list[str] = []
    if not local:
        warnings.append("VPS_LOCAL is empty: write the first VPS_SYNC line by hand.")
    tail = [p for p in remote.strip("/").split("/") if p]
    base = local
    for _ in tail:
        base = os.path.dirname(base)
    local_parts = [p for p in os.path.normpath(local).split(os.sep) if p] if local else []
    tail_matches = [p.lower() for p in local_parts[-len(tail):]] == [p.lower() for p in tail] \
        if tail else True
    lines = [f"{remote} {SYNC_ARROW} {local}"]
    for entry in (values.get("VPS_EXTRA_ROOTS") or "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        extra, sep, dest = entry.partition("=")
        extra = extra.strip().rstrip("/")
        if sep and dest.strip():
            lines.append(f"{extra} {SYNC_ARROW} {dest.strip()}")
            continue
        derived = os.path.join(base, *[p for p in extra.strip("/").split("/") if p])
        lines.append(f"{extra} {SYNC_ARROW} {derived}")
        if not tail_matches:
            warnings.append(f"{extra} -> {derived} was derived from a VPS_LOCAL that does "
                            f"not end with {remote}: check that destination.")
    return lines, warnings


def migrate_env_file(path: str, dry_run: bool) -> int:
    """Rewrite *path* from the legacy keys to VPS_SYNC_n lines (backup kept)."""
    if not os.path.isfile(path):
        print(f"ERROR: no .env at {path}", file=sys.stderr)
        return 2
    with open(path, encoding="utf-8") as fh:
        original = fh.read().splitlines(keepends=True)

    values: dict[str, str] = {}
    legacy_idx: list[int] = []
    has_sync = False
    for i, raw in enumerate(original):
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.removeprefix("export ").partition("=")
        key, val = key.strip(), val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key in LEGACY_KEYS:
            values[key] = val
            legacy_idx.append(i)
        elif key.startswith(SYNC_KEY_PREFIX):
            has_sync = True
    if not legacy_idx:
        print(f"Nothing to migrate: {path} has none of {', '.join(LEGACY_KEYS)}.")
        return 0
    if has_sync:
        print(f"ERROR: {path} already has {SYNC_KEY_PREFIX}* lines AND legacy keys. "
              f"Remove one set by hand.", file=sys.stderr)
        return 2

    lines, warnings = legacy_sync_lines(values)
    eol = "\r\n" if original[0].endswith("\r\n") else "\n"
    block = ["# Folders to mirror, VPS -> local: one pair per line, remote -> local.",
             "# Add [keep] to never delete in that pair, [delete] to always propagate",
             "# deletions there, whatever VPS_DELETE says. Migrated from VPS_REMOTE,",
             f"# VPS_LOCAL and VPS_EXTRA_ROOTS on {time.strftime('%Y-%m-%d')}."]
    block += [f"{SYNC_KEY_PREFIX}{n}={line}" for n, line in enumerate(lines, 1)]
    block = [b + eol for b in block]

    first = legacy_idx[0]
    rewritten = [raw for i, raw in enumerate(original[:first]) if i not in legacy_idx]
    rewritten += block
    rewritten += [raw for i, raw in enumerate(original[first:], first) if i not in legacy_idx]

    print("Legacy keys found:")
    for key in LEGACY_KEYS:
        if key in values:
            print(f"  {key}={values[key]}")
    print("\nReplaced by:")
    for raw in block:
        print(f"  {raw.rstrip()}")
    for w in warnings:
        print(f"\nWARNING: {w}")
    print("\nComments that described the old keys are left in place: tidy them by hand.")
    if dry_run:
        print("\nDRY RUN: .env not modified.")
        return 0
    backup = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.writelines(rewritten)
    print(f"\n.env rewritten. Backup: {backup}")
    print("Next: python sync_vps_docker.py --dry-run, and read the WOULD DELETE lines.")
    return 0


def load_excludes(path: str | None, cli_entries: list[str]) -> list[str]:
    """Read exclude entries from the config file (if any) plus CLI --exclude."""
    entries: list[str] = []
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                entries.append(line.rstrip("/"))
    entries.extend(e.rstrip("/") for e in cli_entries)
    return entries


def is_excluded(remote_path: str, name: str, excludes: list[str]) -> bool:
    rp = remote_path.rstrip("/")
    for e in excludes:
        if e.startswith("/"):
            # Absolute remote path: match the path itself or any descendant.
            if rp == e or rp.startswith(e + "/"):
                return True
        else:
            # Name or glob, matched against the basename at any depth.
            if fnmatch.fnmatch(name, e):
                return True
    return False


def should_copy(remote_attr, local_path: str,
                strict_mtime: bool = False) -> tuple[bool, str]:
    """Return (copy?, reason).

    Decision is **size-first**: a file is re-downloaded only when its byte size
    differs from the remote (a real content change). When the sizes already match
    but the remote mtime is newer, the content is treated as identical — no
    transfer — and the reason ``"mtime-drift"`` tells the caller to realign the
    local mtime with a cheap local ``os.utime``. This is what stops an endless
    re-copy loop when some other tool rewrites the local mirror's timestamps (the
    classic case: a backup/mirror job touching the same files); a stray timestamp
    alone can no longer trigger a needless re-download.

    Pass ``strict_mtime=True`` (CLI ``--strict-mtime``) to restore the old,
    timestamp-trusting behavior — useful only if you ever expect a genuine
    content edit that keeps the exact same byte size (rare for text/scripts),
    since size-first would otherwise not notice it.
    """
    if not os.path.exists(local_path):
        return True, "new"
    try:
        lst = os.stat(local_path)
    except OSError:
        return True, "new"
    r_mtime = remote_attr.st_mtime or 0
    r_size = remote_attr.st_size or 0

    if r_size != lst.st_size:
        # Different byte size => content really changed. Copy, unless the local
        # copy is the newer one (never clobber a newer local with an older remote).
        if r_mtime >= lst.st_mtime:
            return True, "size-differs"
        return False, "up-to-date"

    # Same size: assume identical content. Never re-download on mtime alone.
    if r_mtime - lst.st_mtime > MTIME_TOLERANCE:
        if strict_mtime:
            return True, "newer"
        return False, "mtime-drift"
    return False, "up-to-date"


def copy_file(session, remote_path: str, local_path: str, remote_attr, stats: Stats,
              reason: str, dry_run: bool, log: CopyLog) -> None:
    if dry_run:
        print(f"  WOULD COPY ({reason}): {remote_path}  [{human(remote_attr.st_size or 0)}]")
        if reason == "new":
            stats.copied_new += 1
        else:
            stats.copied_newer += 1
        return

    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    tmp = local_path + PART_SUFFIX
    try:
        session.get(remote_path, tmp)
        os.replace(tmp, local_path)
        mtime = remote_attr.st_mtime or time.time()
        os.utime(local_path, (mtime, mtime))      # preserve remote mtime
        stats.bytes_copied += remote_attr.st_size or 0
        if reason == "new":
            stats.copied_new += 1
        else:
            stats.copied_newer += 1
        log.record(remote_path, local_path, remote_attr.st_mtime)
        print(f"  COPIED ({reason}): {remote_path}  [{human(remote_attr.st_size or 0)}]")
    except (PermissionError, IOError, OSError) as exc:
        stats.failed += 1
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        print(f"  !! FAILED: {remote_path}  ({exc})", file=sys.stderr)


def _force_remove(func, path, _exc) -> None:
    """rmtree error handler: clear the read-only bit (Windows) and retry once."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


def delete_extraneous(remote_dir: str, local_dir: str, remote_names: set[str],
                      stats: Stats, excludes: list[str], other_roots: set[str],
                      dry_run: bool, log: CopyLog) -> None:
    """Remove local entries of *local_dir* that are absent from *remote_names*.

    Called only after a successful remote listing of *remote_dir*, so a failed or
    partial listing can never wipe the local folder. Local entries that match an
    exclude rule or map to another mirrored root are out of scope and kept.
    Names are compared with os.path.normcase, so on Windows a case-only rename
    on the VPS does not delete the local copy it just overwrote.
    """
    try:
        local_names = os.listdir(local_dir)
    except OSError:
        return  # local folder absent (e.g. dry run) or unreadable: nothing to do

    for name in sorted(local_names):
        if os.path.normcase(name) in remote_names:
            continue
        remote_path = posixpath.join(remote_dir, name)
        if remote_path in other_roots or is_excluded(remote_path, name, excludes):
            continue
        local_path = os.path.join(local_dir, name)
        is_dir = os.path.isdir(local_path) and not os.path.islink(local_path)
        kind = "dir" if is_dir else "file"
        if dry_run:
            print(f"  WOULD DELETE ({kind}): {local_path}")
        else:
            try:
                if is_dir:
                    if sys.version_info >= (3, 12):
                        shutil.rmtree(local_path, onexc=_force_remove)
                    else:
                        shutil.rmtree(local_path, onerror=_force_remove)
                else:
                    try:
                        os.remove(local_path)
                    except PermissionError:
                        os.chmod(local_path, stat.S_IWRITE)
                        os.remove(local_path)
            except OSError as exc:
                stats.failed += 1
                print(f"  !! DELETE FAILED: {local_path}  ({exc})", file=sys.stderr)
                continue
            log.record_delete(remote_path, local_path, kind)
            print(f"  DELETED ({kind}): {local_path}")
        if is_dir:
            stats.deleted_dirs += 1
        else:
            stats.deleted_files += 1


def sync_dir(session, remote_dir: str, local_dir: str, stats: Stats,
             excludes: list[str], follow_symlinks: bool, dry_run: bool,
             other_roots: set[str], log: CopyLog, strict_mtime: bool = False,
             delete: bool = False) -> None:
    try:
        entries = session.listdir_attr(remote_dir)
    except (PermissionError, IOError, OSError) as exc:
        stats.failed += 1
        print(f"  !! Cannot list {remote_dir}: {exc}", file=sys.stderr)
        return

    if not dry_run and not os.path.isdir(local_dir):
        os.makedirs(local_dir, exist_ok=True)
        stats.dirs_created += 1

    for attr in sorted(entries, key=lambda a: a.filename):
        name = attr.filename
        remote_path = posixpath.join(remote_dir, name)
        local_path = os.path.join(local_dir, name)
        mode = attr.st_mode or 0

        if remote_path.rstrip("/") in other_roots:
            # This subtree is mirrored as its own root — don't double-sync it.
            print(f"  = skip (own root): {remote_path}/")
            continue

        if is_excluded(remote_path, name, excludes):
            stats.excluded += 1
            if stat.S_ISDIR(mode):
                print(f"  - skip (excluded): {remote_path}/")
            continue

        if stat.S_ISLNK(mode) and not follow_symlinks:
            stats.excluded += 1
            print(f"  ~ skip symlink: {remote_path}")
            continue

        if stat.S_ISDIR(mode) or (stat.S_ISLNK(mode) and follow_symlinks):
            sync_dir(session, remote_path, local_path, stats, excludes,
                     follow_symlinks, dry_run, other_roots, log, strict_mtime, delete)
        elif stat.S_ISREG(mode):
            do_copy, reason = should_copy(attr, local_path, strict_mtime)
            if do_copy:
                copy_file(session, remote_path, local_path, attr, stats, reason, dry_run, log)
            elif reason == "mtime-drift":
                # Same byte size, only the local timestamp drifted (e.g. another
                # tool touched the mirror). Realign the local mtime to the remote
                # so this file isn't re-evaluated forever — no re-download.
                if dry_run:
                    print(f"  ~ WOULD realign mtime (same size): {remote_path}")
                else:
                    try:
                        m = attr.st_mtime or time.time()
                        os.utime(local_path, (m, m))
                        print(f"  ~ mtime realigned (same size): {remote_path}")
                    except OSError as exc:
                        print(f"  !! mtime realign failed: {remote_path} ({exc})",
                              file=sys.stderr)
                stats.reconciled += 1
            else:
                stats.skipped += 1
        else:
            # FIFO, socket, device — never mirror these.
            stats.excluded += 1

    if delete:
        # Every name the VPS listed counts as present, whatever happened to it
        # above (copied, excluded, skipped symlink, special file, own root).
        remote_names = {os.path.normcase(a.filename) for a in entries}
        delete_extraneous(remote_dir, local_dir, remote_names, stats, excludes,
                          other_roots, dry_run, log)


def connect(args) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kwargs = dict(hostname=args.host, port=args.port, username=args.user,
                  timeout=CONNECT_TIMEOUT, banner_timeout=CONNECT_TIMEOUT,
                  auth_timeout=CONNECT_TIMEOUT)
    if args.key_file:
        kwargs["key_filename"] = args.key_file
        # An encrypted private key needs its passphrase passed explicitly: paramiko
        # never prompts on its own, it raises PasswordRequiredException. Take it from
        # the environment for unattended runs; otherwise we prompt below, on the
        # exception, so the passphrase can stay out of the .env entirely.
        passphrase = args.key_passphrase or os.environ.get("VPS_KEY_PASSPHRASE")
        if passphrase:
            kwargs["passphrase"] = passphrase
        # Offer only the key we were given: without this, paramiko also tries every
        # other key it finds and the failure message names the wrong one.
        kwargs["look_for_keys"] = False
        kwargs["allow_agent"] = False
    else:
        password = args.password or os.environ.get("VPS_SSH_PASSWORD")
        if not password:
            password = getpass(f"Password for {args.user}@{args.host}: ")
        kwargs["password"] = password
        kwargs["look_for_keys"] = False
        kwargs["allow_agent"] = False

    try:
        client.connect(**kwargs)
    except paramiko.PasswordRequiredException:
        # Encrypted key and no VPS_KEY_PASSPHRASE: ask, rather than fail with a
        # message that says nothing about what is missing.
        if not args.key_file:
            raise
        kwargs["passphrase"] = getpass(f"Passphrase for {args.key_file}: ")
        client.connect(**kwargs)
    return client


class SftpSession:
    """SSH+SFTP connection that transparently rebuilds itself if the transport
    drops mid-walk.

    A single long root-owned walk over a high-latency link occasionally loses its
    SSH channel (channel timeout, ``EOFError``, ``SSHException``, a NAS/link blip).
    Before, that exception propagated to the top-level guard in :func:`main` and
    aborted the ENTIRE run — always starving the alphabetically-late directories
    not yet reached. Here a dead transport triggers a reconnect and the failing
    operation is retried; per-file/per-dir errors (permission denied, vanished
    file) leave the transport alive and are re-raised so the caller's existing
    handlers deal with them.
    """

    def __init__(self, args, stats: Stats) -> None:
        self.args = args
        self.stats = stats
        self.client = None
        self.sftp = None
        self._open()

    def _open(self) -> None:
        self.client = connect(self.args)
        self.sftp = self.client.open_sftp()
        # Generous per-operation timeout so listing a huge dir / fetching a big
        # file doesn't abort mid-run.
        try:
            self.sftp.get_channel().settimeout(SFTP_TIMEOUT)
        except Exception:  # noqa: BLE001 — channel may be None on odd transports
            pass

    def _transport_alive(self) -> bool:
        try:
            transport = self.client.get_transport() if self.client else None
            return bool(transport and transport.is_active())
        except Exception:  # noqa: BLE001
            return False

    def _reconnect(self) -> bool:
        """Tear down and rebuild the session; return True on success."""
        self.close()
        for attempt in range(1, RECONNECT_ATTEMPTS + 1):
            try:
                time.sleep(min(RECONNECT_BACKOFF * attempt, RECONNECT_BACKOFF_MAX))
                self._open()
                self.stats.reconnects += 1
                print(f"  ~~ SFTP session re-established "
                      f"(reconnect #{self.stats.reconnects})", file=sys.stderr)
                return True
            except Exception as exc:  # noqa: BLE001 — keep trying until attempts run out
                print(f"  ~~ reconnect {attempt}/{RECONNECT_ATTEMPTS} failed: {exc}",
                      file=sys.stderr)
        return False

    def _run(self, op, retries: int = 2):
        """Run an SFTP op, rebuilding the session if the transport has died.

        A still-alive transport means the error is specific to this path
        (permission denied, no such file) — re-raise for the caller to handle.
        Only a dead transport triggers a reconnect + retry.
        """
        attempt = 0
        while True:
            try:
                return op()
            except Exception:
                if self._transport_alive():
                    raise
                attempt += 1
                if attempt > retries or not self._reconnect():
                    raise

    def listdir_attr(self, remote_dir: str):
        return self._run(lambda: self.sftp.listdir_attr(remote_dir))

    def get(self, remote_path: str, local_path: str):
        return self._run(lambda: self.sftp.get(remote_path, local_path))

    def stat(self, remote_path: str):
        return self._run(lambda: self.sftp.stat(remote_path))

    def close(self) -> None:
        if self.client is not None:
            try:
                self.client.close()
            except Exception:  # noqa: BLE001
                pass
        self.client = None
        self.sftp = None


def main() -> int:
    # Pre-parse --env-file so the .env is loaded BEFORE argparse defaults below
    # are resolved from os.environ. Real environment variables still take priority.
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    env_file = pre.parse_known_args()[0].env_file
    load_dotenv(env_file)

    def env(key: str, fallback):
        val = os.environ.get(key)
        return val if val not in (None, "") else fallback

    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--env-file", default=DEFAULT_ENV_FILE,
                   help="Path to a .env file with VPS_* credentials (default: .env beside script)")
    p.add_argument("--host", default=env("VPS_HOST", None))
    p.add_argument("--port", type=int, default=int(env("VPS_PORT", 22)))
    p.add_argument("--user", default=env("VPS_USER", "root"), help="SSH user (default: root)")
    p.add_argument("--sync", action="append", default=[], metavar='"REMOTE -> LOCAL [keep]"',
                   help="One-off pair, replacing the VPS_SYNC_* lines of the .env; repeatable")
    p.add_argument("--only", action="append", default=[], metavar="SUFFIX",
                   help="Run only VPS_SYNC_<SUFFIX> (e.g. --only 2); repeatable. The other "
                        "pairs still fence off their folders from the selected ones")
    p.add_argument("--migrate-env", action="store_true",
                   help="Rewrite the .env from VPS_REMOTE/VPS_LOCAL/VPS_EXTRA_ROOTS to "
                        "VPS_SYNC_n lines (backup kept; with --dry-run, print only)")
    p.add_argument("--password", help="SSH password (prefer VPS_SSH_PASSWORD in .env or --key-file)")
    p.add_argument("--key-passphrase", default=env("VPS_KEY_PASSPHRASE", None),
                   help="Passphrase for an encrypted --key-file (else prompted)")
    p.add_argument("--key-file", default=env("VPS_KEY_FILE", None),
                   help="Private key file for auth. Accepts ~, %%VARS%%/$VARS, or a "
                        "path relative to the .env's folder")
    p.add_argument("--exclude-file", default=DEFAULT_EXCLUDE_FILE,
                   help="Config file of paths/names to exclude (default: sync_exclude.conf)")
    p.add_argument("--log-dir", default=env("VPS_LOG_DIR", DEFAULT_LOG_DIR),
                   help="Directory for the per-run copy log (default: logs/ beside script)")
    p.add_argument("--exclude", action="append", default=[],
                   help="Extra exclude entry (absolute path, name, or glob); repeatable")
    p.add_argument("--follow-symlinks", action="store_true",
                   help="Follow symlinks instead of skipping them")
    p.add_argument("--strict-mtime", action="store_true",
                   help="Re-copy a same-size file whenever the remote mtime is newer "
                        "(legacy behavior). Default is size-first: a timestamp-only "
                        "drift realigns the local mtime instead of re-downloading.")
    p.add_argument("--dry-run", action="store_true",
                   help="Report what would be copied (and deleted) without writing anything")
    args = p.parse_args()

    if args.migrate_env:
        return migrate_env_file(os.path.abspath(args.env_file), args.dry_run)

    legacy = [k for k in LEGACY_KEYS if os.environ.get(k)]
    if legacy:
        lines, warnings = legacy_sync_lines({k: os.environ.get(k, "") for k in LEGACY_KEYS})
        print(f"ERROR: {', '.join(legacy)} are no longer read. Each mirrored folder is now one\n"
              f"       {SYNC_KEY_PREFIX}<n>=remote {SYNC_ARROW} local line. Equivalent of the "
              f"current config:", file=sys.stderr)
        for n, line in enumerate(lines, 1):
            print(f"         {SYNC_KEY_PREFIX}{n}={line}", file=sys.stderr)
        for w in warnings:
            print(f"       WARNING: {w}", file=sys.stderr)
        print(f"       Rewrite the .env automatically (backup kept):\n"
              f"         python sync_vps_docker.py --migrate-env --dry-run   # preview\n"
              f"         python sync_vps_docker.py --migrate-env", file=sys.stderr)
        return 2

    # Deletion propagation is set in the .env only (VPS_DELETE), not on the CLI:
    # a destructive mode belongs to the mirror's config, not to a one-off flag.
    delete_raw = env("VPS_DELETE", "false").strip().lower()
    if delete_raw not in ("true", "1", "yes", "on", "false", "0", "no", "off"):
        print(f"ERROR: VPS_DELETE must be true or false, got {delete_raw!r}.", file=sys.stderr)
        return 2
    args.delete = delete_raw in ("true", "1", "yes", "on")

    missing = [label for label, val in (("VPS_HOST / --host", args.host),) if not val]
    if missing:
        print(f"ERROR: missing required config: {', '.join(missing)}.\n"
              f"       Set it in {env_file} (copy from .env.example) or pass it on the CLI.",
              file=sys.stderr)
        return 2

    # The key path may be written with ~, %USERPROFILE%/$HOME, or relative to the
    # .env — paramiko understands none of those, so normalise before connecting.
    # Checking the file here matters: an unreadable key surfaces from paramiko as a
    # plain "authentication failed", which points at the wrong thing entirely.
    config_dir = os.path.dirname(os.path.abspath(env_file)) or _SCRIPT_DIR
    args.key_file = resolve_path(args.key_file, config_dir)
    if args.key_file and not os.path.isfile(args.key_file):
        print(f"ERROR: private key not found: {args.key_file}\n"
              f"       VPS_KEY_FILE / --key-file accepts ~, %VARS%, or a path relative\n"
              f"       to {config_dir}. Leave it empty to authenticate by password.",
              file=sys.stderr)
        return 2

    excludes = load_excludes(args.exclude_file, args.exclude)

    # Every mirrored folder is one explicit pair: VPS_SYNC_<suffix>=remote -> local,
    # with an optional [keep] / [delete] tag overriding VPS_DELETE for that pair.
    # Nothing is derived any more: the old "local base" computed from VPS_LOCAL
    # minus the VPS_REMOTE tail climbed to C:\ on 2026-10-08 when the two did not
    # match. --sync replaces the .env pairs for a one-off run.
    if args.sync:
        raw_pairs = [(str(n), text) for n, text in enumerate(args.sync, 1)]
    else:
        raw_pairs = sorted(((k[len(SYNC_KEY_PREFIX):], v) for k, v in os.environ.items()
                            if k.startswith(SYNC_KEY_PREFIX) and v.strip()),
                           key=lambda kv: _sync_key_order(kv[0]))
    if not raw_pairs:
        print(f"ERROR: nothing to sync. Add {SYNC_KEY_PREFIX}1=/remote/folder {SYNC_ARROW} "
              f"C:\\local\\folder to {env_file}, or pass --sync.", file=sys.stderr)
        return 2
    pairs: list[SyncPair] = []
    errors: list[str] = []
    for label, text in raw_pairs:
        try:
            pairs.append(parse_sync_pair(label, text, config_dir, args.delete))
        except ValueError as exc:
            errors.append(f"{SYNC_KEY_PREFIX}{label}: {exc}")
    errors += check_sync_pairs(pairs)
    unknown = [o for o in args.only if o not in {sp.label for sp in pairs}]
    if unknown:
        errors.append(f"--only {', '.join(unknown)}: no such {SYNC_KEY_PREFIX}<suffix> "
                      f"(known: {', '.join(sp.label for sp in pairs)})")
    if errors:
        print("ERROR: invalid sync configuration:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 2
    # Fences come from ALL pairs, even with --only: a nested pair keeps its subtree
    # out of reach of the outer one whether or not it runs this time.
    other_roots = {sp.remote for sp in pairs}
    selected = [sp for sp in pairs if not args.only or sp.label in args.only]

    print(f"Syncing  {args.user}@{args.host}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'} | "
          f"symlinks: {'followed' if args.follow_symlinks else 'skipped'} | "
          f"default deletions (VPS_DELETE): {'propagated' if args.delete else 'off'}")
    if args.exclude_file and os.path.isfile(args.exclude_file):
        print(f"Exclude file: {args.exclude_file}")
    print(f"Exclude rules ({len(excludes)}): {excludes if excludes else '(none — full tree)'}")
    print(f"Pairs ({len(selected)} of {len(pairs)}):")
    for sp in selected:
        print(f"  {SYNC_KEY_PREFIX}{sp.label}: {sp.remote}  ->  {sp.local}  "
              f"[{'delete' if sp.delete else 'keep'}]")
    print("=" * 70)

    stats = Stats()
    started = time.time()

    # Per-run copy log (logs/sync_vps_docker_<YYYYMMDD>_<HHMMSS>.log). Disabled on
    # a dry run since nothing is actually copied.
    if args.dry_run:
        log = CopyLog(None)
    else:
        log_name = time.strftime("sync_vps_docker_%Y%m%d_%H%M%S.log",
                                 time.localtime(started))
        log = CopyLog(os.path.join(args.log_dir, log_name))
        print(f"Copy log: {log.path}")

    session = None
    try:
        session = SftpSession(args, stats)
        for sp in selected:
            remote_root = sp.remote
            try:
                session.stat(remote_root)
            except IOError:
                print(f"  (skip) remote root not found: {remote_root}", file=sys.stderr)
                continue
            print(f"\n>>> {SYNC_KEY_PREFIX}{sp.label}: {remote_root}  ->  {sp.local}  "
                  f"[{'delete' if sp.delete else 'keep'}]")
            try:
                sync_dir(session, remote_root, sp.local, stats, excludes,
                         follow_symlinks=args.follow_symlinks, dry_run=args.dry_run,
                         other_roots=other_roots, log=log, strict_mtime=args.strict_mtime,
                         delete=sp.delete)
            except Exception as exc:  # noqa: BLE001 — isolate a root failure so the
                # remaining roots still sync (e.g. a reconnect that ultimately failed).
                stats.failed += 1
                print(f"  !! root aborted: {remote_root}: {exc} — continuing with next root",
                      file=sys.stderr)
    except paramiko.AuthenticationException:
        print("ERROR: authentication failed. Check user/password/key.", file=sys.stderr)
        return 3
    except Exception as exc:  # noqa: BLE001 — top-level guard
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        log.close()
        if session is not None:
            session.close()

    finished = time.time()
    elapsed = finished - started
    print("-" * 70)
    print(f"Done in {elapsed:.1f}s")
    print(f"  started:      {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(started))}")
    print(f"  finished:     {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(finished))}")
    print(f"  new:          {stats.copied_new}")
    print(f"  updated:      {stats.copied_newer}")
    print(f"  up-to-date:   {stats.skipped}")
    print(f"  mtime realgn: {stats.reconciled}")
    print(f"  excluded:     {stats.excluded}")
    print(f"  dirs created: {stats.dirs_created}")
    if any(sp.delete for sp in selected):
        print(f"  deleted:      {stats.deleted_files} files, {stats.deleted_dirs} dirs")
    print(f"  failed:       {stats.failed}")
    print(f"  reconnects:   {stats.reconnects}")
    print(f"  data copied:  {human(stats.bytes_copied)}")
    if log.opened:
        print(f"  copy log:     {log.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
