#!/usr/bin/env node
/**
 * design-video — Design prompt in, silent 1080x1920 MP4 out. agent-browser.
 *
 * Verified against the live Claude Design UI:
 *
 *   - The design system RESETS to the org default (Litelo) on every page load.
 *     It is not a setting that sticks, which is why an earlier hand-run came
 *     out in the wrong brand. This re-sets it every time and verifies it took.
 *   - Composer is [data-testid="home-composer-input"] (ProseMirror) and Create
 *     is [data-testid="home-composer-send"] — the only stable test ids on the
 *     page.
 *   - ProseMirror ignores programmatic writes, so the prompt goes in via CDP
 *     Input.insertText. Per-character typing risks Enter submitting mid-prompt.
 *   - Export lives behind Share, in a portal with no test ids and no accessible
 *     names, so those controls are matched by text.
 *   - Synthetic element.click() works on its React handlers, so nothing here
 *     depends on screenshots, window size or device pixel ratio.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAgent, sleep, snapshotFiles, awaitDownload } from "./lib/agent.mjs";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const flag = (n) => process.argv.includes(`--${n}`);

const CFG = {
  promptFile: arg("prompt-file"),
  project: arg("project"),
  outDir: path.resolve(arg("out-dir", "./out")),
  watchDir: path.resolve(arg("watch-dir", path.join(os.homedir(), "Downloads"))),
  designSystem: arg("design-system", "Presolv360 Design System"),
  size: arg("size", "original"),
  name: arg("name", "silent"),
  home: arg("home", "https://claude.ai/design"),
  connect: arg("connect", "auto"),
  timeout: Number(arg("timeout", 1800)),
  stableFor: Number(arg("stable", 30)),
  exportTimeout: Number(arg("export-timeout", 1200)),
  poll: Number(arg("poll", 5)),
  appTimeout: Number(arg("app-timeout", 90)),
  session: arg("session", "design-video"),
  bin: arg("bin", "agent-browser"),
  dryRun: flag("dry-run"),
  keepOpen: flag("keep-open"),
  verbose: flag("verbose"),
  noAssets: flag("no-assets"),
  assets: (arg("assets", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
  expect: arg("expect"),
};

/**
 * Brand references attached to every build. The mascot sheet carries the five
 * approved poses and the logo carries the wordmark, so Design copies them
 * rather than redrawing from prose.
 */
const DEFAULT_ASSETS = [
  "Mascot 3x3-1 1 Background Removed.png",
  "Stacked Logo.png",
].map((f) => path.join(os.homedir(), "Desktop", "Video Automation",
  "presolv animated vids", f));

const SEL = {
  composer: '[data-testid="home-composer-input"]',
  create: '[data-testid="home-composer-send"]',
  designSystemButton: "Design system",
  share: "Share",
  // Verified 2026-09-09: a single-page composition surfaces the video row
  // directly in the Share panel. A multi-page project (e.g. the 16:9 build,
  // which puts the end card on its own page) does not — the panel then only
  // lists PDF / Project HTML / PowerPoint, and the video option is one level
  // deeper under "More formats and apps" as "Video — MP4, for animation
  // pages". exportVideo() tries the direct row first, then that submenu.
  videoRow: "MP4 of this animation",
  moreFormats: "More formats and apps",
  videoRowNested: "MP4, for animation pages",
  sizeRadio: { original: "Original size", 720: "720 × 1280", 338: "338 × 600" },
  projectUrl: /\/design\/p\/[0-9a-f-]{36}/,
};

const log = (...a) => console.log(...a);
const A = makeAgent(CFG);

// A killed/interrupted run (Ctrl-C, TaskStop, the terminal closing) never
// reaches main()'s own `finally` - that only runs when the process throws or
// returns normally, not when it's torn down externally. Without this, a
// stopped run leaves its Chrome tab open indefinitely with no automation
// still watching it.
let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    if (!CFG.keepOpen) {
      console.error(`\n${sig} - closing the automation tab before exiting`);
      await A.closeTab().catch(() => {});
      await A.ab("close").catch(() => {});
    }
    process.exit(1);
  });
}

