#!/usr/bin/env python3
"""Apply a measured audio offset and re-mux.

Usage:
    apply_sync_offset.py VIDEO.mp4 NARRATION.mp3 OUT.mp4 --offset-ms N [--pad]

    +N  narration starts N ms later (video was running ahead)
    -N  narration starts N ms earlier (video was running behind)

Take N from diagnose_sync.py's suggested offset. This only ever shifts audio;
it never touches the video stream, so it cannot fix non-constant drift. If
diagnose_sync says the drift is not constant, re-render instead.
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--offset-ms", type=int, required=True)
    ap.add_argument("--pad", action="store_true")
    a = ap.parse_args()

    cmd = [sys.executable, os.path.join(HERE, "merge_audio_video.py"),
           a.video, a.audio, a.out, "--offset-ms", str(a.offset_ms)]
    if a.pad:
        cmd.append("--pad")
    return subprocess.run(cmd).returncode


if __name__ == "__main__":
    sys.exit(main())
