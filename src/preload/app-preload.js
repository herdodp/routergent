// SPDX-License-Identifier: GPL-3.0-or-later
// app-preload.js - exposes a small, explicit API to the RouterGent window
// (parent chatbox + node bar). Context isolation stays ON for this window.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('routergent', {
  // nodes
  addNode: (provider, label) => ipcRenderer.invoke('rg:add-node', provider, label),
  removeNode: (id) => ipcRenderer.invoke('rg:remove-node', id),
  listNodes: () => ipcRenderer.invoke('rg:list-nodes'),
  registerWebview: (nodeId, webContentsId) => ipcRenderer.invoke('rg:register-webview', nodeId, webContentsId),
  markReady: (nodeId) => ipcRenderer.invoke('rg:mark-ready', nodeId),

  // routing
  setMode: (mode) => ipcRenderer.invoke('rg:set-mode', mode), // 'auto' or a node id
  submit: (prompt) => ipcRenderer.invoke('rg:submit', prompt),
  info: () => ipcRenderer.invoke('rg:info'),

  // events from the main process (nodes, history, dispatch, failover, done, error, mcp)
  onEvent: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('rg:event', handler);
    return () => ipcRenderer.removeListener('rg:event', handler);
  },
});
