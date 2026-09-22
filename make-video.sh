#!/usr/bin/env bash
#
# make-video.sh — approved script in, finished narrated video out.
#
# Builds BOTH 9:16 (1080x1920) and 16:9 (1920x1080) by default: one narration
# and one scene map feed two Design builds, so the second ratio costs a build
# but no Narakeet asset. RATIO=9x16 or RATIO=16x9 builds just one.
#
#   ./make-video.sh script.txt "Five Mistakes"
#
# Runs the whole chain:
#   1  Narakeet narration                  (agent-browser)
#   2  measure cue times from the audio    (ffmpeg silence detection)
#   3  map scenes + build the Design prompt
#   4  Claude Design animation             (agent-browser)   per ratio
#   5  merge narration into the video                      per ratio
#   6  sync check                                          per ratio
#
# script.txt is plain text, ONE PARAGRAPH PER SCENE.
#
# The one moment that needs you: keep the Chrome window in the FOREGROUND during
# step 4's export. Claude Design pauses the render on a backgrounded tab.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_FILE="${1:-}"
[[ -n "$SCRIPT_FILE" ]] || { echo "usage: ./make-video.sh SCRIPT.txt [PROJECT NAME]" >&2; exit 1; }
[[ -f "$SCRIPT_FILE" ]] || { echo "no such file: $SCRIPT_FILE" >&2; exit 1; }
PROJECT="${2:-$(basename "${SCRIPT_FILE%.*}")}"

OUT="${OUT_DIR:-$HOME/Desktop/Video Automation/$PROJECT}"
WATCH="${WATCH_DIR:-$HOME/Downloads}"
CONNECT="${CONNECT:-cdp:${PORT:-9222}}"   # the port launch-chrome.sh opens
SPEED="${SPEED:-1.2}"
VOICE="${VOICE:-victor/en-in}"
LANG_CODE="${LANG_CODE:-en-IN}"
SCENE_PAUSE="${SCENE_PAUSE:-0.8}"
LABELS="${LABELS:-}"
TEMPLATE="${TEMPLATE:-$HERE/tools/prompt-template.txt}"
TEMPLATE_16X9="${TEMPLATE_16X9:-$HERE/tools/prompt-template-16x9.txt}"
# Which aspect ratios to build. Both by default: one narration and one scene
# map feed two Design builds, so the second ratio costs a build but no
# Narakeet asset. RATIO=9x16 or RATIO=16x9 builds just that one.
RATIO="${RATIO:-9x16,16x9}"
PY="${PYTHON:-python3}"
SKIP_AUDIO="${SKIP_AUDIO:-}"          # set to an existing mp3 to reuse it
AB_BIN="${AB_BIN:-agent-browser}"
# Test hooks: point the two browser steps at cli/mock/*.html to exercise the
# whole chain without touching Narakeet credits or a Claude Design build.
NARAKEET_HOME="${NARAKEET_HOME:-}"
DESIGN_HOME="${DESIGN_HOME:-}"
EXTRA_AUDIO="${EXTRA_AUDIO:-}"
EXTRA_VIDEO="${EXTRA_VIDEO:-}"

step() { printf '\n\033[1m[%s/6] %s\033[0m\n' "$1" "$2"; }
# Steps 4-6 run once per ratio, so their headers carry the ratio rather than
# pretending to be a single pass.
stepr() { printf '\n\033[1m[%s/6 · %s] %s\033[0m\n' "$1" "$2" "$3"; }

# Bash does NOT forward a signal it receives to a foreground child process -
# if this script is killed (Ctrl-C, TaskStop, the terminal closing) while a
# `node` call is running, the node process is silently orphaned and keeps
# running, leaving its Chrome tab open indefinitely with nothing watching it.
# Every node call in this script goes through here instead of a bare `node`,
# so a kill signal reaches the child and its own cleanup (closing the tab)
# actually runs.
CHILD_PID=""
forward_and_die() {
  local sig="$1"
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "  $sig received — forwarding to the running step (pid $CHILD_PID)" >&2
    kill -"$sig" "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  exit 130
}
trap 'forward_and_die INT' INT
trap 'forward_and_die TERM' TERM

run_node() {
  node "$@" &
  CHILD_PID=$!
  wait "$CHILD_PID"
  local status=$?
  CHILD_PID=""
  return $status
}

if [[ -z "${SKIP_DOCTOR:-}" ]]; then
  # Show the report rather than hiding it — a silent "check failed" makes you
  # run doctor.sh again to find out the same thing.
  if ! "$HERE/doctor.sh"; then
    echo >&2
    echo "Fix the above, then re-run. Nothing has been started." >&2
    exit 1
  fi
  echo
