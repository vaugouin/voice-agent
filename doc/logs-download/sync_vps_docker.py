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
  * NEVER deletes anything locally — files removed on the VPS stay in the mirror.
  * One-way only (remote -> local). Local changes are never pushed up.
  * Resilient to dropped SFTP sessions: if the SSH transport dies mid-walk, the
    session is rebuilt and the failing operation retried, and a failure in one
    top-level root is isolated so the remaining roots still sync — so a single
    channel blip no longer aborts the whole run and silently starves the tail
    of the alphabet.

By default it runs as **root** so it can read EVERYTHING (incl. root-owned TLS
private keys and the ChromaDB store). It mirrors the main `--remote`
(/home/debian/docker) PLUS extra system roots (/var/spool/cron/crontabs,
/var/lib/docker/volumes, /var/lib/bind, /etc, /home/debian, /root — set via
VPS_EXTRA_ROOTS in .env),
each mapped under the same local base so the copy mirrors the VPS filesystem
(remote /etc -> <base>\etc). Use --no-extra-roots to sync only the main tree.
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
override both. Recognised keys: VPS_HOST, VPS_PORT, VPS_USER, VPS_REMOTE,
VPS_LOCAL, VPS_EXTRA_ROOTS, VPS_KEY_FILE, VPS_SSH_PASSWORD. The .env is
git/docker-ignored.

Usage (PowerShell):
  pip install paramiko
  copy .env.example .env   # then edit .env and set VPS_SSH_PASSWORD
  python sync_vps_docker.py              # root@host, full tree minus excludes
  python sync_vps_docker.py --dry-run    # show what WOULD be copied
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
import stat
import sys
import time
from getpass import getpass

import paramiko

# --------------------------------------------------------------------------- #
# Connection config (VPS_HOST, VPS_PORT, VPS_USER, VPS_REMOTE, VPS_LOCAL, the
# password, ...) is NOT hardcoded here — it lives in .env (git/docker-ignored,
# see .env.example) or on the command line. The argparse defaults below read it
# straight from the environment; VPS_HOST and VPS_LOCAL are required (validated
# after parsing), while VPS_PORT/VPS_USER/VPS_REMOTE fall back to generic,
# non-sensitive literals if the .env omits them.
# --------------------------------------------------------------------------- #

# Extra remote roots OUTSIDE the main tree are mirrored under the same local base
# (e.g. remote /etc -> <base>\etc, where <base> is VPS_LOCAL minus the VPS_REMOTE
# tail). Reading most of these needs root (VPS_USER=root). The list is NOT
# hardcoded here — it lives in VPS_EXTRA_ROOTS in the .env (comma-separated; see
# .env.example for the canonical list with per-path notes). Disable the whole
# set with --no-extra-roots; add more with repeatable --extra-root.

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


def sync_dir(session, remote_dir: str, local_dir: str, stats: Stats,
             excludes: list[str], follow_symlinks: bool, dry_run: bool,
             other_roots: set[str], log: CopyLog, strict_mtime: bool = False) -> None:
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
                     follow_symlinks, dry_run, other_roots, log, strict_mtime)
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


