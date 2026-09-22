#!/usr/bin/env bash
#
# doctor.sh — check everything make-video.sh needs, before it needs it.
# Run this once on a new machine, and any time something breaks.
#
set -uo pipefail

PORT="${PORT:-9222}"
ok=0; bad=0
pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; ok=$((ok+1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [[ $# -gt 1 ]] && printf '        %s\n' "$2"; bad=$((bad+1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; [[ $# -gt 1 ]] && printf '        %s\n' "$2"; }

echo "presolv360-video doctor"
echo

# --- tools -----------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  v=$(node -v); maj=${v#v}; maj=${maj%%.*}
  if (( maj >= 20 )); then pass "node $v"; else fail "node $v is too old" "need Node 20 or newer"; fi
else
  fail "node not found" "install from nodejs.org, or: brew install node"
fi

command -v python3 >/dev/null 2>&1 \
  && pass "python3 $(python3 -V 2>&1 | cut -d' ' -f2)" \
  || fail "python3 not found" "brew install python"

command -v ffmpeg >/dev/null 2>&1 \
  && pass "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)" \
  || fail "ffmpeg not found" "brew install ffmpeg  — needed for the merge and the sync check"

command -v ffprobe >/dev/null 2>&1 \
  && pass "ffprobe" \
  || fail "ffprobe not found" "ships with ffmpeg: brew install ffmpeg"

command -v agent-browser >/dev/null 2>&1 \
  && pass "agent-browser $(agent-browser --version 2>/dev/null | head -1)" \
  || fail "agent-browser not found" "brew install agent-browser"

# --- browser ---------------------------------------------------------------
if curl -sf --max-time 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  pass "Chrome debug port $PORT is open"
  [[ -d "$HOME/.presolv360-chrome" ]] && pass "automation Chrome profile exists" \
    || warn "no automation profile yet" "./launch-chrome.sh creates one; sign in to claude.ai there once"
else
  fail "Chrome debug port $PORT is closed" "run: ./launch-chrome.sh   (your normal Chrome can stay open)"
fi

# --- folders ---------------------------------------------------------------
[[ -d "$HOME/Downloads" ]] && pass "~/Downloads exists" || fail "~/Downloads missing"

echo
if (( bad )); then
  echo "$bad problem(s) to fix before running make-video.sh."
  exit 1
fi
echo "all clear — ./make-video.sh script.txt \"Project Name\""
