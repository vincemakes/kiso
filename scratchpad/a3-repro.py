#!/usr/bin/env python3
"""A3 repro driver — run the pre-fix CLI in a real PTY, feed keys, and
report the terminal cursor's final position relative to the input row's
prompt. The PTY is a REAL terminal emulator cell model (TIOCSWINSZ 30x100),
so the wrap/CJK cell handling is the acceptance ground.

Usage: a3-repro.py <mode>  where mode is one of:
  cjk        — type a CJK char at the end of the input line
  longcjk    — type a long CJK line (forces the horizontal scroll)
  panel-rule — open the approval panel, jump to the rule input, type CJK
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "cli", "dist", "index.js")
CLI = os.path.abspath(CLI)

W, H = 100, 30
REAL_HOME = "/tmp/kiso-a3-repro-home"

SCRIPTS = {
    # a tool call → the default mode ASKS → the approval panel opens
    "panel": json.dumps([
        {"events": [
            {"type": "tool_call_end", "callId": "c1", "name": "shell", "input": {"command": "echo hi"}},
            {"type": "stop", "reason": "tool_use"},
        ]},
        {"events": [{"type": "stop", "reason": "end_turn"}]},
    ]),
}


def read_available(fd, timeout=0.4, hard=3.0, settles=2):
    """Read everything available on the pty master until it goes quiet
    (or the hard cap — a spinner can stream forever). An EIO (the slave
    closed) stops the drain — never loop forever. A mid-write capture
    (a partial master-side read + a quiet gap) can end the drain INSIDE
    a frame — the settles re-drain after the quiet deadline so the
    model's final cursor reflects the last COMPLETE frame."""
    chunks = []
    deadline = time.time() + timeout
    hard_deadline = time.time() + hard
    quiet_rounds = 0
    while time.time() < hard_deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break  # EIO — the slave is gone
            if not data:
                break
            chunks.append(data)
            deadline = time.time() + timeout  # keep draining while it produces
            quiet_rounds = 0
        elif time.time() >= deadline:
            if quiet_rounds >= settles:
                break  # quiet for long enough — the frame settled
            quiet_rounds += 1
            deadline = time.time() + timeout  # one more settle window
    return b"".join(chunks)


def feed(fd, s, settle=0.15):
    os.write(fd, s.encode() if isinstance(s, str) else s)
    time.sleep(settle)


def char_width(ch):
    cp = ord(ch)
    if (0x1100 <= cp <= 0x115f or 0x2e80 <= cp <= 0x303e or 0x3041 <= cp <= 0x33ff
            or 0x3400 <= cp <= 0x4dbf or 0x4e00 <= cp <= 0x9fff or 0xa000 <= cp <= 0xa4cf
            or 0xa960 <= cp <= 0xa97f or 0xac00 <= cp <= 0xd7a3 or 0xf900 <= cp <= 0xfaff
            or 0xfe10 <= cp <= 0xfe19 or 0xfe30 <= cp <= 0xfe6f or 0xff00 <= cp <= 0xff60
            or 0xffe0 <= cp <= 0xffe6 or 0x1f300 <= cp <= 0x1f64f or 0x1f900 <= cp <= 0x1f9ff
            or 0x20000 <= cp <= 0x3fffd):
        return 2
    return 1


def cursor_pos(out):
    """Replay the byte stream through a UTF-8 + charWidth-aware cell model
    (the last CUP/G position wins; real LF/CR/wrap applied) and return the
    final row,col. The text is decoded first — the terminal's own model."""
    text = out.decode("utf-8", errors="replace")
    rows = [[" "] * W for _ in range(H)]
    r, c = 0, 0
    pending = False  # the wrap-pending state: a full-width write parks at (r, W)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\x1b":
            if text[i + 1:i + 2] == "[":
                j = i + 2
                if j < n and text[j] == "?":  # private-parameter modes (?2004h etc.)
                    j += 1
                params = []
                cur = ""
                while j < n and text[j] not in "ABCDGHJKlmhfnr":
                    if text[j] == ";":
                        params.append(cur)
                        cur = ""
                    elif text[j].isdigit():
                        cur += text[j]
                    else:
                        break
                    j += 1
                if j < n:
                    final = text[j]
                    params.append(cur)
                    nums = [int(p) if p else 1 for p in params]
                    if final == "A":
                        pending = False
                        r = max(0, r - nums[0])
                    elif final == "B":
                        pending = False
                        r = min(H - 1, r + nums[0])
                    elif final == "C":
                        pending = False
                        c = min(W - 1, c + nums[0])
                    elif final == "D":
                        pending = False
                        c = max(0, c - nums[0])
                    elif final == "G":
                        pending = False
                        c = nums[0] - 1
                    elif final == "H":
                        pending = False
                        r = nums[0] - 1 if len(nums) > 0 else 0
                        c = nums[1] - 1 if len(nums) > 1 else 0
                    elif final == "K":
                        pending = False
                        for cc in range(c, W):
                            rows[r][cc] = " "
                    elif final == "J":
                        pending = False
                        for rr in range(r, H):
                            for cc in range(W):
                                rows[rr][cc] = " "
                    # m (SGR), l/h (modes), f (CUP), n/r — no cell effect here
                i = j + 1
                continue
            else:
                i += 2  # other escape
                continue
        elif ch == "\r":
            pending = False
            c = 0
        elif ch == "\n":
            if r == H - 1:
                # a real terminal scrolls the whole screen up
                rows.pop(0)
                rows.append([" "] * W)
                r = H - 1
            else:
                r += 1
            pending = False
        else:
            if pending:  # the wrap fires on the next printable char
                c = 0
                r = H - 1 if r == H - 1 else r + 1
                pending = False
            cw = char_width(ch)
            if c + cw > W:  # a wide char would straddle the right margin
                c = 0
                r = H - 1 if r == H - 1 else r + 1
            if cw == 2 and c + 1 < W:
                rows[r][c] = ch
                rows[r][c + 1] = ""  # the wide char's second cell
            else:
                rows[r][c] = ch
            c += cw
            if c >= W:
                c = W  # the wrap-pending position — the cursor at the margin
                pending = True
        i += 1
    return r, c, rows, pending


