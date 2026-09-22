#!/usr/bin/env node
/**
 * narakeet-audio — narration script in, MP3 out. agent-browser, headless.
 *
 * Every quirk below came from driving the live UI, not from guessing:
 *
 *   - The editor is #unparsedScriptEditor, a DIV with contenteditable=""
 *     (empty string, NOT "true") — generic selectors miss it entirely.
 *   - Writing to the DOM never reaches textarea[name="content"], so real input
 *     is mandatory. Text goes in via CDP Input.insertText.
 *   - Return is swallowed by the editor; newlines must be part of the text.
 *   - Three button[role="create-audio"] exist; only one has a non-zero rect.
 *     Same for Download. We tag the visible one and click that.
 *   - Speed is unreachable in the UI (div.control-block.hidden, no toggle) —
 *     the supported route is a (voice-speed: N) stage direction.
 *   - A (pause: N) between paragraphs is what makes scene boundaries findable
 *     afterwards. Without it, the gap between scenes is the same ~0.4s as the
 *     gap between clauses and nothing downstream can tell them apart.
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
  scriptFile: arg("script-file"),
  outDir: path.resolve(arg("out-dir", "./out")),
  watchDir: path.resolve(arg("watch-dir", path.join(os.homedir(), "Downloads"))),
  lang: arg("lang", "en-IN"),
  voice: arg("voice", "victor/en-in"),
  speed: arg("speed", "1.35"),
  scenePause: arg("scene-pause", "0.8"),
  name: arg("name", "narration"),
  home: arg("home", "https://www.narakeet.com/app/text-to-audio/"),
  connect: arg("connect", "auto"),
  timeout: Number(arg("timeout", 600)),
  poll: Number(arg("poll", 4)),
  session: arg("session", "narakeet"),
  bin: arg("bin", "agent-browser"),
  dryRun: flag("dry-run"),
  keepOpen: flag("keep-open"),
  verbose: flag("verbose"),
};

const SEL = {
  editor: "#unparsedScriptEditor",
  lang: 'select[name="language"]',
  voice: 'select[name="voice"]',
  createRole: 'button[role="create-audio"]',
  ready: /Your audio is ready/i,
};

const log = (...a) => console.log(...a);
const A = makeAgent(CFG);

// A killed/interrupted run (Ctrl-C, TaskStop, the terminal closing) never
// reaches main()'s own `finally` - that only runs when the process throws or
// returns normally, not when it's torn down externally. Without this, a
// stopped run leaves its Narakeet tab open indefinitely with no automation
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

function buildScript() {
  const raw = fs.readFileSync(CFG.scriptFile, "utf8").trim();
  if (!raw) throw new Error(`${CFG.scriptFile} is empty`);
  const paras = raw.replace(/\r\n/g, "\n").split(/\n\s*\n/)
    .map((p) => p.trim()).filter(Boolean);
  const gap = Number(CFG.scenePause);
  const body = gap > 0 ? paras.join(`\n\n(pause: ${gap})\n\n`) : paras.join("\n\n");
  const wantSpeed = CFG.speed && !["none", "normal", "0"].includes(CFG.speed);
  // Stage directions need a blank line before and after.
  return { text: wantSpeed ? `(voice-speed: ${CFG.speed})\n\n${body}` : body,
           paras: paras.length };
}

const editorState = () => A.js(`
  (() => {
    const ed = document.querySelector(${JSON.stringify(SEL.editor)});
    if (!ed) return JSON.stringify({present:false});
    const t = ed.innerText || '';
    return JSON.stringify({
      present: true, chars: t.length,
      blocks: t.replace(/\\n{2,}/g,'\\n\\n').trim().split('\\n\\n').filter(Boolean).length
    });
  })()`);

async function loadScript(text) {
  const wantBlocks = text.split(/\n{2,}/).filter(Boolean).length;

  const attempt = async (chunked) => {
    await A.js(`(() => {
      const ed = document.querySelector(${JSON.stringify(SEL.editor)});
      if (ed) { ed.innerHTML=''; ed.dispatchEvent(new InputEvent('input',{bubbles:true})); }
      return JSON.stringify({ok:true});
    })()`);
    const f = await A.focusSelector(SEL.editor);
    if (!f.ok) throw new Error(`could not focus ${SEL.editor}`);
    if (chunked) {
      const paras = text.split(/\n{2,}/).filter(Boolean);
      for (let i = 0; i < paras.length; i++) {
        await A.ab("keyboard", "inserttext", (i ? "\n\n" : "") + paras[i]);
      }
    } else {
      await A.ab("keyboard", "inserttext", text);
    }
    await sleep(1.5);
    return editorState();
  };

  let st = await attempt(false);
  if (!st.present) throw new Error(`editor ${SEL.editor} not found — Narakeet's UI has changed`);
  if (st.blocks !== wantBlocks) {
    log(`  got ${st.blocks}/${wantBlocks} blocks, retrying paragraph by paragraph`);
    st = await attempt(true);
  }
  if (st.blocks !== wantBlocks) {
    throw new Error(`script did not land intact: ${st.blocks} blocks, expected ${wantBlocks}`);
  }
  log(`  script loaded: ${st.chars} chars, ${st.blocks} blocks`);
}

async function main() {
  if (!CFG.scriptFile) {
    console.error(`
narakeet-audio — narration script -> MP3

  --script-file <path>   plain text, one paragraph per scene   (required)
  --out-dir <path>       where the MP3 lands                   (default ./out)
  --watch-dir <path>     browser download folder               (default ~/Downloads)
  --lang <code>                                                (default en-IN)
  --voice <id>                                                 (default victor/en-in)
  --speed <n|none>       (voice-speed: n) directive            (default 1.35)
  --scene-pause <s>      (pause: s) between paragraphs so the
                         scene cue times stay recoverable      (default 0.8)
  --name <slug>                                                (default narration)
  --connect auto|cdp:PORT|profile:PATH                         (default auto)
  --timeout <s>                                                (default 600)
  --home <url>           override, for the mock
  --dry-run  --keep-open  --verbose
`.trim());
    process.exit(1);
  }

  fs.mkdirSync(CFG.outDir, { recursive: true });
  const { text, paras } = buildScript();
  log(`script  ${CFG.scriptFile} — ${paras} scenes, ${text.length} chars`);

  try {
    log(`open    ${CFG.home}`);
    await A.ab("open", CFG.home);
    await sleep(4);

    log(`voice   ${CFG.lang} / ${CFG.voice} @ speed ${CFG.speed}`);
    const l = await A.setSelect(SEL.lang, CFG.lang);
    if (!l.ok) throw new Error(`could not set language to ${CFG.lang}`);
    await sleep(2.5);                       // the voice list reloads per language
    const v = await A.setSelect(SEL.voice, CFG.voice);
    if (!v.ok) throw new Error(`voice ${CFG.voice} not available for ${CFG.lang}`);
    await sleep(1);

    await loadScript(text);
    if (CFG.dryRun) { log(`\ndry run — not submitting.`); return; }

    const tagged = await A.tagVisible(SEL.createRole, "abCreateAudio");
    if (!tagged.ok) throw new Error(`no visible Create Audio button (${tagged.total} in DOM)`);
    log(`create  (${tagged.total} buttons in DOM, clicking the visible one)`);
    const c = await A.clickSelector("#abCreateAudio");
    if (!c.ok) throw new Error(c.reason);

    await A.waitUntil(() => A.bodyMatches(SEL.ready),
      { timeout: CFG.timeout, poll: CFG.poll, label: "the audio to finish building" });

    const rep = await A.js(`JSON.stringify({d:(document.body.innerText
      .match(/AUDIO DURATION:?\\s*([0-9:]+)/i)||[])[1]||''})`);
    log(`  ready${rep.d ? `  (Narakeet reports ${rep.d})` : ""}`);

    const dl = await A.js(`
      (() => {
        const els = [...document.querySelectorAll('a,button')]
          .filter(e => /^download$/i.test((e.innerText||'').trim()));
        const v = els.find(e => e.getBoundingClientRect().width > 0);
        if (!v) return JSON.stringify({ok:false, total: els.length});
        v.id = 'abDownloadAudio';
        return JSON.stringify({ok:true, total: els.length});
      })()`);
    if (!dl.ok) throw new Error("no visible Download button");

    const re = /\.(mp3|wav|m4a)$/i;
    const before = snapshotFiles(CFG.watchDir, re);
    const clickedAt = Date.now();
    log(`download`);
    const d = await A.clickSelector("#abDownloadAudio");
    if (!d.ok) throw new Error(d.reason);

    const got = await awaitDownload(CFG.watchDir, re, before, clickedAt, 180);
    if (!got) throw new Error(`no audio appeared in ${CFG.watchDir} within 180s`);

    const dest = path.join(CFG.outDir, `${CFG.name}.mp3`);
    fs.renameSync(got, dest);
    log(`\nwrote   ${dest}  (${(fs.statSync(dest).size / 1e6).toFixed(2)} MB)`);
    console.log(JSON.stringify({ ok: true, mp3: dest }));
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
