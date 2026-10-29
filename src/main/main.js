// SPDX-License-Identifier: GPL-3.0-or-later
// main.js - Electron main process. Wires together: one shared McpHub (bridge),
// one Router (node selection + failover + handoff), and N <webview> nodes.
// Each webview gets the unmodified snapgent extension content scripts plus a
// chrome.* shim (see ../preload/webview-preload.js).

'use strict';

const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const { Router } = require('./router');
const { McpHub } = require('./mcp-hub');

const APP_ROOT = path.resolve(__dirname, '..', '..'); // routergent/
// Overridable so a packaged build can ship its own copies (standalone).
// Packaged build: electron-builder copies these into <resources>/ (extraResources).
// Dev run: they live next to routergent/ in the repo.
const RES_DIR = app.isPackaged ? process.resourcesPath : null;
const EXT_DIR = process.env.ROUTERGENT_EXTENSION_DIR ||
  (RES_DIR ? path.join(RES_DIR, 'snapgent-extension') : path.resolve(APP_ROOT, '..', 'snapgent-extension'));
const CONFIG_PATH = process.env.ROUTERGENT_CONFIG ||
  [
    RES_DIR && path.join(RES_DIR, 'config.json'),
    path.join(APP_ROOT, 'config.json'),
    path.resolve(APP_ROOT, '..', 'config.json'),
  ].filter(Boolean).find((p) => fs.existsSync(p));
const MCP_TARGETS = (process.env.ROUTERGENT_MCP || 'vscode').split(',').map((s) => s.trim()).filter(Boolean);

let mainWindow = null;
let router = null;
let hub = null;
const wcToNode = new Map(); // webContents.id -> node id
const nodeToWc = new Map(); // node id -> webContents.id

// ── tiny persisted storage backing the chrome.storage.local shim ──────────
const storeFile = () => path.join(app.getPath('userData'), 'ext-storage.json');
let store = {};
function loadStore() {
  try { store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) || {}; } catch { store = {}; }
}
function saveStore() {
  try { fs.writeFileSync(storeFile(), JSON.stringify(store), 'utf8'); } catch {}
}

// ── content script injection (driven by the extension's own manifest) ─────
function matchRegex(pattern) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}

function contentScriptsFor(url) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')); } catch { return []; }
  return (manifest.content_scripts || []).filter((cs) => (cs.matches || []).some((m) => matchRegex(m).test(url)));
}

async function injectInto(wc) {
  const url = wc.getURL();
  for (const cs of contentScriptsFor(url)) {
    for (const css of cs.css || []) {
      try { await wc.insertCSS(fs.readFileSync(path.join(EXT_DIR, css), 'utf8')); } catch {}
    }
    for (const js of cs.js || []) {
      try {
        const code = fs.readFileSync(path.join(EXT_DIR, js), 'utf8');
        await wc.executeJavaScript(code, true);
      } catch (e) {
        console.warn(`[routergent] inject ${js} failed:`, e.message);
      }
    }
  }
  await injectDriver(wc);
}

// The node driver must run AFTER the extension scripts (it needs ZSProvider).
// It is a no-op on pages where no provider script was injected.
async function injectDriver(wc) {
  try {
    const code = fs.readFileSync(path.join(APP_ROOT, 'src', 'driver', 'node-driver.js'), 'utf8');
    await wc.executeJavaScript(code, true);
  } catch (e) {
    console.warn('[routergent] inject node-driver failed:', e.message);
  }
}

// ── messages the extension sends to its background worker ─────────────────
function statusObj() {
  const s = hub ? hub.status() : { mcp_alive: false, tools: [], servers: [] };
  return {
    type: 'zs-status', connected: true, mcpAlive: s.mcp_alive,
    studio: null, studioApp: null, studioProc: null,
    tools: s.tools.length, servers: s.servers,
  };
}

async function handleBg(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad message' };
  switch (msg.type) {
    case 'status': return statusObj();
    case 'list_tools': return { ok: true, tools: hub.catalog };
    case 'call_tool': return hub.callTool(msg.name, msg.arguments || {}, msg.timeout);
    case 'restart_mcp': {
      hub.stop();
      await hub.start();
      return { ok: true, alive: hub.status().mcp_alive };
    }
    case 'reconnect': return { ok: true };
    case 'add_server':
    case 'remove_server':
      return { ok: false, error: 'Server changes are not supported in RouterGent yet; edit config.json.' };
    default: return { ok: false, error: 'unknown message' };
  }
}

function pushToAllNodes(msg) {
  for (const id of wcToNode.keys()) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send('rg:push', msg);
  }
}

function toRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ── router events -> renderer + nodes ─────────────────────────────────────
function wireRouter() {
  router.on('nodes', (nodes) => toRenderer('rg:event', { type: 'nodes', nodes }));
  router.on('mode', (mode) => toRenderer('rg:event', { type: 'mode', mode }));
  router.on('history', (history) => toRenderer('rg:event', { type: 'history', history }));
  router.on('done', (d) => toRenderer('rg:event', { type: 'done', ...d }));
  router.on('error', (e) => toRenderer('rg:event', { type: 'error', message: e.message }));
  router.on('failover', (f) => toRenderer('rg:event', { type: 'failover', ...f }));
  router.on('dispatch', (d) => {
    toRenderer('rg:event', { type: 'dispatch', nodeId: d.nodeId, resumed: d.resumed, handoffPath: d.handoffPath });
    const id = nodeToWc.get(d.nodeId);
    const wc = id != null ? webContents.fromId(id) : null;
    if (wc && !wc.isDestroyed()) wc.send('rg:push', { type: 'rg-dispatch', text: d.text, resumed: d.resumed });
    else router.fail(d.nodeId, 'webview not attached');
  });
}

// ── IPC ───────────────────────────────────────────────────────────────────
function wireIpc() {
  // extension shim (sender is a node webview)
  ipcMain.handle('rg:bg', (_e, msg) => handleBg(msg));
  ipcMain.handle('rg:storage-get', (_e, keys) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
    const out = typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {};
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  });
  ipcMain.handle('rg:storage-set', (_e, items) => { Object.assign(store, items || {}); saveStore(); });
  ipcMain.handle('rg:storage-remove', (_e, keys) => {
    for (const k of [].concat(keys || [])) delete store[k];
    saveStore();
  });

  // events reported by a node's driver script (task finished / broke / progress)
  ipcMain.on('rg:node-event', (e, ev) => {
    const nodeId = wcToNode.get(e.sender.id);
    if (!nodeId || !ev) return;
    if (ev.type === 'record') router.record(nodeId, ev.role || 'assistant', ev.text);
    else if (ev.type === 'complete') router.complete(nodeId);
    else if (ev.type === 'fail') router.fail(nodeId, ev.reason || 'node failed');
    else if (ev.type === 'ready') router.markReady(nodeId);
  });

  // app window (chatbox + node bar)
  ipcMain.handle('rg:add-node', (_e, provider, label) => router.addNode(provider, label));
  ipcMain.handle('rg:remove-node', (_e, id) => {
    const wcId = nodeToWc.get(id);
    if (wcId != null) wcToNode.delete(wcId);
    nodeToWc.delete(id);
    return router.removeNode(id);
  });
  ipcMain.handle('rg:register-webview', (_e, nodeId, wcId) => {
    if (!router.nodes.has(nodeId)) return false;
    wcToNode.set(wcId, nodeId);
    nodeToWc.set(nodeId, wcId);
    const wc = webContents.fromId(wcId);
    if (wc) {
      const run = () => injectInto(wc).then(() => wc.send('rg:push', statusObj()));
      wc.on('dom-ready', run);
      wc.on('destroyed', () => { wcToNode.delete(wcId); nodeToWc.delete(nodeId); });
      if (!wc.isLoading() && wc.getURL()) run();
    }
    return true;
  });
  ipcMain.handle('rg:mark-ready', (_e, id) => { router.markReady(id); return true; });
  ipcMain.handle('rg:set-mode', (_e, mode) => { router.setMode(mode); return router.mode; });
  ipcMain.handle('rg:submit', (_e, prompt) => router.submit(String(prompt || '')));
  ipcMain.handle('rg:list-nodes', () => router.listNodes());
  ipcMain.handle('rg:info', () => ({
    extensionDir: EXT_DIR, configPath: CONFIG_PATH || null, targets: MCP_TARGETS,
    mcp: hub ? hub.status() : null,
  }));
}

// ── window ────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500, height: 920, backgroundColor: '#111111', title: 'RouterGent',
    webPreferences: {
      preload: path.join(APP_ROOT, 'src', 'preload', 'app-preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
    },
  });

  // Lock down every <webview>: isolated persistent session per node, our shim
  // preload, no node integration, never a caller-supplied preload.
  mainWindow.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = path.join(APP_ROOT, 'src', 'preload', 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = false; // content scripts share the page world
    webPreferences.sandbox = false;
    if (!String(params.partition || '').startsWith('persist:rg-')) params.partition = 'persist:rg-default';
  });

  mainWindow.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  loadStore();
  router = new Router({ handoffDir: path.join(app.getPath('userData'), 'handoff') });
  // Packaged: do not trust absolute paths baked into config.json; use the exe
  // bundled next to the app (see build.extraResources in package.json).
  const overrides = RES_DIR ? { vscode: { command: path.join(RES_DIR, 'vscode_mcp.exe') } } : {};
  hub = new McpHub({ configPath: CONFIG_PATH, only: MCP_TARGETS, overrides, cwd: RES_DIR || undefined });
  wireRouter();
  wireIpc();
  createWindow();
  hub.on('status', () => pushToAllNodes(statusObj()));
  try { await hub.start(); } catch (e) { console.warn('[routergent] MCP start failed:', e.message); }
  toRenderer('rg:event', { type: 'mcp', status: hub.status() });
  pushToAllNodes(statusObj());
});

app.on('before-quit', () => { if (hub) hub.stop(); });
app.on('window-all-closed', () => app.quit());