def render_screen(rows, r, c):
    lines = []
    for i, row in enumerate(rows):
        cells = list("".join(row))
        if i == r:
            pos = min(c, W - 1)
            if pos >= len(cells):
                cells.extend(" " * (pos + 1 - len(cells)))
            cells[pos] = "◄"
        lines.append(f"{i + 1:2d}|{''.join(cells)}")
    return "\n".join(lines)


def run(mode):
    # fresh isolated home
    import shutil
    shutil.rmtree(REAL_HOME, ignore_errors=True)
    os.makedirs(REAL_HOME, exist_ok=True)

    env = {
        **os.environ,
        "KISO_HOME": REAL_HOME,
        "KISO_EXTENSIONS_DIR": os.path.join(REAL_HOME, "extensions"),
        "KISO_MCP_CONFIG": os.path.join(REAL_HOME, "mcp.json"),
        "KISO_SKILLS_DIR": os.path.join(REAL_HOME, "skills"),
        "KISO_FAUX_SCRIPT": "/tmp/kiso-a3-script.json",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
    }
    with open("/tmp/kiso-a3-script.json", "w") as f:
        f.write(SCRIPTS["panel"])

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir("/tmp")
        os.execve("/usr/bin/env", ["env", "node", CLI, "chat"], env)
    # parent
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", H, W, 0, 0))
    time.sleep(1.2)  # boot + the first frame

    out = bytearray()
    def drain():
        """Read until the final cursor stops moving. The paused tool's
        spinner streams continuous frames, defeating the quiet deadline
        (the hard cap ends the drain mid-frame — a partial row becomes
        the model's last position); the agree-check waits for a COMPLETE
        steady frame's cursor move instead."""
        nonlocal out
        prev = None
        for _ in range(4):
            out.extend(read_available(fd))
            r, c, _, _ = cursor_pos(bytes(out))
            cur = (r, c)
            if prev is not None and cur == prev:
                return
            prev = cur
            time.sleep(0.25)
    drain()
    # is the child still alive?
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid != 0:
        print(f"!! child exited early: status={status}")
        print(bytes(out).decode(errors="replace")[:2000])
        sys.exit(1)

    if mode == "panel-rule":
        # submit a first line → the turn starts → the scripted tool call
        # arrives → the approval panel opens → press 2 (the rule input)
        time.sleep(0.8)
        drain()
        feed(fd, "go")
        feed(fd, "\r")
        time.sleep(1.2)
        drain()
        feed(fd, "2")
        time.sleep(0.4)
        drain()
        feed(fd, "\u4e2d")
        time.sleep(0.4)
        drain()
    elif mode == "cjk":
        feed(fd, "\u4e2d")
        time.sleep(0.4)
        drain()
    elif mode == "longcjk":
        feed(fd, "\u4e2d" * 40)
        time.sleep(0.6)
        drain()

    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    data = bytes(out)
    r, c, rows, pending = cursor_pos(data)
    print(f"== mode: {mode} — final cursor row={r + 1} col={c + 1} (W={W}, H={H})" + (" — wrap-pending" if pending else ""))
    print(render_screen(rows, r, c))
    # the input row is H-2 (row 28 in 1-based) — the LAST row containing
    # the prompt glyph (the panel BLOCK's rows also carry "Yes" — the
    # input row always follows them); the brick is "›" or "▌"
    found = None
    for i, row in enumerate(rows):
        line = "".join(row)
        if "›" in line or "▌" in line or "1-3>" in line or "Yes" in line:
            idx = line.find("›") if "›" in line else (line.find("▌") if "▌" in line else (line.find("1-3>") if "1-3>" in line else line.find("Yes")))
            found = (i, idx)
    if found is not None:
        i, idx = found
        print(f"input-row candidate row {i + 1}: prompt glyph at col {idx + 1}, cursor at col {c + 1} → cursor-is-{ 'LEFT of' if c + 1 < idx + 1 else 'RIGHT of' if c + 1 > idx + 1 else 'ON' }-the-prompt")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "cjk")
