/**
 * Shared agent-browser glue for the two browser steps.
 *
 * Everything here exists because of something the live sites actually do:
 *
 *  - clickByText / tagVisible: both Narakeet and Claude Design render the
 *    controls we need as plain <button>s with no test ids, and Narakeet ships
 *    three copies of its form with only one visible. Selecting by text and by
 *    non-zero rect is the only reliable hook.
 *  - js(): base64 so no prompt, script or selector ever has to survive shell
 *    quoting.
 *  - Synthetic element.click() is used rather than coordinate clicks. Verified
 *    to work on both sites' handlers, and it means no screenshots are taken and
 *    nothing depends on window size or device pixel ratio.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

export function connectArgs(connect) {
  if (connect === "auto") return ["--auto-connect"];
  if (connect.startsWith("cdp:")) return ["--cdp", connect.slice(4)];
  if (connect.startsWith("profile:")) return ["--profile", connect.slice(8)];
  throw new Error(`--connect must be auto | cdp:PORT | profile:PATH (got "${connect}")`);
}

export function makeAgent({ bin, connect, session, verbose }) {
  const base = [...connectArgs(connect), "--session", session,
    "--proxy-bypass", "localhost,127.0.0.1"];

  const ab = async (...args) => {
    if (verbose) console.error(`  $ ${bin} ${[...base, ...args].join(" ")}`);
    try {
      const { stdout } = await exec(bin, [...base, ...args], { maxBuffer: 1 << 26 });
      return stdout.trim();
    } catch (e) {
      const msg = (e.stderr || e.message || "").trim();
      if (/auto-connect|no browser|could not connect|ECONNREFUSED/i.test(msg)) {
        throw new Error(
          `agent-browser could not attach to a browser.\n` +
          `  With --connect auto, Chrome must already be running with a debug port.\n` +
          `  Start it with:  ./launch-chrome.sh\n` +
          `  Or use a dedicated signed-in profile:  --connect profile:~/.presolv-browser\n` +
          `  agent-browser said: ${msg.split("\n")[0]}`);
      }
      throw new Error(msg || String(e));
    }
  };

  /** Run JS in the page and parse whatever comes back. */
  const js = async (code) => {
    const out = await ab("eval", "-b", Buffer.from(code, "utf8").toString("base64"));
    try { return JSON.parse(JSON.parse(out)); } catch {}
    try { return JSON.parse(out); } catch { return out; }
  };

  /**
   * Click one element by CSS selector.
   *
   * Deliberately NOT `agent-browser click <sel>`: that reports success while
   * silently failing to dispatch the event in some setups, which is a very
   * expensive way to fail (you find out via a timeout minutes later). A
   * synthetic .click() is verified to work on both Narakeet's and Claude
   * Design's handlers, and it fails loudly when the element isn't there.
   */
  const clickSelector = (sel) => js(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return JSON.stringify({ok:false, reason:'no element matching ' + ${JSON.stringify(sel)}});
      el.scrollIntoView({block:'center'});
      try { el.focus(); } catch {}
      el.click();
      return JSON.stringify({ok:true});
    })()`);

  /** Put the caret in a text field so CDP insertText lands in the right place. */
  const focusSelector = (sel) => js(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return JSON.stringify({ok:false, reason:'no element matching ' + ${JSON.stringify(sel)}});
      el.scrollIntoView({block:'center'});
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return JSON.stringify({ok: document.activeElement === el || el.contains(document.activeElement)});
    })()`);

  /** Click the first visible element whose text contains `needle`. */
  const clickByText = (needle, { role = "button", last = false } = {}) => js(`
    (() => {
      const n = ${JSON.stringify(needle)};
      const sel = ${JSON.stringify(role)} === "radio"
        ? '[role="radio"]' : 'button,[role="button"],[role="menuitem"],[role="option"]';
      const all = [...document.querySelectorAll(sel)]
        .filter(e => (e.innerText || e.textContent || '').includes(n));
      const seen = all.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const pool = seen.length ? seen : all;
      const hit = ${last ? "pool[pool.length - 1]" : "pool[0]"};
      if (!hit) return JSON.stringify({ok:false, reason:'not found: ' + n, candidates: all.length});
      hit.click();
      return JSON.stringify({ok:true, text:(hit.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60)});
    })()`);

  /**
   * Give the one visible member of a duplicated control set a unique id, so a
   * real Playwright click can target it unambiguously.
   */
  const tagVisible = (selector, id) => js(`
    (() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const v = els.find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!v) return JSON.stringify({ok:false, total: els.length});
      v.id = ${JSON.stringify(id)};
      return JSON.stringify({ok:true, total: els.length});
    })()`);

  /** Set a <select> the way a real user would, so framework listeners fire. */
  const setSelect = (selector, value) => js(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ok:false, reason:'no such select'});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')
        .set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({ok: el.value === ${JSON.stringify(value)}, value: el.value});
    })()`);

  const pageText = () => js(`JSON.stringify({t: document.body.innerText})`);

  const bodyMatches = async (re) => re.test((await pageText()).t || "");

  /** Poll a predicate until true or the deadline passes. */
  const waitUntil = async (fn, { timeout, poll = 4, label = "condition" }) => {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      await sleep(poll);
      if (await fn()) return true;
    }
    throw new Error(`timed out after ${timeout}s waiting for ${label}`);
  };

  /**
   * Close the tab this session is actually bound to, not the whole browser.
   *
   * `agent-browser close` (used everywhere else in this codebase) only tears
   * down agent-browser's own session/connection — verified against a live
   * tab that it reports "Browser closed" while the tab stays open in Chrome.
   * That is why every run used to leave a Design or Narakeet tab open after
   * finishing. `tab list` marks the bound tab with a leading arrow; switch to
   * it explicitly (`tab close` acts on whichever tab is current) and close
   * that one. If it is the window's only tab, agent-browser refuses ("Cannot
   * close the last tab") rather than closing the window - opening a blank
   * tab first gives it a second tab to fall back to, so the browser window
   * itself never has to be closed.
   */
  const closeTab = async () => {
    const list = await ab("tab", "list").catch(() => "");
    const m = list.match(/^→\s*\[(\S+)\]/m);
    if (!m) return; // no bound tab found - nothing to close
    const id = m[1];
    if (/^\[t?1\]$/.test(`[${id}]`) && list.trim().split("\n").length <= 1) {
      await ab("tab", "new").catch(() => {});
    }
    await ab("tab", id).catch(() => {});
    await ab("tab", "close").catch(() => {});
  };

  return { ab, js, clickSelector, focusSelector, clickByText, tagVisible,
           setSelect, pageText, bodyMatches, waitUntil, closeTab };
}

/* ------------------------------------------------------- download watching */

import fs from "node:fs";
import path from "node:path";

export function snapshotFiles(dir, re) {
  try { return new Set(fs.readdirSync(dir).filter((f) => re.test(f))); }
  catch { return new Set(); }
}

/**
 * A file is "new" if its name wasn't there when we clicked, OR its mtime is
 * after the click. The mtime arm matters because browsers reuse names and
 * because a partial download renames in place when it completes.
 */
export function freshFiles(dir, re, before, sinceMs) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => re.test(f)); } catch { return []; }
  return names.map((f) => {
    const p = path.join(dir, f);
    try { return { p, f, m: fs.statSync(p).mtimeMs }; } catch { return null; }
  }).filter(Boolean)
    .filter((x) => !before.has(x.f) || x.m >= sinceMs - 2000)
    .sort((a, b) => b.m - a.m);
}

/** Wait for a new matching file, then wait for it to stop growing. */
export async function awaitDownload(dir, re, before, sinceMs, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await sleep(2);
    const fresh = freshFiles(dir, re, before, sinceMs);
    if (fresh.length) {
      let last = -1;
      for (let i = 0; i < 90; i++) {
        let sz;
        try { sz = fs.statSync(fresh[0].p).size; } catch { break; }
        if (sz === last && sz > 0) break;
        last = sz;
        await sleep(1);
      }
      return fresh[0].p;
    }
  }
  return null;
}