fi

mkdir -p "$OUT"
echo "project   $PROJECT"
echo "script    $SCRIPT_FILE"
echo "output    $OUT"

# ------------------------------------------------------------ 1. narration --
step 1 "narration (Narakeet)"
if [[ -n "$SKIP_AUDIO" ]]; then
  cp "$SKIP_AUDIO" "$OUT/narration.mp3"
  echo "  reusing $SKIP_AUDIO"
else
  run_node "$HERE/cli/narakeet-audio.mjs" \
    --script-file "$SCRIPT_FILE" \
    --out-dir "$OUT" --watch-dir "$WATCH" --connect "$CONNECT" \
    --lang "$LANG_CODE" --voice "$VOICE" --speed "$SPEED" \
    --scene-pause "$SCENE_PAUSE" --name narration --bin "$AB_BIN" \
    ${NARAKEET_HOME:+--home "$NARAKEET_HOME"} $EXTRA_AUDIO
fi

# --------------------------------------------------------------- 2. measure --
step 2 "measuring cue times"
$PY "$HERE/tools/measure_narration.py" "$OUT/narration.mp3" --out "$OUT/cues.json"

# ------------------------------------------------------- 3. map + prompt -----
step 3 "mapping scenes and building the prompt"
$PY "$HERE/tools/map_scenes.py" "$SCRIPT_FILE" "$OUT/cues.json" \
  --out "$OUT/scenes.json" ${LABELS:+--labels "$LABELS"}
# One prompt per ratio, from the same scenes.json — identical copy, identical
# cue times, only the layout instructions differ.
for r in ${RATIO//,/ }; do
  case "$r" in
    9x16)  tpl="$TEMPLATE" ;;
    16x9)  tpl="$TEMPLATE_16X9" ;;
    *)     echo "RATIO must be 9x16 and/or 16x9 (got \"$r\")" >&2; exit 1 ;;
  esac
  [[ -f "$tpl" ]] || { echo "no template for $r: $tpl" >&2; exit 1; }
  $PY "$HERE/tools/build_prompt.py" "$OUT/scenes.json" \
    --out "$OUT/design-prompt-$r.txt" --template "$tpl"
  echo "  $r prompt -> $OUT/design-prompt-$r.txt"
done

# --------------------------------------------------- 4-6. per ratio ----------
# Steps 4-6 repeat per ratio. Narration and the scene map are already fixed, so
# every ratio muxes the same audio and is checked against the same cue times.
FINALS=()
for r in ${RATIO//,/ }; do
  case "$r" in
    9x16) dims="1080x1920" ;;
    16x9) dims="1920x1080" ;;
  esac
  suffix=""
  [[ "$r" == "16x9" ]] && suffix=" 16x9"
  final="$OUT/$PROJECT$suffix.mp4"

  stepr 4 "$r" "Claude Design $dims  —  KEEP THE CHROME WINDOW IN THE FOREGROUND"
  run_node "$HERE/cli/design-video.mjs" \
    --prompt-file "$OUT/design-prompt-$r.txt" \
    --out-dir "$OUT" --watch-dir "$WATCH" --connect "$CONNECT" \
    --name "silent-$r" --expect "$dims" --bin "$AB_BIN" \
    ${DESIGN_HOME:+--home "$DESIGN_HOME"} $EXTRA_VIDEO

  stepr 5 "$r" "merging narration"
  $PY "$HERE/tools/merge_audio_video.py" \
    "$OUT/silent-$r.mp4" "$OUT/narration.mp3" "$final" --pad

  stepr 6 "$r" "sync check"
  $PY "$HERE/tools/diagnose_sync.py" "$final" --cues "$OUT/cues.json" \
    | tee "$OUT/sync-report-$r.txt"

  FINALS+=("$final")
done

# ------------------------------------------------- 7. YouTube metadata -------
# Not part of the 6-step count above (it runs once regardless of RATIO) but
# cheap and useful enough to do on every run: title/description/hashtags,
# derived straight from scenes.json so they can never drift from the video's
# actual script.
step 7 "YouTube metadata"
$PY "$HERE/tools/youtube_meta.py" "$OUT/scenes.json" --out "$OUT/youtube.json"

printf '\n\033[1mdone\033[0m\n'
for f in "${FINALS[@]}"; do
  printf '  %s\n' "$f"
done
printf '  %s\n' "$OUT/youtube.json"
cat <<EOF

If a sync report reports a constant drift, correct it without re-rendering:
  $PY "$HERE/tools/apply_sync_offset.py" \\
     "$OUT/silent-<ratio>.mp4" "$OUT/narration.mp3" "<final>.mp4" \\
     --offset-ms <N> --pad
EOF
