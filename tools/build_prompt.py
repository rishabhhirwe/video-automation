#!/usr/bin/env python3
"""Fill the Claude Design prompt template with the measured scene times.

Retiming a built composition has never worked in Claude Design, so the duration
and every cue time go into the prompt from the start rather than being fixed
afterwards. The template also states plainly that the scene list is fixed,
because the Design agent will otherwise rewrite the narrative and hand back a
different video from the one the narration was written for.

Edit tools/prompt-template.txt to change the look, brand rules or tone. The
placeholders it must keep are {{DURATION}}, {{SCENE_COUNT}} and {{SCENES}}.

Usage:
    build_prompt.py scenes.json [--out design-prompt.txt] [--template FILE]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def scene_block(s):
    lines = [f"SCENE {s['scene']} - {s['start']:.2f}s to {s['end']:.2f}s "
             f"({s['dur']:.2f}s)"]
    if s.get("label"):
        lines.append(f"  Micro-label: {s['label']}")
    lines.append(f"  Headline: \"{s.get('headline') or s['narration']}\"")
    if s.get("support"):
        lines.append(f"  Support: \"{s['support']}\"")
    lines.append(f"  Narration at this moment: \"{s['narration']}\"")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenes")
    ap.add_argument("--out", default="design-prompt.txt")
    ap.add_argument("--template",
                    default=os.path.join(HERE, "prompt-template.txt"))
    a = ap.parse_args()

    doc = json.load(open(a.scenes))
    scenes = doc["scenes"]

    try:
        tpl = open(a.template, encoding="utf-8").read()
    except FileNotFoundError:
        print(f"template not found: {a.template}", file=sys.stderr)
        return 1

    missing = [p for p in ("{{DURATION}}", "{{SCENES}}") if p not in tpl]
    if missing:
        print(f"template is missing {' and '.join(missing)}", file=sys.stderr)
        return 1

    text = (tpl
            .replace("{{DURATION}}", f"{doc['total_duration']:.2f}")
            .replace("{{SCENE_COUNT}}", str(len(scenes)))
            .replace("{{SCENES}}", "\n\n".join(scene_block(s) for s in scenes)))

    with open(a.out, "w") as f:
        f.write(text)
    print(f"  {len(scenes)} scenes, {doc['total_duration']:.2f}s, "
          f"{len(text)} chars -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
