// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpHub } = require('../src/main/mcp-hub');

function writeConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-hub-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

test('without config.json, overrides define the server', () => {
  const hub = new McpHub({ only: ['vscode'], overrides: { vscode: { command: 'bundled.exe' } } });
  const cfg = hub.loadConfig();
  assert.deepStrictEqual(Object.keys(cfg), ['vscode']);
  assert.strictEqual(cfg.vscode.command, 'bundled.exe');
  assert.deepStrictEqual(cfg.vscode.args, []);
});

test('override replaces command from config but keeps other fields', () => {
  const configPath = writeConfig({
    mcpServers: { vscode: { command: 'C:\\old\\vscode_mcp.exe', args: ['--x'], env: { A: '1' } } },
  });
  const hub = new McpHub({ configPath, only: ['vscode'], overrides: { vscode: { command: 'new.exe' } } });
  const cfg = hub.loadConfig();
  assert.strictEqual(cfg.vscode.command, 'new.exe');
  assert.deepStrictEqual(cfg.vscode.args, ['--x']);
  assert.deepStrictEqual(cfg.vscode.env, { A: '1' });
});

test('servers outside `only` are not loaded', () => {
  const configPath = writeConfig({
    mcpServers: { vscode: { command: 'a' }, roblox: { command: 'b' } },
  });
  const hub = new McpHub({ configPath, only: ['vscode'] });
  assert.deepStrictEqual(Object.keys(hub.loadConfig()), ['vscode']);
});

test('overrides for ids outside `only` are ignored without config', () => {
  const hub = new McpHub({ only: ['vscode'], overrides: { roblox: { command: 'x' } } });
  assert.deepStrictEqual(hub.loadConfig(), {});
});
