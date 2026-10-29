// SPDX-License-Identifier: GPL-3.0-or-later
// router.js - pure routing core (no Electron). Tracks webview nodes, picks one
// per task, fails over to another node when it breaks, and writes a handoff txt
// so the replacement node continues the work instead of starting over.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const STATUS = Object.freeze({
  LOADING: 'loading', // webview open, agent not started yet
  READY: 'ready',     // logged in + agent started, can take a task
  BUSY: 'busy',       // currently running the task
  DOWN: 'down',       // failed / quota exhausted / disconnected
});

class Router extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.handoffDir  where handoff txt files are written
   * @param {number} [opts.maxFailovers] max node switches for one task
   * @param {number} [opts.cooldownMs]  how long a DOWN node stays excluded
   * @param {() => number} [opts.random] injectable RNG for tests
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    super();
    this.handoffDir = opts.handoffDir || path.join(process.cwd(), 'handoff');
    this.maxFailovers = opts.maxFailovers ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 5 * 60 * 1000;
    this.random = opts.random || Math.random;
    this.now = opts.now || Date.now;
    this.nodes = new Map();
    this.task = null;       // current task, or null
    this.history = [];      // conversation of the current task
    this.nextNodeNo = 1;
    this.mode = 'auto';     // 'auto' (random among ready) or a node id (pinned)
  }

  // ── nodes ──────────────────────────────────────────────────────────────
  addNode(provider, label) {
    const id = `node-${this.nextNodeNo++}`;
    const node = {
      id,
      provider: provider || 'unknown',
      label: label || `${provider || 'node'} ${this.nextNodeNo - 1}`,
      status: STATUS.LOADING,
      failures: 0,
      lastError: null,
      downAt: null,
    };
    this.nodes.set(id, node);
    this.emit('nodes', this.listNodes());
    return node;
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return false;
    const wasActive = this.task && this.task.nodeId === id;
    this.nodes.delete(id);
    if (this.mode === id) this.mode = 'auto';
    this.emit('nodes', this.listNodes());
    if (wasActive) this._failover(id, 'node removed');
    return true;
  }

  listNodes() {
    return [...this.nodes.values()].map((n) => ({ ...n }));
  }

  setStatus(id, status, error) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.status = status;
    if (status === STATUS.DOWN) {
      node.failures += 1;
      node.lastError = error || node.lastError;
      node.downAt = this.now();
    } else if (status === STATUS.READY) {
      node.lastError = null;
      node.downAt = null;
    }
    this.emit('nodes', this.listNodes());
  }

  /** Called when the agent in a webview has been started (user pressed Start). */
  markReady(id) {
    this.setStatus(id, STATUS.READY);
  }

  setMode(mode) {
    this.mode = mode === 'auto' || this.nodes.has(mode) ? mode : 'auto';
    this.emit('mode', this.mode);
  }

  // ── selection ──────────────────────────────────────────────────────────
  _recoverCooledNodes() {
    const t = this.now();
    for (const n of this.nodes.values()) {
      if (n.status === STATUS.DOWN && n.downAt != null && t - n.downAt >= this.cooldownMs) {
        // Give it another chance; it still must be confirmed ready by the webview.
        n.status = STATUS.READY;
        n.downAt = null;
      }
    }
  }

  _candidates(excludeIds = []) {
    this._recoverCooledNodes();
    return [...this.nodes.values()].filter(
      (n) => n.status === STATUS.READY && !excludeIds.includes(n.id)
    );
  }

  pickNode(excludeIds = []) {
    if (this.mode !== 'auto') {
      const pinned = this.nodes.get(this.mode);
      if (pinned && pinned.status === STATUS.READY && !excludeIds.includes(pinned.id)) return pinned;
      // Pinned node unavailable: fall back to auto so the task still continues.
    }
    const list = this._candidates(excludeIds);
    if (!list.length) return null;
    return list[Math.floor(this.random() * list.length)];
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  /** Start a task from the parent prompt. Emits 'dispatch' or 'error'. */
  submit(prompt) {
    if (this.task) {
      this.emit('error', new Error('A task is already running.'));
      return false;
    }
    const node = this.pickNode();
    if (!node) {
      this.emit('error', new Error('No ready node. Login and start the agent in at least one webview.'));
      return false;
    }
    this.history = [{ role: 'user', text: prompt, ts: this.now(), node: null }];
    this.task = { id: `task-${this.now()}`, nodeId: node.id, tried: [node.id], failovers: 0, prompt };
    this.setStatus(node.id, STATUS.BUSY);
    this.emit('history', this.history.slice());
    this.emit('dispatch', { nodeId: node.id, text: prompt, handoffPath: null, resumed: false });
    return true;
  }

  /** A node reports a piece of the conversation (assistant reply, tool result...). */
  record(nodeId, role, text) {
    if (!this.task || !text) return;
    this.history.push({ role, text: String(text), ts: this.now(), node: nodeId });
    this.emit('history', this.history.slice());
  }

  /** The node finished the task normally. */
  complete(nodeId) {
    if (!this.task || this.task.nodeId !== nodeId) return;
    this.setStatus(nodeId, STATUS.READY);
    this.task = null;
    this.emit('done', { nodeId });
  }

  /** The node broke (quota, error, disconnect). Triggers failover. */
  fail(nodeId, reason) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.setStatus(nodeId, STATUS.DOWN, reason);
    if (this.task && this.task.nodeId === nodeId) this._failover(nodeId, reason);
  }

  _failover(fromId, reason) {
    const task = this.task;
    if (!task) return;
    if (task.failovers >= this.maxFailovers) {
      this.task = null;
      this.emit('error', new Error(`Gave up after ${task.failovers} failovers: ${reason}`));
      return;
    }
    const next = this.pickNode(task.tried);
    if (!next) {
      this.task = null;
      this.emit('error', new Error(`No replacement node available (${reason}).`));
      return;
    }
    const handoffPath = this.writeHandoff(fromId, next.id, reason);
    task.failovers += 1;
    task.nodeId = next.id;
    task.tried.push(next.id);
    this.setStatus(next.id, STATUS.BUSY);
    this.emit('failover', { from: fromId, to: next.id, reason, handoffPath });
    this.emit('dispatch', {
      nodeId: next.id,
      text: this.buildResumePrompt(handoffPath),
      handoffPath,
      resumed: true,
    });
  }

  // ── handoff ────────────────────────────────────────────────────────────
  renderHandoff(fromId, toId, reason) {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    const lines = [
      'ROUTERGENT HANDOFF',
      `time: ${new Date(this.now()).toISOString()}`,
      `from: ${from ? from.label : fromId}`,
      `to: ${to ? to.label : toId}`,
      `reason: ${reason}`,
      '',
      '=== ORIGINAL REQUEST ===',
      this.task ? this.task.prompt : '',
      '',
      '=== PROGRESS SO FAR ===',
    ];
    for (const h of this.history.slice(1)) {
      lines.push(`[${h.role}${h.node ? ' @' + h.node : ''}]`);
      lines.push(h.text);
      lines.push('');
    }
    return lines.join('\n');
  }

  writeHandoff(fromId, toId, reason) {
    fs.mkdirSync(this.handoffDir, { recursive: true });
    const file = path.join(this.handoffDir, `${this.task.id}-${this.task.failovers + 1}.txt`);
    fs.writeFileSync(file, this.renderHandoff(fromId, toId, reason), 'utf8');
    return file;
  }

  buildResumePrompt(handoffPath) {
    const body = handoffPath ? fs.readFileSync(handoffPath, 'utf8') : '';
    return (
      'The previous assistant stopped midway. Continue the same task from where it left off. ' +
      'Do NOT redo completed work; verify the current state of the workspace first, then proceed.\n\n' +
      body
    );
  }
}

module.exports = { Router, STATUS };
