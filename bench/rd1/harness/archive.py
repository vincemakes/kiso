#!/usr/bin/env python3
"""RD-1 batch archival — the immutable pair.

A benchmark whose raw artifacts live only on the operator's disk asks
the reader to trust the report. RD-1B's first report claimed the
artifacts were "all git tracked" while .gitignore ignored out/ wholesale
and `git ls-files bench/rd1/out` returned zero; the numbers were correct
and the claim was not, which is the same failure in miniature as the
report's own attribution errors — a sentence nobody re-derived.

This writes two files per batch into bench/rd1/artifacts/:

  <batch>.tar.gz    the whole cell tree, byte for byte, nested work/.git
                    repos included — extract and re-score it
  <batch>.sha256    a per-file SHA-256 manifest, sorted, plain text —
                    verify ONE file without extracting anything, and
                    diff two batches to see exactly what moved

`--verify` reads the TARBALL and re-hashes its entries against the
manifest, so it proves the tracked evidence is intact from a fresh
clone. It used to hash the LIVE out/ tree, which reported DRIFTED
wherever the working directory simply was not present — a diagnosis
about the wrong artifact. `--verify-live` keeps that check, for use
while a batch is still being produced.

Usage:  python3 bench/rd1/harness/archive.py rd1b-kiso rd1b-pi ...
        python3 bench/rd1/harness/archive.py --verify rd1b-kiso
        python3 bench/rd1/harness/archive.py --verify-live rd1b-kiso
"""
import gzip
import hashlib
import os
import sys
import tarfile

RD1 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(RD1, "out")
ARTIFACTS = os.path.join(RD1, "artifacts")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_lines(root):
    """Every file under root, sorted, as `<sha256>  <relative path>`.
    Sorted so the manifest is a stable diff target across batches."""
    rows = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rows.append(f"{sha256(full)}  {os.path.relpath(full, os.path.dirname(root))}")
    rows.sort(key=lambda r: r.split("  ", 1)[1])
    return rows


def archive(batch):
    root = os.path.join(OUT, batch)
    if not os.path.isdir(root):
        print(f"[rd1:archive] no such batch: {root}", file=sys.stderr)
        return 1
    os.makedirs(ARTIFACTS, exist_ok=True)
    rows = manifest_lines(root)
    mpath = os.path.join(ARTIFACTS, f"{batch}.sha256")
    with open(mpath, "w") as f:
        f.write("\n".join(rows) + "\n")
    tpath = os.path.join(ARTIFACTS, f"{batch}.tar.gz")
    # mtime is zeroed and entries are added in sorted order so the same
    # tree archives to the same bytes — an archive that changes when
    # nothing changed is not evidence.
    # gzip stamps its own mtime in the header, so the GzipFile is opened
    # explicitly with mtime=0 rather than through tarfile's "w:gz".
    with open(tpath, "wb") as raw, gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as tar:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames.sort()
                for name in sorted(filenames):
                    full = os.path.join(dirpath, name)
                    if os.path.islink(full) or not os.path.isfile(full):
                        continue
                    info = tar.gettarinfo(full, arcname=os.path.relpath(full, os.path.dirname(root)))
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    with open(full, "rb") as fh:
                        tar.addfile(info, fh)
    print(f"[rd1:archive] {batch}: {len(rows)} files → {os.path.relpath(tpath, RD1)} "
          f"({os.path.getsize(tpath) // 1024} KB) + {os.path.relpath(mpath, RD1)}")
    return 0


def _recorded(batch):
    mpath = os.path.join(ARTIFACTS, f"{batch}.sha256")
    if not os.path.exists(mpath):
        print(f"[rd1:archive] no manifest for {batch}", file=sys.stderr)
        return None
    return dict(reversed(l.split("  ", 1)) for l in open(mpath).read().splitlines() if l)


def _diff(batch, recorded, present, source):
    missing = sorted(set(recorded) - set(present))
    added = sorted(set(present) - set(recorded))
    changed = sorted(p for p in set(recorded) & set(present) if recorded[p] != present[p])
    for label, rows in (("MISSING", missing), ("ADDED", added), ("CHANGED", changed)):
        for p in rows:
            print(f"[rd1:archive] {label} {p}")
    ok = not (missing or added or changed)
    print(f"[rd1:archive] {batch}: {'INTACT' if ok else 'DRIFTED'} "
          f"({len(recorded)} files recorded, checked against the {source})")
    return 0 if ok else 1


def verify(batch):
    """Re-hash the TARBALL's entries and diff against the manifest.

    Streams each member rather than extracting: the check must not
    depend on scratch space, and must work in a clone that has never
    produced a batch.
    """
    recorded = _recorded(batch)
    if recorded is None:
        return 1
    tpath = os.path.join(ARTIFACTS, f"{batch}.tar.gz")
    if not os.path.exists(tpath):
        print(f"[rd1:archive] no archive for {batch}", file=sys.stderr)
        return 1
    present = {}
    with tarfile.open(tpath, "r:gz") as tar:
        for member in tar:
            if not member.isfile():
                continue
            fh = tar.extractfile(member)
            if fh is None:
                continue
            h = hashlib.sha256()
            for chunk in iter(lambda: fh.read(1 << 16), b""):
                h.update(chunk)
            present[member.name] = h.hexdigest()
    return _diff(batch, recorded, present, "tarball")


def verify_live(batch):
    """Re-hash the live out/ tree — for use before archiving."""
    recorded = _recorded(batch)
    if recorded is None:
        return 1
    root = os.path.join(OUT, batch)
    if not os.path.isdir(root):
        print(f"[rd1:archive] no live tree at {root} "
              f"(use --verify to check the tracked archive)", file=sys.stderr)
        return 1
    present = dict(reversed(l.split("  ", 1)) for l in manifest_lines(root))
    return _diff(batch, recorded, present, "live out/ tree")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    if args[0] == "--verify":
        return max((verify(b) for b in args[1:]), default=2)
    if args[0] == "--verify-live":
        return max((verify_live(b) for b in args[1:]), default=2)
    return max((archive(b) for b in args), default=2)


if __name__ == "__main__":
    sys.exit(main())
