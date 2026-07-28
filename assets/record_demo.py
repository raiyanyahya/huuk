#!/usr/bin/env python3
"""Record a real Claude Code session (with the huuk plugin) into an asciinema
.cast file, for conversion to assets/demo.gif with `agg`.

This is how the README GIF was made. It spawns `claude` on a pty inside a demo
repo whose test fails, types "push it", and captures the raw terminal stream
while huuk blocks the push, Claude fixes the bug, and the retried push lands.

Usage:
    python3 assets/record_demo.py <demo-project-dir> <out.cast> [plugin-dir]
    agg out.cast demo.gif --speed 2 --idle-time-limit 2 --font-size 14
"""
import codecs
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

COLS, ROWS = 100, 28

# (seconds-from-start, bytes-to-type)
SCHEDULE = [
    (8.0, b"\r"),           # accept the folder-trust prompt if shown
    (11.0, b"\r"),          # safety second Enter (harmless when idle)
    (15.0, b"TYPE:push it"),  # typed with per-key delay
    (16.5, b"\r"),
    (185.0, b"\x1b"),       # ESC — harmless if idle, interrupts if still running
    (186.5, b"/exit"),
    (187.5, b"\r"),
]
HARD_STOP = 200.0
KEY_DELAY = 0.08


def main() -> None:
    demo_dir, out_cast = sys.argv[1], sys.argv[2]
    plugin_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)   # let the claude.ai login win
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    # shed nested-session markers so the recording looks like a fresh top-level session
    for k in list(env):
        if k.startswith("CLAUDE_CODE") or k == "CLAUDECODE":
            env.pop(k)
    env["TERM"] = "xterm-256color"

    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    proc = subprocess.Popen(
        [
            "claude",
            "--plugin-dir", plugin_dir,
            "--allowedTools", "Bash,Edit,Write,Read,MultiEdit",
        ],
        stdin=slave, stdout=slave, stderr=slave,
        cwd=demo_dir, env=env, start_new_session=True,
    )
    os.close(slave)

    start = time.monotonic()
    events = []          # (t, bytes)
    schedule = list(SCHEDULE)
    typing = None        # (deadline, remaining-bytes)

    while True:
        now = time.monotonic() - start
        if now > HARD_STOP or proc.poll() is not None:
            break

        # feed scheduled input
        if typing:
            nxt, rest = typing
            if now >= nxt and rest:
                os.write(master, rest[:1])
                typing = (now + KEY_DELAY, rest[1:]) if rest[1:] else None
        elif schedule and now >= schedule[0][0]:
            _, data = schedule.pop(0)
            if data.startswith(b"TYPE:"):
                typing = (now, data[len(b"TYPE:"):])
            else:
                os.write(master, data)

        r, _, _ = select.select([master], [], [], 0.05)
        if master in r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            events.append((time.monotonic() - start, chunk))

    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        time.sleep(1)
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
    os.close(master)

    dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
    with open(out_cast, "w") as f:
        f.write(json.dumps({
            "version": 2, "width": COLS, "height": ROWS,
            "timestamp": int(time.time()), "env": {"TERM": env["TERM"]},
        }) + "\n")
        for t, chunk in events:
            text = dec.decode(chunk)
            if text:
                f.write(json.dumps([round(t, 4), "o", text]) + "\n")

    print(f"wrote {out_cast}: {len(events)} chunks, {events[-1][0]:.1f}s" if events else "no output captured")


if __name__ == "__main__":
    main()
