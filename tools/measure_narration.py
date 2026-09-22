#!/usr/bin/env python3
"""Measure a narration MP3: exact duration + every sentence boundary via silence detection.

These boundaries are the authoritative scene cue times. Nothing here estimates.

Usage:
    measure_narration.py NARRATION.mp3 [--out cues.json]
                         [--noise -34dB] [--min-silence 0.22]

Output JSON:
    {
      "file", "duration",
      "speech":  [{"start","end","dur"}, ...]   # detected speech spans
      "silences":[{"start","end","dur"}, ...]
      "cues":    [t0, t1, ...]                  # scene-change times = speech-span starts
      "leading_silence", "trailing_silence"
    }
"""
import argparse
import json
import re
import subprocess
import sys


def ffprobe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def detect_silences(path: str, noise: str, min_silence: float):
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-af", f"silencedetect=noise={noise}:d={min_silence}",
         "-f", "null", "-"],
        capture_output=True, text=True)
    log = proc.stderr
    starts = [float(m) for m in re.findall(r"silence_start:\s*(-?[\d.]+)", log)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", log)]
    silences = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else None
        silences.append({"start": max(0.0, s), "end": e})
    return silences


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    ap.add_argument("--noise", default="-34dB",
                    help="silencedetect noise floor (default -34dB)")
    ap.add_argument("--min-silence", type=float, default=0.22,
                    help="minimum silence length in seconds (default 0.22)")
    a = ap.parse_args()

    duration = ffprobe_duration(a.audio)
    sil = detect_silences(a.audio, a.noise, a.min_silence)
    for s in sil:
        if s["end"] is None:
            s["end"] = duration
        s["dur"] = round(s["end"] - s["start"], 3)
        s["start"] = round(s["start"], 3)
        s["end"] = round(s["end"], 3)

    # Invert silences -> speech spans.
    speech = []
    cursor = 0.0
    for s in sil:
        if s["start"] - cursor > 0.05:
            speech.append({"start": round(cursor, 3), "end": s["start"]})
        cursor = max(cursor, s["end"])
    if duration - cursor > 0.05:
        speech.append({"start": round(cursor, 3), "end": round(duration, 3)})
    for sp in speech:
        sp["dur"] = round(sp["end"] - sp["start"], 3)

    leading = speech[0]["start"] if speech else 0.0
    trailing = round(duration - speech[-1]["end"], 3) if speech else 0.0

    result = {
        "file": a.audio,
        "duration": round(duration, 3),
        "leading_silence": round(leading, 3),
        "trailing_silence": trailing,
        "speech": speech,
        "silences": sil,
        # A scene changes when a new sentence starts. First cue is pinned to 0
        # so the opening frame is never blank while the leading silence plays.
        "cues": [0.0] + [sp["start"] for sp in speech[1:]],
    }

    text = json.dumps(result, indent=2)
    if a.out:
        with open(a.out, "w") as f:
            f.write(text + "\n")
        print(f"duration={result['duration']}s  "
              f"speech_spans={len(speech)}  cues={len(result['cues'])}  -> {a.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
