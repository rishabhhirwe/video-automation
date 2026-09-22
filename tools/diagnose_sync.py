#!/usr/bin/env python3
"""Diagnose narration/animation sync by measuring both sides, never guessing.

Compares where the video actually cuts (ffmpeg scene detection) against where
the narration actually starts each sentence (cues.json from measure_narration.py)
and reports the per-cue drift plus a single suggested global offset.

Usage:
    diagnose_sync.py MERGED.mp4 --cues cues.json [--scene-threshold 0.12]
    diagnose_sync.py VIDEO.mp4 --audio NARRATION.mp3 [--cues cues.json]

Exit code 0 always; read the report. A suggested offset is in milliseconds and
is fed straight to apply_sync_offset.py / merge_audio_video.py --offset-ms.
"""
import argparse
import json
import re
import statistics
import subprocess
import sys


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,duration", "-show_entries", "format=duration",
         "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    fmt = float(d["format"]["duration"])
    streams = {}
    for s in d.get("streams", []):
        streams[s["codec_type"]] = float(s["duration"]) if s.get("duration") else fmt
    return fmt, streams


def scene_changes(path, threshold):
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-filter:v", f"select='gt(scene,{threshold})',showinfo",
         "-f", "null", "-"],
        capture_output=True, text=True)
    return [round(float(m), 3)
            for m in re.findall(r"pts_time:([\d.]+)", proc.stderr)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--audio", default=None)
    ap.add_argument("--cues", default=None)
    ap.add_argument("--scene-threshold", type=float, default=0.12)
    a = ap.parse_args()

    fmt, streams = probe(a.video)
    print(f"container      {fmt:.3f}s")
    for k, v in streams.items():
        print(f"  {k:<12} {v:.3f}s")
    if a.audio:
        afmt, _ = probe(a.audio)
        print(f"narration      {afmt:.3f}s")
        drift = streams.get("video", fmt) - afmt
        print(f"  length drift {drift:+.3f}s (video minus narration)")
    elif "audio" in streams and "video" in streams:
        drift = streams["video"] - streams["audio"]
        print(f"  length drift {drift:+.3f}s (video minus audio)")

    # Sweep down if the composition uses soft transitions rather than hard cuts.
    thresholds = [a.scene_threshold, 0.06, 0.03, 0.015]
    cuts, used = [], a.scene_threshold
    for th in thresholds:
        cuts = scene_changes(a.video, th)
        used = th
        if cuts:
            break
    print(f"\nvisual cuts detected (threshold {used}): {len(cuts)}")
    print("  " + (", ".join(f"{c:.2f}" for c in cuts) if cuts else "none"))
    if not cuts:
        print("  Note: no frame-to-frame jumps found. This composition cross-fades\n"
              "        rather than cutting, so per-cue drift cannot be measured from\n"
              "        the pixels. Trust the render (it was seeked to the cues) and\n"
              "        check only the length drift above.")

    if not a.cues:
        print("\nNo --cues supplied; per-scene drift not computed.")
        return 0

    with open(a.cues) as f:
        cues = json.load(f)["cues"]
    print(f"\nnarration cues: {len(cues)}")

    deltas = []
    print(f"\n  {'cue':>8} {'nearest cut':>12} {'delta':>9}")
    for c in cues:
        if not cuts:
            break
        nearest = min(cuts, key=lambda x: abs(x - c))
        d = nearest - c
        deltas.append(d)
        flag = "" if abs(d) <= 0.12 else ("  <-- late" if d > 0 else "  <-- early")
        print(f"  {c:8.3f} {nearest:12.3f} {d:+9.3f}{flag}")

    if deltas:
        med = statistics.median(deltas)
        spread = max(deltas) - min(deltas)
        print(f"\nmedian drift  {med:+.3f}s")
        print(f"spread        {spread:.3f}s")
        if spread > 0.30:
            print("\nVerdict: drift is NOT constant — a single offset will not fix this.\n"
                  "         Re-render the animation against the measured cues instead.")
        elif abs(med) <= 0.08:
            print("\nVerdict: in sync. No correction needed.")
        else:
            print(f"\nVerdict: constant drift. Correct with:\n"
                  f"         apply_sync_offset.py <video> <audio> <out> "
                  f"--offset-ms {int(round(med * 1000))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
