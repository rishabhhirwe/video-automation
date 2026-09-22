#!/usr/bin/env python3
"""Map script paragraphs to measured narration cue times.

measure_narration.py finds every speech span, but a span is a clause, not a
scene — Narakeet pauses at commas as well as full stops. This assigns one
paragraph (= one scene) to each of the spans that actually starts it.

Method: estimate where each paragraph should begin from its share of the total
characters, then SNAP that estimate to the nearest real measured span start.
The output times are therefore always measured values, never estimates — the
estimate only decides which measured boundary to pick.

Usage:
    map_scenes.py SCRIPT.txt CUES.json [--out scenes.json] [--labels labels.json]

labels.json (optional): [{"label": "MISTAKE 01", "headline": "..."}, ...]
one entry per paragraph, in order.
"""
import argparse
import json
import re
import sys

STAGE_DIRECTION = re.compile(r"^\s*\([a-z-]+\s*:[^)]*\)\s*$", re.I)


def paragraphs(path):
    raw = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    out = []
    for block in re.split(r"\n\s*\n", raw):
        b = block.strip()
        if not b or STAGE_DIRECTION.match(b):
            continue          # directives are instructions, not narration
        out.append(" ".join(b.split()))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("script")
    ap.add_argument("cues")
    ap.add_argument("--out", default="scenes.json")
    ap.add_argument("--labels", default=None)
    ap.add_argument("--gap", type=float, default=0.6,
                    help="silence at or above this = scene boundary (default 0.6)")
    a = ap.parse_args()

    paras = paragraphs(a.script)
    cue = json.load(open(a.cues))
    spans = cue["speech"]
    total = cue["duration"]
    if not paras:
        print("no narration paragraphs found", file=sys.stderr)
        return 1
    if len(spans) < len(paras):
        print(f"warning: {len(spans)} speech spans for {len(paras)} paragraphs — "
              f"the silences between scenes may be too short to detect. "
              f"Try a smaller --min-silence when measuring.", file=sys.stderr)

    # --- primary: the (pause: N) markers the narration was generated with ------
    # narakeet-audio.mjs inserts an explicit pause between paragraphs precisely
    # so this step is deterministic. Any gap at or over --gap is a scene change;
    # the ~0.4s gaps between clauses fall below it.
    gaps = [(spans[j + 1]["start"] - spans[j]["end"], j + 1)
            for j in range(len(spans) - 1)]
    boundaries = [j for g, j in gaps if g >= a.gap]
    method = "pause markers"
    starts = [0.0] + [spans[j]["start"] for j in boundaries]

    if len(starts) != len(paras):
        # --- fallback: proportional estimate snapped to a measured boundary ---
        # Used when the narration was made without pause markers. Less exact:
        # it can land a clause early or late, so the drift is reported below.
        method = f"proportional snap ({len(starts)} pause gaps for {len(paras)} paragraphs)"
        print(f"  note: falling back to {method}", file=sys.stderr)
        chars = [len(p) for p in paras]
        cum, run = [], 0
        for c in chars:
            cum.append(run)
            run += c
        est = [total * c / run for c in cum]
        starts, used = [], set()
        for i, e in enumerate(est):
            if i == 0:
                starts.append(0.0)
                used.add(0)
                continue
            cands = [(abs(s["start"] - e), j, s["start"])
                     for j, s in enumerate(spans)
                     if j not in used and s["start"] > starts[-1] + 0.15]
            if not cands:
                starts.append(round(e, 3))
                continue
            _, j, t = min(cands)
            used.add(j)
            starts.append(round(t, 3))

    labels = []
    if a.labels:
        labels = json.load(open(a.labels))

    scenes = []
    for i, p in enumerate(paras):
        t0 = starts[i]
        t1 = total if i == len(paras) - 1 else starts[i + 1]
        meta = labels[i] if i < len(labels) else {}
        scenes.append({
            "scene": i + 1,
            "start": round(t0, 2),
            "end": round(t1, 2),
            "dur": round(t1 - t0, 2),
            "narration": p,
            "label": meta.get("label", ""),
            "headline": meta.get("headline", ""),
            "support": meta.get("support", ""),
        })

    doc = {"narration_file": cue["file"], "total_duration": total,
           "fps": 30, "size": [1080, 1920], "scenes": scenes}
    with open(a.out, "w") as f:
        json.dump(doc, f, indent=2)

    for s in scenes:
        print(f"  scene {s['scene']}  {s['start']:6.2f} -> {s['end']:6.2f} "
              f"({s['dur']:5.2f}s)  {s['narration'][:52]}")
    print(f"  total {total}s   method: {method}   -> {a.out}")
    if len(scenes) != len(paras):
        print("  ! scene count does not match the script — do not render yet.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
