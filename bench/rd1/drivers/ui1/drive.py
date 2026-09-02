#!/usr/bin/env python3
"""UI-1 driver — the walkthrough's nine items, driven against a real model.

The R4..R8b gates all judge ONE frame. UI-1 exists for what only timing
produces: a turn interrupted, a message typed while work is in flight, a
screen alive long enough to have scrolled, a panel over a standing block.
See ../../scenarios/UI-1-walkthrough.md.

This script only DRIVES and CAPTURES. It asserts nothing — the whole byte
stream plus a sidecar of phase offsets is the artifact; probe.py is what
turns that into verdicts. Keeping the two apart is deliberate: a driver
that also judges is a driver that can talk itself into a pass.

Run against the INSTALLED binary, never the repo's dist (the release
ceremony's rule).

usage:
    OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=... \
        drive.py --out <dir> [--cli kiso] [--cols 100] [--rows 30]
"""
import argparse
import codecs
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time

# Needles are matched on the ESCAPE-STRIPPED text, never on the wire.
# kiso's own words are routinely split by SGR — the settlement line goes
# out as "\x1b[2m<glyph>\x1b[0m took" — so a needle matched against raw
# bytes is a needle that silently never matches, and a driver whose waits
# silently never match is a driver that reports timeouts as findings.
# Law 1.2 (strip every escape and no fact is lost) is the driver's rule
# too. This repo has now been bitten by the non-contiguous needle five
# times; the fix is structural, not another needle.
COMPOSER = "▌"  # the composer's left bar
APPROVAL = "Yes, run it"  # the approval panel's first option — an
# ask_user panel says "confirms" too (item 3 caught the model opening
# one unprompted), so the affordance is not specific enough a needle.

# IDLE IS A STATE, NOT AN EVENT. Every frame repaints every row (V6-1),
# so a settlement line that is still on screen is re-emitted in every
# frame that follows it: "have I seen '<glyph> took' since X" answers yes
# instantly from the second turn on, and a driver built on that reports a
# twenty-turn session finishing in four tenths of a second. What actually
# says whether a turn is running is what the STATUS LINE says NOW — so the
# test is which of these two was written LAST.
BUSY = "esc stop"  # the working status offers a stop
IDLE = "/mode to switch"  # the settled status offers the mode

ESC_RE = re.compile(
    r"\x1b\[[0-9;?]*[A-Za-z]"  # CSI
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC
    r"|\x1b[()][0-9A-Za-z]"  # charset
    r"|\x1b[=><]"  # keypad / misc
)

DEADLINE = 900.0
IDLE_GRACE = 120.0


class Plain:
    """The escape-stripped view of the stream, maintained incrementally.

    Stripping the whole buffer on every poll would be quadratic, so this
    keeps a decode cursor and holds back a trailing escape that has not
    finished arriving."""

    def __init__(self):
        self.text = ""
        self._dec = codecs.getincrementaldecoder("utf-8")("replace")
        self._pending = ""

    def push(self, chunk):
        self._pending += self._dec.decode(chunk)
        cut = len(self._pending)
        k = self._pending.rfind("\x1b")
        if k >= 0 and ESC_RE.match(self._pending, k) is None:
            cut = k  # an escape that has not finished arriving — hold it
        head, self._pending = self._pending[:cut], self._pending[cut:]
        self.text += ESC_RE.sub("", head)


