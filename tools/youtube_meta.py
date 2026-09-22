#!/usr/bin/env python3
"""Derive a YouTube title, description and hashtags from a finished video's
own scenes.json - no separate input, so the metadata can never drift from
what the video actually says.

Only YouTube's three most basic fields are covered here: title, description,
hashtags. Thumbnail, tags, category, captions and everything else in the
upload flow are still manual - see CLAUDE.md.

Usage:
    youtube_meta.py scenes.json [--out youtube.json] [--brand-tags TAG,TAG,...]
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Always included, in this order, before anything derived from the script.
DEFAULT_BRAND_TAGS = ["Presolv360", "ODR", "LegalTech", "DisputeResolution"]

TITLE_MAX = 100          # YouTube's hard limit
DESCRIPTION_MAX = 5000   # YouTube's hard limit
HASHTAG_FEATURED = 3     # only the first 3 in the description render above
                          # the title on the watch page - the rest are still
                          # searchable but don't get that placement


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _hashtag(word: str) -> str:
    """CamelCase a phrase into a single hashtag token: no spaces or
    punctuation are allowed inside a hashtag, so multi-word labels have to be
    joined this way rather than dropped."""
    parts = re.split(r"[^A-Za-z0-9]+", word)
    parts = [p for p in parts if p]
    if not parts:
        return ""
    return "#" + "".join(p[:1].upper() + p[1:] for p in parts)


def build_title(scenes: list) -> str:
    """The opening scene's headline is already phrased as the video's hook -
    reuse it rather than re-deriving a title from scratch."""
    first = scenes[0]
    title = _clean(first.get("headline") or first.get("narration") or "")
    if not title:
        raise ValueError("scene 1 has no headline or narration to title from")
    if len(title) > TITLE_MAX:
        title = title[: TITLE_MAX - 1].rstrip() + "…"
    return title


def find_disclaimer(scenes: list) -> str:
    """The closing scene's support/narration carries the legal fine print
    verbatim (see CLAUDE.md's legal-safety rule) - pull it rather than
    hand-typing it a second time, so the two can never drift apart."""
    for s in reversed(scenes):
        # support commonly holds two lines ("Follow for..." + the
        # disclaimer) - split on the newline only, not on every sentence
        # period, or "Informational only. Not legal advice. Subject to
        # legal review." gets shredded into unrelated fragments.
        candidates = re.split(r"\n", s.get("support", "")) + \
            [s.get("narration", "")]
        for line in candidates:
            line = _clean(line)
            if re.search(r"not legal advice|informational only", line, re.I):
                return line
    return ""


def build_body_points(scenes: list) -> list:
    """One bullet per labelled scene (skips the title card and the closing
    scene, which aren't content points), in narration order."""
    points = []
    for s in scenes[1:-1]:
        headline = _clean(s.get("headline") or "")
        support = _clean(s.get("support") or "")
        if not headline:
            continue
        points.append(f"{headline} — {support}" if support else headline)
    return points


def build_description(scenes: list, title: str) -> str:
    hook = _clean(scenes[0].get("narration") or title)
    points = build_body_points(scenes)
    disclaimer = find_disclaimer(scenes)

    lines = [hook, ""]
    if points:
        lines += [f"• {p}" for p in points]
        lines.append("")
    lines.append("Presolv360 helps enterprises resolve disputes through a "
                  "structured, digital-first process.")
    lines.append("")
    lines.append("Follow for more corporate legal insights.")
    if disclaimer:
        lines.append("")
        lines.append(disclaimer)

    desc = "\n".join(lines).strip()
    if len(desc) > DESCRIPTION_MAX:
        desc = desc[: DESCRIPTION_MAX - 1].rstrip() + "…"
    return desc


def build_hashtags(scenes: list, brand_tags: list) -> list:
    """Brand tags first (fixed, always relevant), then one tag per distinct
    scene label/headline word that isn't already covered - keeps hashtags
    tied to what the video actually covers instead of being generic."""
    seen = set()
    tags = []

    def add(raw):
        tag = _hashtag(raw)
        key = tag.lower()
        if tag and key not in seen:
            seen.add(key)
            tags.append(tag)

    for t in brand_tags:
        add(t)

    # Scene labels ("STAGE 01", "MISTAKE 03") are structural, not topical -
    # skip the counter, keep the headline instead, which names the concept.
    for s in scenes[1:-1]:
        headline = _clean(s.get("headline") or "")
        if not headline:
            continue
        # A short headline (<=3 words) makes a clean single hashtag; a
        # longer one is a sentence fragment and would make an unreadable tag.
        if len(headline.split()) <= 3:
            add(headline)

    return tags


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenes")
    ap.add_argument("--out", default="youtube.json")
    ap.add_argument("--brand-tags", default=",".join(DEFAULT_BRAND_TAGS),
                     help="comma-separated, always included first")
    a = ap.parse_args()

    doc = json.load(open(a.scenes))
    scenes = doc["scenes"]
    if len(scenes) < 2:
        print("need at least 2 scenes (a title card and a closing scene)",
              file=sys.stderr)
        return 1

    brand_tags = [t.strip() for t in a.brand_tags.split(",") if t.strip()]

    title = build_title(scenes)
    description = build_description(scenes, title)
    hashtags = build_hashtags(scenes, brand_tags)

    out = {
        "title": title,
        "description": description,
        "hashtags": hashtags,
        "hashtags_featured": hashtags[:HASHTAG_FEATURED],
        "hashtag_line": " ".join(hashtags),
    }
    json.dump(out, open(a.out, "w"), indent=2)

    print(f"title        {title}  ({len(title)} chars)")
    print(f"description  {len(description)} chars, "
          f"{len(build_body_points(scenes))} points")
    print(f"hashtags     {len(hashtags)} total, "
          f"featured: {' '.join(out['hashtags_featured'])}")
    print(f"             -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