const state = () => A.js(`
  JSON.stringify({
    url: location.href,
    title: document.title,
    len: document.body.innerText.length,
    designSystem: ([...document.querySelectorAll('button')]
      .map(b => (b.innerText||'').replace(/\\s+/g,' ').trim())
      .find(t => t.startsWith('Design system')) || '')
      .replace('Design system','').trim(),
    model: ([...document.querySelectorAll('button')]
      .map(b => (b.innerText||'').replace(/\\s+/g,' ').trim())
      .find(t => t.startsWith('Model')) || '').replace('Model','').trim(),
    busy: !!document.querySelector('[aria-busy="true"]'),
    working: /\\b(Stop|Stop generating|Generating|Thinking)\\b/.test(
      [...document.querySelectorAll('button')].map(b=>b.innerText||'').join(' ')),
    hasShare: [...document.querySelectorAll('button')]
      .some(b => (b.innerText||'').trim() === 'Share')
  })`);

/**
 * claude.ai/design is a heavy SPA. A fixed sleep after `open` is not enough —
 * on a cold profile the composer and its controls can take 20s+ to appear, and
 * reading them too early yields empty strings that look like a selector break.
 */
async function waitForApp(timeoutS = 90) {
  const deadline = Date.now() + timeoutS * 1000;
  let last = {};
  while (Date.now() < deadline) {
    const s = await A.js(`
      JSON.stringify({
        title: document.title,
        signin: /sign ?in|log ?in/i.test(document.title),
        composer: !!document.querySelector('[data-testid="home-composer-input"]'),
        ds: [...document.querySelectorAll('button')]
              .some(b => (b.innerText||'').trim().startsWith('Design system')),
        buttons: document.querySelectorAll('button').length
      })`);
    last = s;
    if (s.signin) {
      throw new Error(
        "that Chrome is not signed in to claude.ai.\n" +
        "  Open the automation Chrome window (the one launch-chrome.sh started),\n" +
        "  sign in there once, then re-run.");
    }
    if (s.composer && s.ds) return s;
    await sleep(2);
  }
  throw new Error(
    `claude.ai/design did not finish loading within ${timeoutS}s.\n` +
    `  composer=${last.composer} designSystemButton=${last.ds} ` +
    `buttons=${last.buttons} title="${last.title}"\n` +
    `  If the window shows a signed-in Claude Design page, raise --app-timeout.`);
}

async function ensureDesignSystem() {
  let st = await state();
  if (st.designSystem === CFG.designSystem) {
    log(`  design system already ${st.designSystem}`);
    return;
  }
  log(`  design system is "${st.designSystem}" — switching to "${CFG.designSystem}"`);
  const opened = await A.clickByText(SEL.designSystemButton);
  if (!opened.ok) {
    const seen = await A.js(`JSON.stringify({b:[...document.querySelectorAll('button')]
      .map(x=>(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,12)})`);
    throw new Error(`design system selector not found. Buttons on the page: ${
      JSON.stringify(seen.b)}`);
  }
  await sleep(1.5);
  if (!(await A.clickByText(CFG.designSystem)).ok) {
    throw new Error(`"${CFG.designSystem}" is not in the design system list`);
  }
  await sleep(2);
  st = await state();
  if (st.designSystem !== CFG.designSystem) {
    throw new Error(`switch failed — still "${st.designSystem}"`);
  }
  log(`  design system now ${st.designSystem}`);
}

async function loadPrompt(text) {
  const f = await A.focusSelector(SEL.composer);
  if (!f.ok) throw new Error(`could not focus the composer (${SEL.composer})`);
  await A.ab("keyboard", "inserttext", text);
  await sleep(1.5);
  const got = await A.js(`JSON.stringify({chars:
    (document.querySelector(${JSON.stringify(SEL.composer)})?.innerText || '').length})`);
  if (got.chars < text.length * 0.8) {
    throw new Error(`prompt did not land in the composer (${got.chars} of ${text.length} chars)`);
  }
  log(`  prompt loaded: ${got.chars} chars`);
}

/**
 * Attach the brand reference images to the composer.
 *
 * Describing the mascot in prose is not enough — Design redraws it from the
 * text and it comes out as the flat speech-bubble logo mark instead of the
 * full character. The composer has a bare `input[type=file]` (multiple, no
 * accept filter) and `agent-browser upload` drives it; verified against the
 * live page, the thumbnails appear as <img alt="<filename>">.
 */
