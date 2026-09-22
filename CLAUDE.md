# Presolv360 video pipeline — operating instructions

You are running in the **Code tab** with shell access to this Mac. Your job is
to turn a topic and hook into a finished narrated 9:16 video.

Set the project folder to `~/Desktop/Video Automation`.

## The one command

```bash
cd ~/Desktop/Video\ Automation/presolv360-video
LABELS=labels.json ./make-video.sh script.txt "Project Name"
```

Six steps, about 10 minutes: Narakeet narration → measure cue times → build the
Design prompt → Claude Design animation → merge → sync check. Output lands in
`~/Desktop/Video Automation/<Project Name>/`.

## Before the first run of a session

```bash
./doctor.sh
```

If it reports the Chrome debug port closed:

```bash
./launch-chrome.sh
```

That starts a **separate** Chrome on its own profile (`~/.presolv360-chrome`)
with a DevTools port. The user's normal Chrome stays open and untouched — do
not quit it. Chrome 136+ refuses `--remote-debugging-port` on a default
profile, so a separate profile is the only thing that works.

That profile must be signed in to claude.ai. If `design-video.mjs` reports it
isn't, tell the user to sign in **in that window** — never handle credentials.

## Your part of the work

1. **Ask for topic + hook** if not given.
2. **Write `script.txt`** — plain text, ONE PARAGRAPH PER SCENE, 8 scenes is
   typical. At ~1.35x speed each paragraph runs 4–8s, so 8 paragraphs ≈ 45s.
3. **Write `labels.json`** — one entry per paragraph, in order:
   ```json
   [{"headline": "..."},
    {"label": "MISTAKE 01", "headline": "Ignoring communications",
     "support": "Silence rarely helps. It narrows your options."}]
   ```
4. **Get the user's approval on the script before running anything.** Narakeet
   is a metered free tier — each run spends an asset.
5. Run the command. Report progress as it goes.
6. **Verify the output before calling it done**: `ffprobe` the MP4 for
   dimensions and A/V duration match, and extract a frame from the middle of
   each scene in `scenes.json` to check the right words are on screen. Do not
   report success from an exit code alone.

## Legal safety — non-negotiable

This is a regulated legal brand. In every script:

- No absolute guarantees. Never "guarantees settlement", "ensures resolution",
  "saves millions". Use "can help protect", "can reduce uncertainty",
  "creates a structured path", "can lower legal spend".
- Hedge every claim: "can", "may", "rarely". Never strengthen them.
- Never present anything as legal advice.
- Closing scene carries "Informational only. Subject to legal review."

## Things that will bite you

- **The Claude Design system resets to the org default (Litelo) on every page
  load.** `design-video.mjs` re-sets it to Presolv360 each run and verifies it.
  If a video comes out in the wrong brand, that check failed.
- **Keep the automation Chrome window in the foreground during the export.**
  Claude Design pauses rendering on a backgrounded tab. This is the one thing
  no code fixes.
- **Retiming a built composition has never worked in Claude Design.** The
  duration is baked into the prompt up front. If the length is wrong, re-render
  — do not try to fix it after.
- **`SCENE_PAUSE` is load-bearing.** It puts `(pause: 0.8)` between paragraphs
  so scene boundaries are recoverable from the audio. Without it the mapping
  falls back to an estimate that lands a clause out. `map_scenes.py` says which
  method it used — if it says "proportional snap", the cue times are soft.
- **A failed run is resumable.** Reuse existing audio with
  `SKIP_AUDIO=".../narration.mp3"`. Export an already-built Design project with
  `node cli/design-video.mjs --project <url> --out-dir <dir>`.

## Tuning the look

`tools/prompt-template.txt` is plain text — brand tokens, type scale, mascot
description, motion rules. Edit it to change the visual result; no code change
needed. Known gap: the mascot currently renders as the speech-bubble logo mark
rather than the full robot with legs and antenna.

## Testing without spending anything

`cli/mock/` stands in for both sites offline:

```bash
cd cli/mock && python3 -m http.server 8801 &
SKIP_DOCTOR=1 OUT_DIR=/tmp/proj WATCH_DIR=/tmp/dl CONNECT=cdp:9444 \
NARAKEET_HOME=http://127.0.0.1:8801/narakeet-mock.html \
DESIGN_HOME=http://127.0.0.1:8801/claude-design-mock.html \
./make-video.sh script.txt "Test"
```

Use this for any change to the CLIs before spending a real Narakeet asset or a
Design build.

## Not needed here

`watcher/` exists so Cowork chat can drive this remotely when nobody is at the
Mac. In the Code tab you have the shell directly — run `make-video.sh` yourself
and ignore the watcher.
