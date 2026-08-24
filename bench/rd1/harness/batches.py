"""Materialize a scored batch — from the TRACKED ARCHIVE by default.

RD-1B's report promised four commands would re-derive its numbers from
the archived artifacts. They read `bench/rd1/out/` instead — untracked —
so they reproduced nothing outside the author's machine. Worse, the
re-scorer failed SILENTLY: an empty grid, `0/0 cells`, exit 0.

Two things follow, and both live here so all three tools share them:

1. **The archive is the default source.** `open_batch` extracts
   `artifacts/<batch>.tar.gz` into a temp directory. `--live` opts back
   into the working directory, which is the right source only while a
   batch is still being produced.

2. **Manifest paths are relocated in memory.** Every score-manifest
   records absolute paths from the machine that ran the batch
   (`/Users/.../bench/rd1/out/<batch>/<cell>/...`). Those cannot resolve
   anywhere else, so `relocate` rewrites everything after the `/out/`
   segment onto the materialized root. Nothing on disk is edited: the
   frozen artifacts stay frozen.

Absent evidence is an ERROR here, never an empty result. A tool that
prints nothing and exits 0 is indistinguishable from a tool that worked.
"""
import contextlib
import os
import tarfile
import tempfile

RD1 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(RD1, "out")
ARTIFACTS = os.path.join(RD1, "artifacts")


class BatchUnavailable(Exception):
    """No evidence for this batch — the caller must exit non-zero."""


def archive_path(batch):
    return os.path.join(ARTIFACTS, f"{batch}.tar.gz")


def manifest_path(batch):
    return os.path.join(ARTIFACTS, f"{batch}.sha256")


@contextlib.contextmanager
def open_batch(batch, live=False):
    """Yield the directory holding this batch's cells.

    live=False (default): the tracked tarball, extracted to a temp dir
    that is removed on exit. live=True: out/<batch>, used in place.
    """
    if live:
        root = os.path.join(OUT, batch)
        if not os.path.isdir(root):
            raise BatchUnavailable(f"no live batch at {root} (drop --live to read the tracked archive)")
        yield root
        return
    tar = archive_path(batch)
    if not os.path.exists(tar):
        raise BatchUnavailable(f"no archive at {os.path.relpath(tar, RD1)} — run `archive.py {batch}` first")
    with tempfile.TemporaryDirectory(prefix=f"rd1-{batch}-") as tmp:
        with tarfile.open(tar, "r:gz") as t:
            # The arcnames are "<batch>/<cell>/...", so tmp plays the
            # role out/ plays on the producing machine.
            _safe_extract(t, tmp)
        root = os.path.join(tmp, batch)
        if not os.path.isdir(root):
            raise BatchUnavailable(f"{os.path.basename(tar)} holds no {batch}/ directory")
        yield root


def _safe_extract(tar, dest):
    """Extract under the strictest filter available.

    A path check alone is not enough: a symlink member whose LINK target
    escapes passes any name-based test, and a later member written
    through that link lands outside the root. Python's "data" filter
    handles the whole family (absolute paths, .., escaping links,
    setuid bits, devices and fifos) and raises rather than skipping,
    so it is the primary defence. The explicit checks stay as a
    readable statement of intent and as the fallback on interpreters
    without the filter.
    """
    dest_abs = os.path.abspath(dest)
    for member in tar.getmembers():
        if not (member.isfile() or member.isdir()):
            raise BatchUnavailable(
                f"archive holds a non-regular entry ({member.name}); batches are files and directories only")
        target = os.path.abspath(os.path.join(dest, member.name))
        if not (target == dest_abs or target.startswith(dest_abs + os.sep)):
            raise BatchUnavailable(f"archive entry escapes the extraction root: {member.name}")
    try:
        tar.extractall(dest, filter="data")
    except TypeError:  # interpreter without extraction filters
        tar.extractall(dest)


def relocate(value, root):
    """Rewrite recorded absolute paths onto `root`, in memory.

    Any string carrying an `/out/<batch>/...` segment is re-rooted; a
    string without one is returned untouched (and whatever reads it will
    fail loudly, which is the intent). Recurses through dicts and lists.
    """
    if isinstance(value, str):
        marker = f"{os.sep}out{os.sep}"
        idx = value.rfind(marker)
        if idx < 0:
            return value
        tail = value[idx + len(marker):]
        # tail is "<batch>/<cell>/..."; root is ".../<batch>", so the
        # batch segment is dropped rather than doubled.
        parts = tail.split(os.sep, 1)
        return os.path.join(root, parts[1]) if len(parts) == 2 else root
    if isinstance(value, dict):
        return {k: relocate(v, root) for k, v in value.items()}
    if isinstance(value, list):
        return [relocate(v, root) for v in value]
    return value


def cells(root):
    """The batch's cell directories, in scenario order."""
    names = [c for c in os.listdir(root) if os.path.isdir(os.path.join(root, c)) and c.startswith("c")]
    return sorted(names, key=lambda c: (int(c.split("-")[0][1:]), c))