def connect(args) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kwargs = dict(hostname=args.host, port=args.port, username=args.user,
                  timeout=CONNECT_TIMEOUT, banner_timeout=CONNECT_TIMEOUT,
                  auth_timeout=CONNECT_TIMEOUT)
    if args.key_file:
        kwargs["key_filename"] = args.key_file
    else:
        password = args.password or os.environ.get("VPS_SSH_PASSWORD")
        if not password:
            password = getpass(f"Password for {args.user}@{args.host}: ")
        kwargs["password"] = password
        kwargs["look_for_keys"] = False
        kwargs["allow_agent"] = False

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
    p.add_argument("--remote", default=env("VPS_REMOTE", "/home/debian/docker"), help="Remote root dir")
    p.add_argument("--local", default=env("VPS_LOCAL", None), help="Local mirror root dir")
    p.add_argument("--password", help="SSH password (prefer VPS_SSH_PASSWORD in .env or --key-file)")
    p.add_argument("--key-file", default=env("VPS_KEY_FILE", None),
                   help="Path to a private key file for auth")
    p.add_argument("--exclude-file", default=DEFAULT_EXCLUDE_FILE,
                   help="Config file of paths/names to exclude (default: sync_exclude.conf)")
    p.add_argument("--log-dir", default=env("VPS_LOG_DIR", DEFAULT_LOG_DIR),
                   help="Directory for the per-run copy log (default: logs/ beside script)")
    p.add_argument("--exclude", action="append", default=[],
                   help="Extra exclude entry (absolute path, name, or glob); repeatable")
    p.add_argument("--extra-root", action="append", default=[],
                   help="Additional remote root to mirror under the local base; repeatable")
    p.add_argument("--no-extra-roots", action="store_true",
                   help="Sync only the main --remote tree (skip /etc, /var/lib/docker/volumes, ...)")
    p.add_argument("--follow-symlinks", action="store_true",
                   help="Follow symlinks instead of skipping them")
    p.add_argument("--strict-mtime", action="store_true",
                   help="Re-copy a same-size file whenever the remote mtime is newer "
                        "(legacy behavior). Default is size-first: a timestamp-only "
                        "drift realigns the local mtime instead of re-downloading.")
    p.add_argument("--dry-run", action="store_true",
                   help="Report what would be copied without writing anything")
    args = p.parse_args()

    missing = [label for label, val in (("VPS_HOST / --host", args.host),
                                        ("VPS_LOCAL / --local", args.local)) if not val]
    if missing:
        print(f"ERROR: missing required config: {', '.join(missing)}.\n"
              f"       Set it in {env_file} (copy from .env.example) or pass it on the CLI.",
              file=sys.stderr)
        return 2

    excludes = load_excludes(args.exclude_file, args.exclude)

    # The local base is VPS_LOCAL minus the VPS_REMOTE tail, e.g.
    #   /home/debian/docker  +  ...\ovh-pv5\home\debian\docker   ->   ...\ovh-pv5
    # Extra roots map remote /X -> <base>\X so the local copy mirrors the VPS fs.
    main_remote = args.remote.rstrip("/")
    local_base = args.local
    for _ in [p for p in main_remote.strip("/").split("/") if p]:
        local_base = os.path.dirname(local_base)

    def local_for(remote_path: str) -> str:
        parts = [p for p in remote_path.strip("/").split("/") if p]
        return os.path.join(local_base, *parts)

    # Build the ordered list of (remote, local) roots. The base extra roots come
    # from VPS_EXTRA_ROOTS in the .env (comma-separated); --no-extra-roots drops
    # them, while explicit --extra-root flags are always honoured (appended).
    extra = list(args.extra_root)
    if not args.no_extra_roots:
        env_roots = [r.strip().rstrip("/")
                     for r in env("VPS_EXTRA_ROOTS", "").split(",") if r.strip()]
        extra = env_roots + extra
    roots: list[tuple[str, str]] = [(main_remote, args.local)]
    for r in extra:
        r = r.rstrip("/")
        if r and r not in {rt for rt, _ in roots}:
            roots.append((r, local_for(r)))
    other_roots = {r for r, _ in roots}

    print(f"Syncing  {args.user}@{args.host}  (local base: {local_base})")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'} | "
          f"symlinks: {'followed' if args.follow_symlinks else 'skipped'}")
    if args.exclude_file and os.path.isfile(args.exclude_file):
        print(f"Exclude file: {args.exclude_file}")
    print(f"Exclude rules ({len(excludes)}): {excludes if excludes else '(none — full tree)'}")
    print(f"Roots ({len(roots)}): {', '.join(r for r, _ in roots)}")
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
        for remote_root, local_root in roots:
            try:
                session.stat(remote_root)
            except IOError:
                print(f"  (skip) remote root not found: {remote_root}", file=sys.stderr)
                continue
            print(f"\n>>> {remote_root}  ->  {local_root}")
            try:
                sync_dir(session, remote_root, local_root, stats, excludes,
                         follow_symlinks=args.follow_symlinks, dry_run=args.dry_run,
                         other_roots=other_roots, log=log, strict_mtime=args.strict_mtime)
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

    elapsed = time.time() - started
    print("-" * 70)
    print(f"Done in {elapsed:.1f}s")
    print(f"  new:          {stats.copied_new}")
    print(f"  updated:      {stats.copied_newer}")
    print(f"  up-to-date:   {stats.skipped}")
    print(f"  mtime realgn: {stats.reconciled}")
    print(f"  excluded:     {stats.excluded}")
    print(f"  dirs created: {stats.dirs_created}")
    print(f"  failed:       {stats.failed}")
    print(f"  reconnects:   {stats.reconnects}")
    print(f"  data copied:  {human(stats.bytes_copied)}")
    if log.opened:
        print(f"  copy log:     {log.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
