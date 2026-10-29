// SPDX-License-Identifier: GPL-3.0-or-later
// mcp-hub.js - Node port of bridge.py's MCP side. Spawns MCP servers over stdio
// JSON-RPC, keeps a tool catalog, and runs tool calls for ALL webview nodes
// (one shared hub, so the bridge scales with the number of nodes for free).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = '2024-11-05';
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

class MCPServer extends EventEmitter {
  constructor(serverId, config, cwd) {
    super();
    this.serverId = serverId;
    this.config = config;
    this.cwd = cwd;
    this.proc = null;
    this.tools = [];
    this.ready = false;
    this.error = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.starting = null;
  }

  get alive() {
    return !!(this.proc && this.proc.exitCode === null && !this.proc.killed && this.ready);
  }

  start() {
    if (this.alive) return Promise.resolve(true);
    if (!this.starting) {
      this.starting = this._start().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async _start() {
    this.stop();
    const { command, args = [], env = {} } = this.config;
    if (typeof command !== 'string' || !command.trim()) {
      this.error = 'MCP server command is missing.';
      return false;
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
      this.error = 'MCP server args must be an array of strings.';
      return false;
    }
    try {
      this.proc = spawn(command, args, {
        cwd: this.cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.error = String(e.message || e);
      return false;
    }
    const proc = this.proc;
    proc.on('error', (e) => { this.error = String(e.message || e); this._dead(proc); });
    proc.on('exit', () => this._dead(proc));
    proc.stdout.on('data', (d) => this._onData(d));
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    try {
      await this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'routergent', version: '0.1.0' },
      }, 12000);
      this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      const result = await this._request('tools/list', {}, 20000);
      const raw = result && Array.isArray(result.tools) ? result.tools : [];
      this.tools = raw.filter((t) => t && typeof t.name === 'string');
      this.ready = true;
      this.error = null;
      return true;
    } catch (e) {
      this.error = String(e.message || e);
      this.stop();
      return false;
    }
  }

  _dead(proc) {
    if (this.proc !== proc) return;
    this.ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.serverId} MCP server disconnected.`));
    }
    this.pending.clear();
    this.emit('down', this.serverId);
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.tools = [];
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.serverId} MCP server stopped.`));
    }
    this.pending.clear();
    this.buf = '';
    if (proc && proc.exitCode === null) {
      try { proc.stdin.end(); } catch {}
      const t = setTimeout(() => { try { proc.kill(); } catch {} }, 2000);
      t.unref();
    }
  }

  _send(payload) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.stdin.writable) {
      throw new Error(`${this.serverId} MCP server is offline.`);
    }
    proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  _request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { kind: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const d = msg.error;
        p.reject(new Error(typeof d === 'object' ? String(d.message || JSON.stringify(d)) : String(d)));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  async callTool(name, args, timeoutMs) {
    if (!this.alive) throw new Error(this.error || `${this.serverId} MCP server is offline.`);
    const r = await this._request('tools/call', { name, arguments: args }, timeoutMs);
    return r && typeof r === 'object' ? r : { content: [{ type: 'text', text: String(r) }] };
  }
}

