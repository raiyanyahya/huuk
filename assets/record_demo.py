#!/usr/bin/env python3
"""Record a real Claude Code session (with the huuk plugin) into an asciinema
.cast file, for conversion to assets/demo.gif with `agg`.

This is how the README GIF was made. It spawns `claude` on a pty inside a demo
repo whose test fails and drives a three-act story:

  1. "set debug to true in config.json" -> huuk steers Claude away (protect rule)
  2. "push it"                          -> gate blocks on the failing test,
                                           Claude fixes, retries, push lands
  3. "/huuk:check"                      -> dry-run report, all green

Input is EVENT-DRIVEN: each next prompt is typed only after the previous act's
completion marker appears in the (ANSI-stripped) output stream, so variable
model thinking time can't desync the script.

Usage:
    python3 assets/record_demo.py <demo-project-dir> <out.cast> [plugin-dir]
    agg out.cast demo.gif --speed 2.5 --idle-time-limit 2 --font-size 14
"""
import codecs
import fcntl
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

COLS, ROWS = 110, 32
KEY_DELAY = 0.08
HARD_STOP = 580.0

# wait: unconditional pause · send: raw bytes · type: per-key typing ·
# await: block until marker text appears in output (or timeout, then proceed) ·
# await_idle: block until the status bar shows the idle prompt again ·
# submit: type + Enter, re-pressing Enter if the TUI didn't start a turn
STEPS = [
    {"wait": 8.0}, {"send": b"\r"},          # accept folder-trust prompt if shown
    {"wait": 3.0}, {"send": b"\r"},          # harmless safety Enter
    {"wait": 4.0},
    {"submit": "set debug to true in config.json"},
    {"await": "huuk blocked", "timeout": 60.0},
    {"await_idle": 60.0},                     # let the turn finish rendering
    {"wait": 3.0},
    {"submit": "push it"},
    {"await": "main -> main", "timeout": 200.0},
    {"await_idle": 90.0},
    {"wait": 3.0},
    {"submit": "/huuk:check"},
    {"await": "would be allowed", "timeout": 90.0},
    {"await_idle": 60.0},
    {"wait": 6.0},
    {"send": b"\x1b"}, {"wait": 1.5},
    {"type": "/exit"}, {"wait": 1.0}, {"send": b"\r"},
    {"wait": 5.0},
]

RUNNING_MARK = "esc to interrupt"   # status bar while a turn is running
IDLE_MARK = "? for shortcuts"       # status bar when awaiting input

ANSI = re.compile(
    r"\x1b\[[0-9;:?]*[ -/]*[@-~]"      # CSI sequences
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC sequences
    r"|\x1b[@-_]"                       # other ESC codes
)


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
            "--effort", "low",           # snappy turns for a watchable demo
        ],
        stdin=slave, stdout=slave, stderr=slave,
        cwd=demo_dir, env=env, start_new_session=True,
    )
    os.close(slave)

    start = time.monotonic()
    events = []
    clean = ""            # ANSI-stripped cumulative output for marker matching
    step_i = 0
    step_started = time.monotonic()
    await_mark = 0        # only match output that arrived after the await began
    typing = b""
    next_key_at = 0.0
    submit_state = None

    def elapsed() -> float:
        return time.monotonic() - start

    while True:
        if elapsed() > HARD_STOP or proc.poll() is not None:
            break

        now = time.monotonic()

        def is_running() -> bool:
            tail = clean[-1500:]
            return tail.rfind(RUNNING_MARK) > tail.rfind(IDLE_MARK)

        if typing:
            if now >= next_key_at:
                os.write(master, typing[:1])
                typing = typing[1:]
                next_key_at = now + KEY_DELAY
                if not typing and submit_state == "typing":
                    submit_state = "entering"
                    step_started = now
        elif step_i < len(STEPS):
            step = STEPS[step_i]
            advance = False
            if "wait" in step:
                advance = now - step_started >= step["wait"]
            elif "send" in step:
                os.write(master, step["send"])
                advance = True
            elif "type" in step:
                typing = step["type"].encode()
                next_key_at = now
                advance = True
            elif "submit" in step:
                if submit_state is None:
                    typing = step["submit"].encode()
                    next_key_at = now
                    submit_state = "typing"
                elif submit_state == "entering":
                    if now - step_started >= 0.6:
                        os.write(master, b"\r")
                        submit_state = "verifying"
                        step_started = now
                elif submit_state == "verifying":
                    if is_running():
                        advance = True          # turn started — submitted for real
                    elif now - step_started >= 3.0:
                        submit_state = "entering"  # Enter didn't take; try again
                        step_started = now
            elif "await" in step:
                if step["await"] in clean[await_mark:]:
                    advance = True
                elif now - step_started >= step["timeout"]:
                    print(f"warn: marker {step['await']!r} timed out", file=sys.stderr)
                    advance = True
            elif "await_idle" in step:
                if not is_running():
                    advance = True
                elif now - step_started >= step["await_idle"]:
                    print("warn: idle wait timed out", file=sys.stderr)
                    advance = True
            if advance:
                step_i += 1
                step_started = now
                await_mark = len(clean)
                submit_state = None
        elif not typing:
            break  # script finished

        r, _, _ = select.select([master], [], [], 0.05)
        if master in r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            events.append((elapsed(), chunk))
            clean += ANSI.sub("", chunk.decode("utf-8", errors="replace"))
            if len(clean) > 500_000:
                cut = len(clean) - 400_000
                clean = clean[cut:]
                await_mark = max(0, await_mark - cut)

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
