// SPDX-License-Identifier: GPL-3.0-or-later
// node-driver.js - injected into every node webview AFTER the snapgent content
// scripts. Bridges the router (main process) and the extension running inside
// the page: receives 'rg-dispatch', makes sure the agent is started, sends the
// prompt through ZSProvider, records progress for handoff, and reports
// complete / fail back to the router via window.__rgNode.
//
// The extension's own agentic loop (core/main.js) keeps running tools; this
// driver only watches it from the outside (DOM + ZSProvider), because the loop
// state object `A` is private to that closure.

(() => {
  'use strict';
  if (window.__rgDriverInstalled) return;
  if (typeof ZSProvider === 'undefined' || !window.__rgNode || !window.chrome || !chrome.runtime) return;
  window.__rgDriverInstalled = true;

  const P = ZSProvider;
  const emit = (ev) => { try { window.__rgNode.emit(ev); } catch {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Tunables
  const POLL_MS = 1500;
  const QUIET_DONE_MS = 5000;      // agent idle this long after activity => task complete
  const STALL_MS = 120000;         // nothing happening this long while 'running' => failed
  const START_WAIT_MS = 20000;    // wait for the extension to finish its Starting Up phase
  const RECORD_MAX = 4000;        // chars kept per recorded turn
  const QUOTA_RE = /usage limit|quota|out of (messages|credits)|reached (your|the) (message )?limit|upgrade to (plus|pro)|exceeded|too many requests|rate limit|try again (later|in)|capacity/i;

  const $ = (sel) => document.querySelector(sel);
  const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';

  const actionKind = () => { const b = $('#zs-action'); return b ? (b.dataset.kind || '') : ''; };
  const noAgent = () => { const bar = $('#zs-bar'); return !!bar && bar.classList.contains('tone-noagent'); };
  const loopRunning = () => visible($('#zs-stop'));
  const generating = () => { try { return !!P.isGenerating(); } catch { return false; } };

  let job = null; // active task on this node

  // ── start the extension's agent session if it is not running yet ────────
  async function ensureStarted() {
    const t0 = Date.now();
    while (Date.now() - t0 < START_WAIT_MS) {
      const kind = actionKind();
      if (kind === 'start' || kind === 'start-degraded') {
        const b = $('#zs-action');
        if (b && !b.disabled) { b.click(); await sleep(1500); }
      } else if (noAgent()) {
        // Chat already has turns and the extension did not start it: it will
        // never offer Start here. Fail fast so the router can pick another node.
        if (Date.now() - t0 > 2500) return false;
      } else if (kind === '' && !loopRunning()) {
        // bar not rendered yet
      } else if (!generating()) {
        // Not asking for Start, not 'no agent', model idle: session is active.
        if (Date.now() - t0 > 2500) return true;
      }
      await sleep(500);
    }
    return !noAgent() && actionKind() !== 'start' && actionKind() !== 'start-degraded';
  }

  // ── progress capture for handoff ────────────────────────────────────────
  function snapshotTurns() {
    const out = [];
    try {
      for (const item of P.allItems()) {
        const role = P.isAssistantItem(item) ? 'assistant' : 'user';
        const text = String(P.itemText(item) || '').trim();
        if (text) out.push({ role, text });
      }
    } catch {}
    return out;
  }

  function recordNew(final) {
    if (!job) return;
    const turns = snapshotTurns();
    const stableNow = !generating();
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const key = `${t.role}:${t.text.length}:${t.text.slice(0, 80)}`;
      if (job.seen.has(key)) continue;
      const isLast = i === turns.length - 1;
      if (isLast && !stableNow && !final) continue; // still streaming: wait
      job.seen.add(key);
      if (i < job.baseline) continue; // existed before this task
      if (t.role === 'user' && !/^Output of /i.test(t.text)) continue; // only tool results
      emit({ type: 'record', role: t.role === 'user' ? 'tool-result' : 'assistant', text: t.text.slice(0, RECORD_MAX) });
      job.lastProgressAt = Date.now();
    }
  }

  // ── failure detection ───────────────────────────────────────────────────
  function detectFailure() {
    let err = null;
    try { err = P.scanError(); } catch {}
    if (err && !/input box is not available/i.test(err)) return err;
    try {
      const last = P.lastAssistant();
      const txt = last ? String(P.itemText(last) || '') : '';
      if (txt.length < 600) {
        if (P.isTooLongMsg(txt)) return 'conversation too long';
        if (P.isBusyMsg(txt) || QUOTA_RE.test(txt)) return `provider limit: ${txt.slice(0, 120)}`;
      }
    } catch {}
    const banner = $('#zs-root .zs-banner, .zs-banner');
    if (banner && QUOTA_RE.test(banner.textContent || '')) return String(banner.textContent).trim().slice(0, 160);
    return null;
  }

  function finish(kind, reason) {
    if (!job) return;
    recordNew(true);
    clearInterval(job.timer);
    job = null;
    emit(kind === 'complete' ? { type: 'complete' } : { type: 'fail', reason });
  }

  function watch() {
    if (!job) return;
    const now = Date.now();
    const running = loopRunning() || generating();
    if (running) { job.sawActivity = true; job.lastActiveAt = now; }
    recordNew(false);

    const failure = detectFailure();
    if (failure && !running) return finish('fail', failure);
    if (failure && now - job.lastProgressAt > 15000) return finish('fail', failure);

    if (job.sawActivity && !running && now - job.lastActiveAt >= QUIET_DONE_MS) {
      return finish('complete');
    }
    if (now - Math.max(job.lastActiveAt, job.lastProgressAt) > STALL_MS) {
      return finish('fail', job.sawActivity ? 'node stalled (no activity)' : 'node never started responding');
    }
  }

  // ── dispatch from the router ────────────────────────────────────────────
  async function onDispatch(text, resumed) {
    if (job) { clearInterval(job.timer); job = null; }
    const started = await ensureStarted();
    if (!started) return emit({ type: 'fail', reason: 'agent could not be started (log in first?)' });

    const baseline = snapshotTurns().length;
    job = {
      baseline, seen: new Set(), sawActivity: false, resumed: !!resumed,
      lastActiveAt: Date.now(), lastProgressAt: Date.now(), timer: null,
    };
    // Mark everything already on screen as seen so only new turns are recorded.
    for (const t of snapshotTurns()) job.seen.add(`${t.role}:${t.text.length}:${t.text.slice(0, 80)}`);

    try {
      await P.typeAndSend(text);
    } catch (e) {
      const reason = `send failed: ${e && e.message ? e.message : e}`;
      job = null;
      return emit({ type: 'fail', reason });
    }
    job.timer = setInterval(watch, POLL_MS);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'rg-dispatch' && typeof msg.text === 'string') {
      onDispatch(msg.text, msg.resumed);
    }
  });

  // Tell the host the driver is alive (the UI still decides when a node is 'ready').
  emit({ type: 'driver-loaded' });
})();
