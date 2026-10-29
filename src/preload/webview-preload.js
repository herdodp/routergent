// SPDX-License-Identifier: GPL-3.0-or-later
// webview-preload.js - runs inside every node webview BEFORE the page loads.
// Provides a minimal `chrome.*` shim so the unmodified snapgent extension
// content scripts work in Electron. The node is identified by the main
// process from the sender's webContents, so no node id is needed here.
// Requires the <webview> to be created with contextIsolation disabled.

'use strict';

const { ipcRenderer } = require('electron');

const listeners = new Set();
const runtime = {
  id: 'routergent-shim',
  lastError: undefined,
  getURL: (p) => String(p || ''),
  sendMessage(msg, cb) {
    const done = typeof cb === 'function' ? cb : () => {};
    ipcRenderer
      .invoke('rg:bg', msg)
      .then((resp) => {
        runtime.lastError = undefined;
        done(resp);
      })
      .catch((e) => {
        runtime.lastError = { message: String((e && e.message) || e) };
        done(undefined);
        runtime.lastError = undefined;
      });
    return undefined;
  },
  onMessage: {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
  },
};

const storage = {
  local: {
    get(keys, cb) {
      ipcRenderer.invoke('rg:storage-get', keys).then((r) => cb && cb(r || {}), () => cb && cb({}));
    },
    set(items, cb) {
      ipcRenderer.invoke('rg:storage-set', items).then(() => cb && cb(), () => cb && cb());
    },
    remove(keys, cb) {
      ipcRenderer.invoke('rg:storage-remove', keys).then(() => cb && cb(), () => cb && cb());
    },
  },
};

// Node webviews are hidden by the host UI whenever another node is selected,
// but they must keep working in the background. The extension parks its agent
// loop while document.hidden is true, so always report the page as visible.
try {
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.hasFocus = () => true;
} catch (e) {
  console.warn('[routergent] visibility override failed', e);
}

window.chrome = Object.assign(window.chrome || {}, { runtime, storage });

// Channel for the RouterGent node driver (src/driver/node-driver.js) to report
// progress/completion/failure to the router in the main process.
window.__rgNode = {
  emit: (ev) => ipcRenderer.send('rg:node-event', ev),
};

// Status pushes from the main process (same shape as background.js statusObj()).
ipcRenderer.on('rg:push', (_e, msg) => {
  for (const fn of [...listeners]) {
    try {
      fn(msg, {}, () => {});
    } catch (e) {
      console.warn('[routergent] listener error', e);
    }
  }
});

// Lets the host app know which provider page finished loading in this node.
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.sendToHost('rg:page', { href: location.href, title: document.title });
});
