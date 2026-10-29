// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Router, STATUS } = require('../src/main/router');

function makeRouter(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routergent-'));
  return new Router({ handoffDir: dir, random: () => 0, ...extra });
}

function readyNodes(r, n) {
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const node = r.addNode('claude', `acc${i + 1}`);
    r.markReady(node.id);
    nodes.push(node);
  }
  return nodes;
}

test('submit fails when no node is ready', () => {
  const r = makeRouter();
  r.addNode('claude');
  let err = null;
  r.on('error', (e) => { err = e; });
  assert.strictEqual(r.submit('hi'), false);
  assert.match(err.message, /No ready node/);
});

test('submit dispatches to a ready node and marks it busy', () => {
  const r = makeRouter();
  const [a] = readyNodes(r, 2);
  let dispatched = null;
  r.on('dispatch', (d) => { dispatched = d; });
  assert.strictEqual(r.submit('build x'), true);
  assert.strictEqual(dispatched.nodeId, a.id);
  assert.strictEqual(dispatched.resumed, false);
  assert.strictEqual(r.nodes.get(a.id).status, STATUS.BUSY);
});

test('submit emits initial history containing the user prompt', () => {
  const r = makeRouter();
  readyNodes(r, 1);
  let history = null;
  r.on('history', (h) => { history = h; });
  r.submit('hello router');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].role, 'user');
  assert.strictEqual(history[0].text, 'hello router');
});

test('pinned mode selects the chosen node', () => {
  const r = makeRouter();
  const [, b] = readyNodes(r, 2);
  r.setMode(b.id);
  let dispatched = null;
  r.on('dispatch', (d) => { dispatched = d; });
  r.submit('task');
  assert.strictEqual(dispatched.nodeId, b.id);
});

test('only one task runs at a time', () => {
  const r = makeRouter();
  readyNodes(r, 2);
  r.on('error', () => {});
  assert.strictEqual(r.submit('one'), true);
  assert.strictEqual(r.submit('two'), false);
});

test('failover switches node and writes handoff with progress', () => {
  const r = makeRouter();
  const [a, b] = readyNodes(r, 2);
  const events = [];
  r.on('dispatch', (d) => events.push(d));
  r.submit('refactor the parser');
  r.record(a.id, 'assistant', 'Read parser.js and found 3 issues');
  r.fail(a.id, 'quota exhausted');

  assert.strictEqual(events.length, 2);
  const second = events[1];
  assert.strictEqual(second.nodeId, b.id);
  assert.strictEqual(second.resumed, true);
  assert.ok(fs.existsSync(second.handoffPath));
  const txt = fs.readFileSync(second.handoffPath, 'utf8');
  assert.match(txt, /refactor the parser/);
  assert.match(txt, /found 3 issues/);
  assert.match(txt, /quota exhausted/);
  assert.match(second.text, /Continue the same task/);
  assert.strictEqual(r.nodes.get(a.id).status, STATUS.DOWN);
});

test('failover does not return to an already tried node', () => {
  const r = makeRouter();
  const [a, b, c] = readyNodes(r, 3);
  const targets = [];
  r.on('dispatch', (d) => targets.push(d.nodeId));
  r.submit('t');
  r.fail(a.id, 'e1');
  r.fail(b.id, 'e2');
  assert.deepStrictEqual(targets, [a.id, b.id, c.id]);
});

test('error when no replacement is available', () => {
  const r = makeRouter();
  const [a] = readyNodes(r, 1);
  let err = null;
  r.on('error', (e) => { err = e; });
  r.submit('t');
  r.fail(a.id, 'boom');
  assert.match(err.message, /No replacement node/);
  assert.strictEqual(r.task, null);
});

test('maxFailovers stops endless switching', () => {
  const r = makeRouter({ maxFailovers: 1 });
  const [a, b, c] = readyNodes(r, 3);
  let err = null;
  r.on('error', (e) => { err = e; });
  r.submit('t');
  r.fail(a.id, 'e1');
  r.fail(b.id, 'e2');
  assert.match(err.message, /Gave up/);
  assert.strictEqual(r.nodes.get(c.id).status, STATUS.READY);
});

test('complete frees the node and the router', () => {
  const r = makeRouter();
  const [a] = readyNodes(r, 1);
  r.submit('t');
  r.complete(a.id);
  assert.strictEqual(r.task, null);
  assert.strictEqual(r.nodes.get(a.id).status, STATUS.READY);
});

test('down node recovers after cooldown', () => {
  let t = 1000;
  const r = makeRouter({ now: () => t, cooldownMs: 500 });
  const [a] = readyNodes(r, 1);
  r.setStatus(a.id, STATUS.DOWN, 'x');
  assert.strictEqual(r.pickNode(), null);
  t += 600;
  assert.strictEqual(r.pickNode().id, a.id);
});

test('removing the active node triggers failover', () => {
  const r = makeRouter();
  const [a, b] = readyNodes(r, 2);
  const targets = [];
  r.on('dispatch', (d) => targets.push(d.nodeId));
  r.submit('t');
  r.removeNode(a.id);
  assert.deepStrictEqual(targets, [a.id, b.id]);
});
