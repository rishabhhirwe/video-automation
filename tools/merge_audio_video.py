#!/usr/bin/env python3
"""Mux a silent video with a narration track.

Usage:
    merge_audio_video.py VIDEO.mp4 NARRATION.mp3 OUT.mp4
        [--offset-ms N]   # +N delays audio, -N trims audio head
        [--pad]           # hold the last video frame if audio is longer
        [--reencode]      # force video re-encode instead of stream copy

Default policy: keep the video stream untouched (-c:v copy), encode audio to
AAC 192k, and end the file at whichever stream is shorter unless --pad.
"""
import argparse
import subprocess
import sys


def dur(path, stream=None):
    cmd = ["ffprobe", "-v", "error"]
    if stream:
        cmd += ["-select_streams", stream]
    cmd += ["-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]
    return float(subprocess.run(cmd, capture_output=True, text=True,
                                check=True).stdout.strip())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--offset-ms", type=int, default=0)
    ap.add_argument("--pad", action="store_true")
    ap.add_argument("--reencode", action="store_true")
    a = ap.parse_args()

    v, au = dur(a.video), dur(a.audio)

    filters = []
    if a.offset_ms > 0:
        filters.append(f"adelay={a.offset_ms}|{a.offset_ms}")
    elif a.offset_ms < 0:
        filters.append(f"atrim=start={abs(a.offset_ms) / 1000.0},asetpts=PTS-STARTPTS")

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if a.pad:
        cmd += ["-i", a.video, "-i", a.audio]
        vmap = "[vpad]"
        # Pad by exactly what's missing, plus a little slack. A fixed pad
        # silently truncates the narration whenever the gap is larger than it.
        need = max(0.0, au - v + (a.offset_ms / 1000.0)) + 0.5
        vf = f"tpad=stop_mode=clone:stop_duration={need:.3f}"
        filters_complex = f"[0:v]{vf}[vpad]"
        if filters:
            filters_complex += f";[1:a]{','.join(filters)}[aout]"
            amap = "[aout]"
        else:
            amap = "1:a"
        cmd += ["-filter_complex", filters_complex,
                "-map", vmap, "-map", amap,
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-shortest"]
    else:
        cmd += ["-i", a.video, "-i", a.audio]
        if filters:
            cmd += ["-filter_complex", f"[1:a]{','.join(filters)}[aout]",
                    "-map", "0:v", "-map", "[aout]"]
        else:
            cmd += ["-map", "0:v", "-map", "1:a"]
        cmd += ["-c:v", "libx264" if a.reencode else "copy"]
        if a.reencode:
            cmd += ["-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
        cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]

    cmd += ["-movflags", "+faststart", a.out]
    subprocess.run(cmd, check=True)

    o = dur(a.out)
    print(f"video={v:.3f}s  audio={au:.3f}s  offset={a.offset_ms}ms  -> {a.out} ({o:.3f}s)")
    if abs(v - au) > 0.35 and not a.pad:
        print(f"  ! {abs(v - au):.3f}s length mismatch; consider --pad or re-timing "
              f"the animation to the measured narration duration.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