class Pty:
    """A pty that keeps every byte, and can wait on what it SAYS."""

    def __init__(self, argv, env, cwd, cols, rows):
        self.buf = bytearray()
        self.plain = Plain()
        self.marks = []
        self.cols = cols
        self.t0 = time.time()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.environ.clear()
            os.environ.update(env)
            os.execvp(argv[0], argv)
        self.resize(cols, rows)

    def _absorb(self, chunk):
        self.buf += chunk
        self.plain.push(chunk)

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.cols = cols

    def mark(self, name, **kw):
        """Record WHERE in the stream something happened. probe.py slices
        the capture on these, and the width ones tell it when to resize
        its own model of the terminal."""
        self.marks.append({"at": len(self.buf), "name": name, "t": round(time.time() - self.t0, 3), **kw})

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.02)
            if not r:
                continue
            try:
                d = os.read(self.fd, 65536)
            except OSError:
                return False
            if not d:
                return False
            self._absorb(d)
        return True

    def wait(self, needle, timeout, why, since=None):
        """Wait until the stripped text says `needle`, from `since` on.

        The RD-1 lesson (R-I-p2): a driver that drains and THEN waits for a
        needle starves, because the needle already went by. `since` is a
        plain-text offset the caller captured BEFORE the action, so the
        search covers everything the action produced."""
        base = self.plain_at() if since is None else since
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    d = os.read(self.fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                self._absorb(d)
            if needle in self.plain.text[base:]:
                return True
        self.mark("TIMEOUT", why=why, needle=needle)
        return False

    def plain_at(self):
        return len(self.plain.text)

    def state(self):
        """busy / idle / unknown — whichever status marker was written last."""
        b = self.plain.text.rfind(BUSY)
        i = self.plain.text.rfind(IDLE)
        if b < 0 and i < 0:
            return "unknown"
        return "busy" if b > i else "idle"

    def wait_state(self, want, timeout, why, hold=0.0):
        """Wait until the status line has SAID `want` for `hold` seconds.

        The hold matters on the idle side: the frame right before a turn
        starts is also idle, so a bare check races the send."""
        end = time.time() + timeout
        since = None
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    d = os.read(self.fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                self._absorb(d)
            if self.state() == want:
                if since is None:
                    since = time.time()
                if time.time() - since >= hold:
                    return True
            else:
                since = None
        self.mark("TIMEOUT", why=why, want=want, state=self.state())
        return False

    def turn(self, text, busy_timeout=60.0, settle_timeout=180.0):
        """Send a prompt and wait out the whole turn: busy, then idle.

        The busy leg is what makes the idle leg mean anything — without it
        the idle check passes on the state the composer was already in."""
        p_at = self.plain_at()
        self.send(text.encode() + b"\r")
        if not self.wait_state("busy", busy_timeout, why=f"busy:{text[:28]}"):
            return p_at
        self.wait_state("idle", settle_timeout, why=f"settle:{text[:28]}", hold=0.4)
        return p_at

    def send(self, data):
        os.write(self.fd, data)

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
            time.sleep(0.3)
            os.kill(self.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def make_workspace():
    """Six small real files, so 'read four at once' has four to read and
    the model has something true to say about them."""
    ws = tempfile.mkdtemp(prefix="ui1-ws-")
    files = {
        "alpha.py": "def alpha(n):\n    return n * 2\n",
        "beta.py": "def beta(n):\n    return n + 1\n",
        "gamma.py": "def gamma(n):\n    return n ** 2\n",
        "delta.py": "def delta(n):\n    return n - 3\n",
        "notes.txt": "alpha doubles, beta increments, gamma squares, delta subtracts three.\n",
        "README.md": "# ui1 fixture\n\nFour tiny modules and a note about them.\n",
    }
    for name, body in files.items():
        with open(os.path.join(ws, name), "w") as f:
            f.write(body)
    return ws


def run(out, cli, cols, rows):
    ws = make_workspace()
    home = tempfile.mkdtemp(prefix="ui1-home-")
    env = {
        "HOME": home,
        "KISO_HOME": home,
        "PATH": os.environ.get("PATH", ""),
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "OPENAI_API_KEY": os.environ["OPENAI_API_KEY"],
        "OPENAI_BASE_URL": os.environ.get("OPENAI_BASE_URL", ""),
        "OPENAI_MODEL": os.environ.get("OPENAI_MODEL", ""),
        "KISO_MODE": "bypass",
    }
    p = Pty([cli], env, ws, cols, rows)
    started = time.time()
    try:
        if not p.wait(COMPOSER, 40.0, why="boot", since=0):
            p.mark("BOOT_FAILED")
            return p

        # ---- item 1: a long first turn -------------------------------
        p.mark("item1.begin")
        p.send(
            b"Read alpha.py, beta.py, gamma.py and delta.py, then read notes.txt "
            b"and README.md, then list the directory, then tell me in one sentence "
            b"whether notes.txt describes the four modules correctly.\r"
        )
        # ---- item 2: steer, while item 1 is still in flight ----------
        p.wait_state("busy", 60.0, why="item1:busy")
        p.pump(2.5)
        p.mark("item2.steer.send")
        p.send(b"Also mention which file is the longest.\r")
        p.pump(1.0)
        p.mark("item2.steer.sent")
        p.wait_state("idle", 240.0, why="item1:settle", hold=0.4)
        p.mark("item1.end")

        # ---- item 3: interrupt --------------------------------------
        p.mark("item3.begin")
        p.send(
            b"Run these five shell commands, one separate call each, in order: "
            b"`sleep 3 && echo a`, `sleep 3 && echo b`, `sleep 3 && echo c`, "
            b"`sleep 3 && echo d`, `sleep 3 && echo e`. Do not ask me anything; "
            b"just run them.\r"
        )
        p.wait_state("busy", 60.0, why="item3:busy")
        p.pump(4.0)
        p.mark("item3.esc")
        p.send(b"\x1b")
        p.wait_state("idle", 60.0, why="item3:stopped", hold=0.4)
        p.pump(1.0)
        p.mark("item3.end")

        # ---- item 5: a parallel burst -------------------------------
        p.mark("item5.begin")
        p.turn(
            "Read alpha.py, beta.py, gamma.py and delta.py in parallel, "
            "in one batch, and say nothing but OK.",
            settle_timeout=180.0,
        )
        p.mark("item5.end")

        # ---- item 6: ctrl+o mid-stream ------------------------------
        p.mark("item6.begin")
        p.send(
            b"Run these three shell commands, one separate call each: "
            b"`sleep 4 && echo one`, `sleep 4 && echo two`, `sleep 4 && echo three`. "
            b"Do not ask me anything.\r"
        )
        p.wait_state("busy", 60.0, why="item6:busy")
        p.pump(3.0)
        # item6.open is BEFORE the keystroke and item6.closed AFTER the
        # second one, so probe C's pair brackets the viewer's whole life.
        # item6.up is the one to LOOK at — the viewer is on screen there.
        p.mark("item6.open")
        p.send(b"\x0f")  # ctrl+o
        p.pump(4.0)
        p.mark("item6.up")
        p.mark("item6.close")
        p.send(b"\x0f")
        p.pump(2.0)
        p.mark("item6.closed")
        p.wait_state("idle", 240.0, why="item6:settle", hold=0.4)
        p.mark("item6.end")

        # ---- item 7: the command band -------------------------------
        p.mark("item7.begin")
        p.send(b"/")
        p.pump(1.5)
        p.mark("item7.opened")
        for _ in range(6):
            p.send(b"\x1b[B")
            p.pump(0.45)
        p.mark("item7.scrolled")
        p.send(b"\x1b")
        p.pump(1.0)
        p.mark("item7.end")

        # ---- item 8: a long session ---------------------------------
        p.mark("item8.begin")
        for i in range(1, 21):
            if time.time() - started > DEADLINE - IDLE_GRACE:
                p.mark("item8.cut-short", at_turn=i)
                break
            p.mark("item8.turn", n=i)
            p.turn(f"Say only the number {i}.", settle_timeout=60.0)
        p.mark("item8.turns-done")
        # the resize, on a screen that has certainly scrolled
        p.mark("item8.widen", cols=cols + 40)
        p.resize(cols + 40, rows)
        p.pump(3.0)
        p.mark("item8.rewrap")
        p.send(b"/rewrap\r")
        p.pump(3.0)
        p.mark("item8.end")

        # ---- item 9: narrow + CJK -----------------------------------
        p.mark("item9.narrow", cols=50)
        p.resize(50, rows)
        p.pump(3.0)
        p.mark("item9.begin")
        p.turn(
            "Run `ls -la` and then explain in Chinese, in about eighty "
            "characters, what these files do.",
            settle_timeout=240.0,
        )
        p.mark("item9.end")
    finally:
        p.pump(2.0)
        p.close()
        shutil.rmtree(ws, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)
    return p


def run_approval(out, cli, cols, rows):
    """Item 4 alone, in a tier that ASKS.

    It needs its own run: the main leg is driven in bypass so that eight
    tools in a row actually happen, and a tier is fixed for a session.
    What this leg is for is the panel arriving ON TOP of a standing block
    and the block being intact after it goes."""
    ws = make_workspace()
    home = tempfile.mkdtemp(prefix="ui1-home-")
    env = {
        "HOME": home,
        "KISO_HOME": home,
        "PATH": os.environ.get("PATH", ""),
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "OPENAI_API_KEY": os.environ["OPENAI_API_KEY"],
        "OPENAI_BASE_URL": os.environ.get("OPENAI_BASE_URL", ""),
        "OPENAI_MODEL": os.environ.get("OPENAI_MODEL", ""),
        "KISO_MODE": "default",  # reads run; writes, edits and shell ask
    }
    p = Pty([cli], env, ws, cols, rows)
    try:
        if not p.wait(COMPOSER, 40.0, why="boot", since=0):
            p.mark("BOOT_FAILED")
            return p
        # a standing block FIRST, so the panel has something to arrive on
        p.mark("item4.block")
        base = p.plain_at()
        p.send(
            b"Read alpha.py, beta.py, gamma.py, delta.py and notes.txt, "
            b"then append the line 'checked' to notes.txt.\r"
        )
        p.wait_state("busy", 60.0, why="item4:busy")
        # the panel: wait for the affordance's confirm glyph, which nothing
        # else in this leg emits ("esc" alone would match half the chrome)
        got = p.wait(APPROVAL, 180.0, why="item4:panel", since=base)
        p.pump(2.0)
        p.mark("item4.panel", seen=got)
        p.send(b"1")  # "Yes, run it"
        p.pump(3.0)
        p.mark("item4.granted")
        p.wait_state("idle", 240.0, why="item4:settle", hold=0.4)
        p.mark("item4.end")
    finally:
        p.pump(2.0)
        p.close()
        shutil.rmtree(ws, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cli", default="kiso")
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--leg", choices=["main", "approval"], default="main")
    ap.add_argument("--force", action="store_true", help="overwrite an existing capture")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    # Killing the wrapper shell does NOT kill this process, and an orphan
    # writes its capture at the END — long after you think it is gone. One
    # did exactly that here and silently replaced a good run's bytes with
    # its own, under the same filename. A capture that can be overwritten
    # is a capture you cannot cite.
    existing = os.path.join(a.out, "ui1.raw")
    if os.path.exists(existing) and not a.force:
        print(f"refusing to overwrite {existing} (pass --force)", file=sys.stderr)
        return 2
    if a.leg == "approval":
        p = run_approval(a.out, a.cli, a.cols, a.rows)
    else:
        p = run(a.out, a.cli, a.cols, a.rows)
    raw = os.path.join(a.out, "ui1.raw")
    with open(raw, "wb") as f:
        f.write(bytes(p.buf))
    with open(os.path.join(a.out, "ui1.marks.json"), "w") as f:
        json.dump({"cols": a.cols, "rows": a.rows, "marks": p.marks}, f, indent=2)
    timeouts = [m for m in p.marks if m["name"] == "TIMEOUT"]
    print(f"captured {len(p.buf)} bytes -> {raw}")
    print(f"marks: {len(p.marks)}  timeouts: {len(timeouts)}")
    for m in timeouts:
        print(f"  TIMEOUT {m.get('why')} @{m['at']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