async function attachAssets(files) {
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    throw new Error(
      `these attachments do not exist:\n${missing.map((m) => `    ${m}`).join("\n")}`);
  }
  const has = await A.js(
    `JSON.stringify({n: document.querySelectorAll('input[type=file]').length})`);
  if (!has.n) {
    throw new Error(
      "no file input on the Design composer — the attach UI changed.\n" +
      "  Re-run with --no-assets to build without the brand references.");
  }
  await A.ab("upload", "input[type=file]", ...files);

  // The thumbnails render asynchronously; confirm each landed by alt text.
  const names = files.map((f) => path.basename(f));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const got = await A.js(`JSON.stringify({alts:
      [...document.querySelectorAll('img')].map(i => i.alt || '').filter(Boolean)})`);
    const seen = names.filter((n) => got.alts.some((a) => a.includes(n)));
    if (seen.length === names.length) {
      log(`  attached ${seen.length} reference image(s): ${names.join(", ")}`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `only ${seen.length} of ${names.length} attachments appeared in the composer ` +
        `within 30s (saw: ${JSON.stringify(got.alts.slice(0, 6))})`);
    }
    await sleep(2);
  }
}

async function waitForBuild() {
  let lastLen = -1, stableSince = null, projectUrl = null;
  log(`  building — settle window ${CFG.stableFor}s, timeout ${CFG.timeout}s`);
  const deadline = Date.now() + CFG.timeout * 1000;

  while (Date.now() < deadline) {
    await sleep(CFG.poll);
    const st = await state();
    if (!projectUrl && SEL.projectUrl.test(st.url)) {
      projectUrl = st.url;
      log(`  project: ${projectUrl}`);
    }
    const settled = projectUrl && st.hasShare && !st.busy && !st.working;
    if (settled && st.len === lastLen) {
      stableSince ??= Date.now();
      if ((Date.now() - stableSince) / 1000 >= CFG.stableFor) {
        log(`  settled`);
        return projectUrl;
      }
    } else {
      stableSince = null;
    }
    lastLen = st.len;
    if (CFG.verbose) log(`    len=${st.len} share=${st.hasShare} busy=${st.busy} working=${st.working}`);
  }
  throw new Error(
    `build did not settle within ${CFG.timeout}s.\n` +
    `  Raise --timeout, or finish the project by hand and re-run with --project <url>.`);
}

async function exportVideo() {
  log(`  Share`);
  if (!(await A.clickByText(SEL.share)).ok) throw new Error("Share button not found");
  await sleep(1.8);

  log(`  Export -> Video`);
  let videoOpened = await A.clickByText(SEL.videoRow);
  if (!videoOpened.ok) {
    // Multi-page projects (the 16:9 template's end card is its own page)
    // nest the video option under this submenu instead of the top level.
    log(`  "${SEL.videoRow}" not in the Share panel — trying "${SEL.moreFormats}"`);
    const opened = await A.clickByText(SEL.moreFormats);
    if (!opened.ok) {
      throw new Error(
        "Video export row not found, and no \"More formats and apps\" " +
        "fallback either — is this project an animation?");
    }
    await sleep(1.2);
    videoOpened = await A.clickByText(SEL.videoRowNested);
    if (!videoOpened.ok) {
      throw new Error(
        `Video export not found under "${SEL.moreFormats}" either — ` +
        "is this project an animation?");
    }
  }
  await sleep(2);

  const wanted = SEL.sizeRadio[CFG.size] ?? SEL.sizeRadio.original;
  log(`  size: ${wanted}`);
  if (!(await A.clickByText(wanted, { role: "radio" })).ok) {
    throw new Error(`size option "${wanted}" not found`);
  }
  await sleep(0.8);

  const re = /\.(mp4|webm|mov)$/i;
  const before = snapshotFiles(CFG.watchDir, re);
  const clickedAt = Date.now();

  log(`  Export`);
  // "Export" appears twice (the section heading and the button); take the last.
  if (!(await A.clickByText("Export", { last: true })).ok) {
    throw new Error("Export confirm button not found");
  }

  log(`  rendering — KEEP THE BROWSER WINDOW IN THE FOREGROUND`);
  const got = await awaitDownload(CFG.watchDir, re, before, clickedAt, CFG.exportTimeout);
  if (!got) {
    throw new Error(
      `no MP4 appeared in ${CFG.watchDir} within ${CFG.exportTimeout}s.\n` +
      `  Claude Design pauses the render when its window is in the background.`);
  }
  return got;
}

