#!/usr/bin/env bash
#
# watch-jobs.sh — the bridge that lets Claude drive video production from chat.
#
# WHY THIS EXISTS
#   Claude can read and write the "Video Automation" folder directly, but it
#   cannot run commands on macOS, and the sandbox it does have reaches neither
#   narakeet.com nor claude.ai. So the two browser steps have to be started by
#   something living on this Mac. That is this script.
#
# HOW IT WORKS
#   Claude drops a folder into  Video Automation/_jobs/<name>/  containing
#   job.json, script.txt and labels.json. This watcher notices it, runs
#   make-video.sh, and writes status + log back into the same folder. Claude
#   polls those and reports progress in chat.
#
#   Nobody has to touch a terminal after install-watcher.sh has been run once.
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${VIDEO_ROOT:-$HOME/Desktop/Video Automation}"
JOBS="$ROOT/_jobs"
POLL="${POLL_SECONDS:-10}"

mkdir -p "$JOBS"
echo "$(date '+%F %T')  watcher up — polling $JOBS every ${POLL}s"

log_to()  { local f="$1"; shift; printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$f"; }
status()  { printf '%s' "$2" > "$1/status"; }

run_job() {
  local dir="$1"
  local name; name="$(basename "$dir")"
  local logf="$dir/log.txt"

  : > "$logf"
  status "$dir" running
  log_to "$logf" "starting job: $name"

  # Settings come from job.json; every key is optional. Read as KEY=VALUE lines
  # so a project name with spaces survives intact.
  local project="Untitled" speed="1.35" voice="victor/en-in"
  local lang="en-IN" pause="0.8" skip_audio=""
  while IFS='=' read -r k v; do
    case "$k" in
      project)     project="$v" ;;
      speed)       speed="$v" ;;
      voice)       voice="$v" ;;
      lang)        lang="$v" ;;
      scene_pause) pause="$v" ;;
      skip_audio)  skip_audio="$v" ;;
    esac
  done < <(python3 - "$dir/job.json" <<'PY' 2>/dev/null
import json, sys
try:
    j = json.load(open(sys.argv[1]))
except Exception:
    j = {}
for k in ("project","speed","voice","lang","scene_pause","skip_audio"):
    v = str(j.get(k, "")).strip()
    if v:
        print(f"{k}={v}")
PY
  )

  log_to "$logf" "project: $project"

  if [[ ! -f "$dir/script.txt" ]]; then
    log_to "$logf" "ERROR: no script.txt in the job folder"
    status "$dir" failed
    return 1
  fi

  # The browser steps need the automation Chrome up. Start it if it isn't.
  if ! curl -sf --max-time 3 "http://127.0.0.1:${PORT:-9222}/json/version" >/dev/null 2>&1; then
    log_to "$logf" "automation Chrome not running — starting it"
    "$HERE/launch-chrome.sh" >> "$logf" 2>&1
    sleep 3
  fi

  # caffeinate keeps the Mac awake; a sleeping Mac stalls the Design export.
  local caff=""
  command -v caffeinate >/dev/null 2>&1 && caff="caffeinate -dimsu"

  # OUT_DIR must be pinned to this watcher's root — make-video.sh otherwise
  # defaults to ~/Desktop/Video Automation, which may not be where we're looking.
  OUT_DIR="$ROOT/$project" \
  LABELS="$( [[ -f "$dir/labels.json" ]] && echo "$dir/labels.json" )" \
  SKIP_AUDIO="$skip_audio" \
  SPEED="$speed" VOICE="$voice" LANG_CODE="$lang" SCENE_PAUSE="$pause" \
    $caff "$HERE/make-video.sh" "$dir/script.txt" "$project" >> "$logf" 2>&1
  local rc=$?

  if (( rc == 0 )); then
    local out="$ROOT/$project/$project.mp4"
    if [[ -f "$out" ]]; then
      printf '%s' "$out" > "$dir/result"
      log_to "$logf" "done: $out"
      status "$dir" done
    else
      log_to "$logf" "ERROR: make-video.sh succeeded but $out is missing"
      status "$dir" failed
    fi
  else
    log_to "$logf" "ERROR: make-video.sh exited $rc"
    status "$dir" failed
  fi
  return 0
}

while true; do
  shopt -s nullglob
  for dir in "$JOBS"/*/; do
    dir="${dir%/}"
    [[ -f "$dir/job.json" ]] || continue
    # A job with no status file has never been picked up. "queued" means Claude
    # explicitly re-queued it. Anything else (running/done/failed) is left alone.
    if [[ ! -f "$dir/status" ]] || [[ "$(cat "$dir/status" 2>/dev/null)" == "queued" ]]; then
      run_job "$dir"
    fi
  done
  shopt -u nullglob
  sleep "$POLL"
done
