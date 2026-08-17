
import pty, os, sys, time, select, signal, struct, fcntl, termios, json

def driver(cli, env, feeds, timeout, cols, post):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, cols, 0, 0))
    full = b""
    fed = set()
    end = time.time() + timeout
    fired = 0
    broke = False
    crashed = False
    exit_sent = False
    resizes = []
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                # EOF before the timeout = the child died on its own (the
                # invariant-① crash class — the ≤100 thinking at a narrow
                # winch; the ALIVE marker re-verifies the R2 fix at 60 cols)
                if not exit_sent:
                    crashed = True
                break
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
        if post and "2 tools".encode() in full and fired < len(post):
            rows, cols_n = post[fired]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols_n, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            resizes.append([len(full), rows, cols_n])
            fired += 1
        # the run is over when the recap ("2 tools" — the running status
        # never mentions tools) has rendered; the W9 resize (if any) has
        # fired by then — drain the buffered repaint so the transcript
        # captures it, then stop
        if "2 tools".encode() in full and fired >= len(post) and not broke:
            time.sleep(0.6)
            # drain until quiet — a wide terminal's settle frame is several
            # pipe-buffer chunks (the 120-col frame ≈ 2 KB); one read can
            # stop mid-frame and the transcript loses the frame's wrap-close
            while True:
                r, _, _ = select.select([fd], [], [], 0.5)
                if not r:
                    break
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                full += data
            broke = True
            break
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    print("CRASHED" if crashed else "ALIVE")
    print(json.dumps(resizes))
    sys.stdout.write(full.hex())
    sys.exit(0)