async function main() {
  if (!CFG.promptFile && !CFG.project) {
    console.error(`
design-video — Claude Design prompt -> silent 1080x1920 MP4

  --prompt-file <path>   the Design prompt              (required unless --project)
  --project <url>        skip creation, export this existing project
  --out-dir <path>                                      (default ./out)
  --watch-dir <path>     browser download folder        (default ~/Downloads)
  --design-system <name>                                (default "Presolv360 Design System")
  --size original|720|338                               (default original = 1080x1920)
  --name <slug>                                         (default silent)
  --connect auto|cdp:PORT|profile:PATH                  (default auto)
  --timeout <s>          build settle timeout           (default 1800)
  --stable <s>           no-change window = done        (default 30)
  --export-timeout <s>                                  (default 1200)
  --app-timeout <s>      wait for claude.ai/design to render   (default 90)
  --home <url>           override, for the mock
  --assets <a.png,b.png> brand references to attach   (default mascot + logo)
  --no-assets            build without attaching them
  --expect <WxH>         fail if the export is not these dimensions
  --dry-run  --keep-open  --verbose
`.trim());
    process.exit(1);
  }

  fs.mkdirSync(CFG.outDir, { recursive: true });
  const started = Date.now();
  let projectUrl = CFG.project;

  try {
    if (CFG.project) {
      log(`open    ${CFG.project}`);
      await A.ab("open", CFG.project);
      await A.waitUntil(async () => (await state()).hasShare,
        { timeout: CFG.appTimeout, poll: 3, label: "the project to load" });
    } else {
      const prompt = fs.readFileSync(CFG.promptFile, "utf8").trim();
      if (!prompt) throw new Error(`${CFG.promptFile} is empty`);
      log(`prompt  ${CFG.promptFile} (${prompt.length} chars)`);

      log(`open    ${CFG.home}`);
      await A.ab("open", CFG.home);
      log(`  waiting for the app to load`);
      await waitForApp(CFG.appTimeout);
      const st0 = await state();
      log(`model   ${st0.model || "unknown"}`);

      await ensureDesignSystem();

      // Attachments first: the upload steals focus, so loadPrompt must run
      // after it or the prompt text lands outside the composer.
      const assets = CFG.assets.length ? CFG.assets : DEFAULT_ASSETS;
      if (CFG.noAssets) {
        log(`  --no-assets — building without the brand references`);
      } else {
        await attachAssets(assets);
      }

      await loadPrompt(prompt);
      if (CFG.dryRun) { log(`\ndry run — not submitting.`); return; }

      log(`create`);
      const c = await A.clickSelector(SEL.create);
      if (!c.ok) throw new Error(c.reason);
      projectUrl = await waitForBuild();
    }

    const downloaded = await exportVideo();
    const dest = path.join(CFG.outDir, `${CFG.name}.mp4`);
    fs.renameSync(downloaded, dest);

    // "Original size" exports the composition's own canvas, so this is the
    // only place a wrong-aspect build shows up. Fail loudly rather than
    // handing back a video in the ratio nobody asked for.
    if (CFG.expect) {
      const [w, h] = CFG.expect.split("x").map(Number);
      const probe = await import("node:child_process").then((cp) =>
        cp.execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
          "-show_entries", "stream=width,height", "-of", "csv=p=0", dest],
          { encoding: "utf8" }).trim());
      const [gw, gh] = probe.split(",").map(Number);
      if (gw !== w || gh !== h) {
        throw new Error(
          `exported ${gw}x${gh} but expected ${w}x${h}.\n` +
          `  Claude Design built the composition at the wrong aspect ratio.\n` +
          `  The MP4 is kept at ${dest} — inspect it, then re-render.\n` +
          `  Retiming or reshaping a built composition does not work; build again.`);
      }
      log(`  dimensions ${gw}x${gh} as expected`);
    }

    const secs = ((Date.now() - started) / 1000).toFixed(0);
    log(`\nwrote   ${dest}  (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB, ${secs}s)`);
    console.log(JSON.stringify({ ok: true, mp4: dest, project: projectUrl, seconds: Number(secs) }));
  } finally {
    if (!CFG.keepOpen) await A.closeTab().catch(() => {});
      await A.ab("close").catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(1);
});
