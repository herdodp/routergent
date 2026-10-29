// SPDX-License-Identifier: GPL-3.0-or-later
// renderer.js - RouterGent window UI: node list, one <webview> per node,
// parent chatbox, mode selector and event log. Talks to the main process
// only through window.routergent (see preload/app-preload.js).

'use strict';

(() => {
  const rg = window.routergent;

  // Keep in sync with AI_SITES in snapgent-extension/core/main.js.
  const PROVIDERS = [
    { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
    { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' },
    { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
    { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.ai/' },
    { id: 'glm', name: 'GLM', url: 'https://chat.z.ai/' },
    { id: 'qwen', name: 'Qwen', url: 'https://chat.qwen.ai/' },
    { id: 'arena', name: 'Arena', url: 'https://arena.ai/text/direct' },
    { id: 'meta', name: 'Meta AI', url: 'https://www.meta.ai/' },
    { id: 'ptero', name: 'Ptero', url: 'https://ptero.pro/' },
    { id: 'grok', name: 'Grok', url: 'https://grok.com/' },
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    provider: $('provider'), addNode: $('addNode'), nodes: $('nodes'), mcp: $('mcp'),
    stage: $('stage'), empty: $('empty'), log: $('log'), modeSel: $('modeSel'),
    prompt: $('prompt'), send: $('send'), chat: $('chat'),
  };

  const views = new Map(); // node id -> <webview>
  let nodes = [];
  let mode = 'auto';
  let selectedId = null;

  for (const p of PROVIDERS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    els.provider.appendChild(o);
  }

  // ── log ────────────────────────────────────────────────────────────────
  function log(text, cls) {
    els.log.style.display = 'block';
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    els.log.appendChild(d);
    while (els.log.children.length > 200) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  }

  // ── parent conversation (prompt, node replies, tool results) ───────────
  function renderHistory(history) {
    els.chat.textContent = '';
    els.chat.style.display = history.length ? 'block' : 'none';
    for (const h of history) {
      const box = document.createElement('div');
      box.className = `msg ${h.role}`;
      const who = document.createElement('div');
      who.className = 'who';
      const label = h.role === 'user' ? 'You' : h.role === 'tool-result' ? 'Tool result' : 'Assistant';
      who.textContent = h.node ? `${label} · ${labelOf(h.node)}` : label;
      const body = document.createElement('div');
      body.textContent = h.text;
      box.append(who, body);
      els.chat.appendChild(box);
    }
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  // ── webviews ───────────────────────────────────────────────────────────
  function ensureView(node) {
    if (views.has(node.id)) return views.get(node.id);
    const p = PROVIDERS.find((x) => x.id === node.provider) || PROVIDERS[0];
    const wv = document.createElement('webview');
    // Separate persistent partition per node = separate login per account.
    wv.setAttribute('partition', `persist:rg-${node.id}`);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', p.url);
    wv.classList.add('hidden');
    wv.addEventListener('dom-ready', function onFirst() {
      wv.removeEventListener('dom-ready', onFirst);
      try {
        rg.registerWebview(node.id, wv.getWebContentsId());
      } catch (e) {
        log(`Could not attach ${node.label}: ${e.message}`, 'err');
      }
    });
    els.stage.appendChild(wv);
    views.set(node.id, wv);
    return wv;
  }

  function dropView(id) {
    const wv = views.get(id);
    if (wv) wv.remove();
    views.delete(id);
  }

  function showSelected() {
    for (const [id, wv] of views) wv.classList.toggle('hidden', id !== selectedId);
    els.empty.style.display = selectedId && views.has(selectedId) ? 'none' : 'flex';
  }

  // ── node list ──────────────────────────────────────────────────────────
  function renderNodes() {
    const ids = new Set(nodes.map((n) => n.id));
    for (const id of [...views.keys()]) if (!ids.has(id)) dropView(id);
    for (const n of nodes) ensureView(n);
    if (!selectedId || !ids.has(selectedId)) selectedId = nodes.length ? nodes[0].id : null;

    els.nodes.textContent = '';
    for (const n of nodes) {
      const card = document.createElement('div');
      card.className = 'node' + (n.id === selectedId ? ' sel' : '');
      card.addEventListener('click', () => { selectedId = n.id; renderNodes(); });

      const top = document.createElement('div');
      top.className = 'top';
      const dot = document.createElement('span');
      dot.className = `dot ${n.status}`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = n.label;
      top.append(dot, name);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${n.provider} · ${n.status}` + (n.lastError ? ` · ${n.lastError}` : '');

      const acts = document.createElement('div');
      acts.className = 'acts';
      const start = document.createElement('button');
      start.textContent = 'Start agent';
      start.title = 'Mark this node ready after you logged in';
      start.disabled = n.status !== 'loading' && n.status !== 'down';
      start.addEventListener('click', (e) => {
        e.stopPropagation();
        rg.markReady(n.id);
      });
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        rg.removeNode(n.id);
      });
      acts.append(start, rm);

      card.append(top, meta, acts);
      els.nodes.appendChild(card);
    }
    renderModeOptions();
    showSelected();
  }

  function renderModeOptions() {
    els.modeSel.textContent = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = 'Auto (random)';
    els.modeSel.appendChild(auto);
    for (const n of nodes) {
      const o = document.createElement('option');
      o.value = n.id;
      o.textContent = `Pin: ${n.label}`;
      els.modeSel.appendChild(o);
    }
    els.modeSel.value = nodes.some((n) => n.id === mode) ? mode : 'auto';
  }

  // ── actions ────────────────────────────────────────────────────────────
  els.addNode.addEventListener('click', async () => {
    const p = PROVIDERS.find((x) => x.id === els.provider.value) || PROVIDERS[0];
    const node = await rg.addNode(p.id, `${p.name} #${nodes.filter((n) => n.provider === p.id).length + 1}`);
    selectedId = node.id;
    log(`Node added: ${node.label}. Log in, then press Start agent.`);
  });

  els.modeSel.addEventListener('change', async () => {
    mode = await rg.setMode(els.modeSel.value);
  });

  async function sendPrompt() {
    const text = els.prompt.value.trim();
    if (!text) return;
    const ok = await rg.submit(text);
    if (ok) {
      els.prompt.value = '';
      log('Prompt sent.');
    }
    // On failure the router emits an 'error' event, shown in the log.
  }
  els.send.addEventListener('click', sendPrompt);
  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  const labelOf = (id) => (nodes.find((n) => n.id === id) || { label: id }).label;

  // ── events from the main process ───────────────────────────────────────
  rg.onEvent((ev) => {
    switch (ev.type) {
      case 'nodes':
        nodes = ev.nodes;
        renderNodes();
        break;
      case 'mode':
        mode = ev.mode;
        renderModeOptions();
        break;
      case 'history':
        renderHistory(ev.history || []);
        break;
      case 'dispatch':
        log(ev.resumed
          ? `Resumed on ${labelOf(ev.nodeId)} using handoff file.`
          : `Task running on ${labelOf(ev.nodeId)}.`, ev.resumed ? 'fo' : '');
        if (ev.nodeId && views.has(ev.nodeId)) { selectedId = ev.nodeId; renderNodes(); }
        break;
      case 'failover':
        log(`Failover ${labelOf(ev.from)} -> ${labelOf(ev.to)}: ${ev.reason}`, 'fo');
        if (ev.handoffPath) log(`Handoff saved: ${ev.handoffPath}`, 'fo');
        break;
      case 'done':
        log(`Task finished on ${labelOf(ev.nodeId)}.`, 'ok');
        break;
      case 'error':
        log(ev.message, 'err');
        break;
      case 'mcp': {
        const s = ev.status || {};
        els.mcp.textContent = `MCP: ${s.mcp_alive ? 'online' : 'offline'} · ${(s.tools || []).length} tools`;
        break;
      }
      default:
        break;
    }
  });

  rg.info().then((i) => {
    if (i && i.mcp) els.mcp.textContent = `MCP: ${i.mcp.mcp_alive ? 'online' : 'offline'} · ${(i.mcp.tools || []).length} tools`;
  });
  rg.listNodes().then((list) => { nodes = list; renderNodes(); });
})();