class McpHub extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.configPath  path to a config.json with mcpServers
   * @param {string[]} [opts.only]    server ids to load (default ['vscode'])
   * @param {string} [opts.cwd]
   * @param {number} [opts.monitorMs]
   */
  constructor(opts = {}) {
    super();
    this.configPath = opts.configPath;
    this.only = opts.only || ['vscode'];
    this.cwd = opts.cwd || (opts.configPath ? path.dirname(opts.configPath) : process.cwd());
    this.monitorMs = opts.monitorMs ?? 5000;
    // Optional per-server overrides, e.g. { vscode: { command: '<bundled exe>' } },
    // so a packaged build does not depend on absolute paths from config.json.
    this.overrides = opts.overrides || {};
    this.servers = new Map();
    this.catalog = [];
    this.timer = null;
  }

  loadConfig() {
    if (!this.configPath || !fs.existsSync(this.configPath)) {
      // No config.json (packaged build): overrides alone define the servers.
      const out = {};
      for (const [id, o] of Object.entries(this.overrides)) {
        if (ID_RE.test(id) && this.only.includes(id)) out[id] = { args: [], env: {}, ...o };
      }
      return out;
    }
    const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    const servers = cfg && cfg.mcpServers;
    if (!servers || typeof servers !== 'object') throw new Error('config.json must contain an object named mcpServers.');
    const out = {};
    for (const [id, v] of Object.entries(servers)) {
      if (ID_RE.test(id) && v && typeof v === 'object' && this.only.includes(id)) {
        out[id] = this.overrides[id] ? { ...v, ...this.overrides[id] } : v;
      }
    }
    return out;
  }

  async start() {
    const cfg = this.loadConfig();
    for (const [id, c] of Object.entries(cfg)) this.servers.set(id, new MCPServer(id, c, this.cwd));
    await Promise.all([...this.servers.values()].map((s) => s.start()));
    this._rebuildCatalog();
    this.timer = setInterval(() => this._monitor(), this.monitorMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    for (const s of this.servers.values()) s.stop();
    this.servers.clear();
    this.catalog = [];
  }

  async _monitor() {
    let changed = false;
    for (const s of this.servers.values()) {
      if (!s.alive) { await s.start(); changed = true; }
    }
    if (changed) {
      this._rebuildCatalog();
      this.emit('status', this.status());
    }
  }

  _rebuildCatalog() {
    const entries = [];
    for (const s of this.servers.values()) if (s.alive) for (const t of s.tools) entries.push([s.serverId, t]);
    const counts = {};
    for (const [, t] of entries) counts[t.name] = (counts[t.name] || 0) + 1;
    this.catalog = entries.map(([sid, t]) => ({
      name: counts[t.name] > 1 ? `${sid}/${t.name}` : t.name,
      server: sid,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  status() {
    return {
      mcp_alive: [...this.servers.values()].some((s) => s.alive),
      tools: this.catalog,
      servers: [...this.servers.values()].map((s) => ({
        id: s.serverId, alive: s.alive, tools: s.alive ? s.tools.length : 0,
      })),
    };
  }

  resolveTool(name) {
    if (name.includes('/')) {
      const i = name.indexOf('/');
      const s = this.servers.get(name.slice(0, i));
      const bare = name.slice(i + 1);
      if (s && s.alive && s.tools.some((t) => t.name === bare)) return { server: s, tool: bare };
    }
    const matches = [];
    for (const s of this.servers.values()) {
      if (s.alive && s.tools.some((t) => t.name === name)) matches.push(s);
    }
    return matches.length === 1 ? { server: matches[0], tool: name } : null;
  }

  /** Same result shape the extension expects: {ok, text, images} or {ok:false, kind, error}. */
  async callTool(name, args = {}, timeoutMs = 120000) {
    if (typeof name !== 'string' || !args || typeof args !== 'object') {
      return { ok: false, error: 'Invalid tool call.' };
    }
    const r = this.resolveTool(name);
    if (!r) return { ok: false, kind: 'unknown_tool', error: `Unknown or unavailable MCP tool: ${name}` };
    const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 120000, 300000));
    try {
      const result = await r.server.callTool(r.tool, args, timeout);
      const texts = [];
      const images = [];
      for (const item of result.content || []) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
        else if (item.type === 'image' && typeof item.data === 'string') {
          images.push({ data: item.data, mimeType: item.mimeType || 'image/png' });
        }
      }
      if (!texts.length && result.structuredContent != null) texts.push(JSON.stringify(result.structuredContent));
      const text = texts.join('\n');
      if (result.isError) return { ok: false, error: text || 'MCP tool failed.' };
      return { ok: true, text, images };
    } catch (e) {
      return { ok: false, kind: e.kind === 'timeout' ? 'timeout' : 'tool_error', error: String(e.message || e) };
    }
  }
}

module.exports = { McpHub, MCPServer };
