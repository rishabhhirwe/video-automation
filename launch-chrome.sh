#!/usr/bin/env bash
#
# launch-chrome.sh — start a Chrome that agent-browser can attach to.
#
# Two things make this necessary:
#
#   1. A normally-launched Chrome exposes no DevTools port, and an
#      already-running Chrome silently ignores the flag.
#   2. Chrome 136 and later REFUSE --remote-debugging-port when the browser is
#      using its default profile. Pointing it at your normal profile opens no
#      port at all, with no error — which is exactly what you'd otherwise spend
#      an afternoon chasing.
#
# So this launches a SEPARATE Chrome with its own profile directory. Your normal
# Chrome can stay open and untouched; nothing here quits or touches it.
#
# First run only: sign in to claude.ai in the window that opens. That profile
# persists, so every later run needs nothing from you.
#
set -euo pipefail

PORT="${PORT:-9222}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.presolv360-chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at: $CHROME" >&2
  echo "Set CHROME=/path/to/chrome and re-run." >&2
  exit 1
fi

if curl -sf --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "already listening on port $PORT — nothing to do"
  exit 0
fi

FIRST_RUN=0
[[ -d "$PROFILE_DIR" ]] || FIRST_RUN=1
mkdir -p "$PROFILE_DIR"

echo "starting the automation Chrome on port $PORT"
echo "profile: $PROFILE_DIR"

# nohup + disown so it survives this shell exiting. A backgrounded child dies
# with the terminal, which is why a previous attempt appeared to start and then
# vanish.
nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=ChromeWhatsNewUI \
  >/dev/null 2>&1 &
disown || true

for _ in $(seq 1 40); do
  sleep 0.5
  if curl -sf --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "ready"
    if (( FIRST_RUN )); then
      cat <<'EOF'

FIRST RUN — one thing to do, once.

A new Chrome window just opened with a fresh profile. It is not signed in to
anything yet. In THAT window:

  1. Go to claude.ai and sign in as rishabh.hirwe@presolv360.com
  2. Optionally open narakeet.com — the free tier works signed out, so this
     is only needed if you want your paid Narakeet account used.

It stays signed in from now on. Leave that window open while make-video.sh runs,
and keep it in the foreground when the Claude Design export starts.
EOF
    fi
    exit 0
  fi
done

cat >&2 <<EOF
Chrome started but never opened the debug port on $PORT.

Most likely another process is on that port. Try a different one:
  PORT=9333 ./launch-chrome.sh
then run make-video.sh with:
  CONNECT=cdp:9333 LABELS=labels.json ./make-video.sh script.txt "Five Mistakes"
EOF
exit 1
