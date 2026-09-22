# Setup — run this on your own laptop

## 1. Get the code
```bash
git clone https://github.com/rishabhhirwe/video-automation.git
cd video-automation
```

## 2. Install these (once)
- Node.js
- Python 3
- ffmpeg
- agent-browser: `brew install agent-browser`

## 3. Check everything's ready
```bash
./doctor.sh
```
Fix anything it flags.

## 4. Start the automation browser (once)
```bash
./launch-chrome.sh
```
A new Chrome window opens. Sign in to **claude.ai** with your own org account.
Leave that window open — don't sign in to your normal Chrome.

## 5. Make a video
```bash
LABELS=labels.json ./make-video.sh script.txt "Project Name"
```

**Keep that Chrome window in front (not minimized, not covered) while it
runs.** If you switch away, the video stops rendering.

Takes about 20 minutes. Output lands in a new folder named after your project.
