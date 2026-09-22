# presolv360-video

Approved script in, finished narrated 9:16 video out. One command.

```bash
./make-video.sh script.txt "Five Mistakes"
```

Both browser steps are driven by
[agent-browser](https://github.com/vercel-labs/agent-browser). Nothing is
clicked by pixel and no screenshots are taken.

```
1  Narakeet narration                 agent-browser
2  measure cue times                  ffmpeg silence detection
3  map scenes, build the Design prompt
4  Claude Design animation            agent-browser
5  merge narration into the video
6  sync check
```

`script.txt` is plain text, **one paragraph per scene**. Output lands in
`~/Desktop/Video Automation/<project>/`.

---

## Setup, once

Paste these one at a time. Do not add trailing comments — zsh does not treat
`#` as a comment on the interactive command line, so it becomes an argument.

```bash
chmod +x *.sh
brew install agent-browser
./doctor.sh
```

Homebrew is the reliable install for `agent-browser`. `npm install -g` writes to
`/usr/local/lib/node_modules`, which usually needs sudo and fails with `EACCES`.

`doctor.sh` checks node, python3, ffmpeg, agent-browser and Chrome, and names
what's missing. `make-video.sh` runs it first and prints the report, so a
missing dependency stops you in two seconds rather than four minutes in.

## Setup, each session

```bash
./launch-chrome.sh
```

This starts a **separate** Chrome with its own profile directory
(`~/.presolv360-chrome`) and a DevTools port on 9222. Your normal Chrome stays
open and untouched.

It has to be a separate profile, not yours. **Chrome 136 and later refuse
`--remote-debugging-port` when the browser is on its default profile** — the
port simply never opens, with no error. Pointing it at your real profile cannot
be made to work.

**First run only:** sign in to claude.ai in the window that opens. That profile
persists, so every run after that needs nothing from you. Narakeet's free tier
works signed out, so it only needs a login if you want your paid account used.

Leave that window open while `make-video.sh` runs.

## Why this runs on your Mac

`narakeet.com` and `claude.ai` are both blocked from Anthropic's cloud sandbox,
and a headless browser there has no Claude session. The only fix would be moving
a session cookie across, which isn't happening. So the browser steps run where a
logged-in browser already exists.

## The one manual moment

**Keep the Chrome window in the foreground during step 4's export.** Claude
Design pauses the render on a backgrounded tab. Nothing in code fixes that.

---

## Options

All environment variables, all optional:

| Var | Default | |
|---|---|---|
| `OUT_DIR` | `~/Desktop/Video Automation/<project>` | where everything lands |
| `WATCH_DIR` | `~/Downloads` | your browser's download folder |
| `CONNECT` | `cdp:9222` | the port `launch-chrome.sh` opens; or `profile:~/path` |
| `VOICE` | `victor/en-in` | Victor (Male), Indian accent |
| `LANG_CODE` | `en-IN` | |
| `SPEED` | `1.2` | `(voice-speed:)` multiplier — 126 wpm measured at this setting |
| `SCENE_PAUSE` | `0.8` | `(pause:)` between scenes — see below |
| `LABELS` | — | `labels.json`, one entry per paragraph |
| `TEMPLATE` | `tools/prompt-template.txt` | edit this to change the look |
| `SKIP_AUDIO` | — | path to an existing mp3, to skip step 1 |
| `PORT` | `9222` | DevTools port for the automation Chrome |

`design-video.mjs` also takes `--assets a.png,b.png` and `--no-assets`. By
default it attaches the mascot pose sheet and the stacked logo from
`presolv animated vids/` to the composer before the prompt — prose alone made
Design redraw the mascot as the flat logo mark.

`labels.json` gives each scene its on-screen wording, in order:

```json
[{"headline": "..."},
 {"label": "MISTAKE 01", "headline": "Ignoring communications",
  "support": "Silence rarely helps. It narrows your options."}]
```

Without it, the narration text is used as the headline.

---

## Two things that are load-bearing

**`SCENE_PAUSE` is why the cue times are exact.** It inserts a
`(pause: 0.8)` stage direction between paragraphs. Without it the silence
between scenes is the same ~0.4s as the silence between clauses, and nothing
downstream can tell a scene change from a comma — the mapping then falls back to
a proportional estimate that can land a clause out, which is visible. With it,
every gap over 0.6s is unambiguously a scene boundary. `map_scenes.py` says
which method it used and warns loudly when it falls back.

**The duration is baked into the prompt, not fixed afterwards.** Retiming a
built composition has never worked in Claude Design, so
`tools/prompt-template.txt` states the exact total and every cue time up front,
and tells the Design agent in as many words that the scene list is fixed — it
will otherwise rewrite your narrative and hand back a video the narration no
longer fits.

---

## What was learned the hard way

Encoded in the scripts, not guessed.

**Narakeet**

- The editor is `#unparsedScriptEditor`, a DIV with `contenteditable=""` —
  empty string, not `"true"`, so generic selectors miss it.
- DOM writes never reach `textarea[name="content"]`. Real input is mandatory.
- Pressing Return in the editor is swallowed; newlines must arrive as part of
  the inserted text.
- Three `button[role="create-audio"]` exist; only one has a non-zero rect. Same
  for Download. Both are found by rect, tagged, and clicked by id.
- Speed is unreachable in the UI — `div.control-block.hidden`, no toggle. The
  supported route is the `(voice-speed: N)` stage direction.
- The free tier works signed out.

**Claude Design**

- **The design system resets to the org default (Litelo) on every page load.**
  It is not a setting that sticks — this is why an earlier run came out in the
  wrong brand. `design-video.mjs` re-sets it every time and verifies it took.
- Composer is `[data-testid="home-composer-input"]` (ProseMirror), Create is
  `[data-testid="home-composer-send"]`. Those are the only stable test ids.
- ProseMirror ignores programmatic writes, so the prompt goes in via CDP
  `Input.insertText`.
- The export rows and size dialog live in a portal with no test ids and no
  accessible names, so they're matched by text. First place to look if a UI
  change breaks something.
- The composer has a bare `input[type=file]` (multiple, no accept filter) —
  no attach button, no test id. `agent-browser upload` drives it directly and
  each file then renders as `<img alt="<filename>">`, which is how the attach
  is verified. **Upload before inserting the prompt** — the upload steals focus
  from the composer, so a prompt inserted first lands nowhere.

**agent-browser**

- `agent-browser click <selector>` reported success while silently failing to
  dispatch the event. Every click here goes through `eval` and a synthetic
  `element.click()` instead, which is verified to work on both sites' React
  handlers and fails loudly when the element isn't there.
- `agent-browser install` can't fetch its Chrome behind a restricted egress —
  hence `launch-chrome.sh` and `--connect`.

Selectors verified 2026-09-02. Everything fragile is in the `SEL` block at the
top of each CLI.

---

## Testing without spending anything

`cli/mock/` reproduces the parts of both sites the CLIs touch — the
`contenteditable=""` editor, the hidden backing textarea that DOM writes never
reach, the triplicated buttons, the design-system reset, the export dialog, and
a fake build that settles.

```bash
cd cli/mock && python3 -m http.server 8801 &
# any Chromium with a debug port on 9444

SKIP_DOCTOR=1 OUT_DIR=/tmp/proj WATCH_DIR=/tmp/dl CONNECT=cdp:9444 \
NARAKEET_HOME=http://127.0.0.1:8801/narakeet-mock.html \
DESIGN_HOME=http://127.0.0.1:8801/claude-design-mock.html \
./make-video.sh script.txt "Test"
```

The full six-step chain has been run this way, including correctly ignoring
stale MP3s and MP4s already sitting in the watch folder.

**Not yet tested against the live sites.** Every selector came from reading the
real DOM, but no CLI run has touched Narakeet or Claude Design for real. Expect
a round or two of fixes on the first real run — the output is verbose enough to
say exactly which step failed.

---

## Failure modes

| Message | Cause | Fix |
|---|---|---|
| `could not attach to a browser` | Chrome has no debug port | `./launch-chrome.sh` |
| `not signed in to claude.ai` | that browser has no session | sign in once, or use `--connect profile:` |
| `design system "…" is not in the list` | renamed or not shared with the account | check the composer selector |
| `script did not land intact` | Narakeet changed the editor | check `SEL.editor` |
| `audio not ready within …s` | free-tier assets exhausted, or build failed | check the Narakeet page |
| `build did not settle` | long build, or a stuck verifier loop | raise `--timeout`, or finish by hand and re-run with `--project <url>` |
| `no MP4 appeared` | window was backgrounded, export stalled | bring it to the front, re-run with `--project <url>` |
| sync report says drift is not constant | animation genuinely doesn't match the cues | re-render; an offset can't fix it |

## Files

```
make-video.sh              the one command
doctor.sh                  dependency check
launch-chrome.sh           Chrome with a debug port
cli/narakeet-audio.mjs     script -> MP3
cli/design-video.mjs       prompt -> silent MP4
cli/lib/agent.mjs          shared agent-browser glue
cli/mock/                  offline stand-ins for both sites
tools/measure_narration.py duration + cue times
tools/map_scenes.py        paragraphs -> cue times
tools/build_prompt.py      scenes + template -> Design prompt
tools/prompt-template.txt  edit this to change the look
tools/merge_audio_video.py mux
tools/diagnose_sync.py     sync report
tools/apply_sync_offset.py constant-drift correction
tools/youtube_meta.py      scenes.json -> title/description/hashtags
```
