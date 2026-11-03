'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../lib/app');
const { vis } = require('../lib/utils');

const issue = (number, title) => ({
  number, title, url: null, updatedAt: new Date().toISOString(), repository: { name: 'r' }, author: { login: 'ann' },
  comments: { totalCount: 0 }, milestone: null, assignees: { nodes: [] }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] },
});
const pane = (blockId, title, session) => ({ session, blockId, prog: 'pi', cwd: '/r', title, rec: { state: 'working', updated_at: new Date().toISOString() } });
const pr = (number) => ({ number, title: 'a pr', url: `https://github.com/o/r/pull/${number}`, isDraft: false, reviewDecision: null, updatedAt: new Date().toISOString(), repository: { name: 'r' }, commits: { nodes: [] } });

test('keyboard filtering, selection, visible PR limit, and browser URL restrictions survive extraction', () => {
  const app = createApp({ stdout: { columns: 100, rows: 30, write() {} } }), { state } = app;
  state.fleet = [{ label: 'web', panes: [pane('b1', 'c-a-c-h-e rows', 'web')] }, { label: 'api', panes: [pane('b2', 'add auth', 'api')] }];
  state.issues = { issueCount: 2, nodes: [issue(7, 'fix it'), issue(8, 'add cache')] };
  for (const key of '/jk') app.press(key);
  assert.match(vis(app.frame()[1]), /\/jk/); // letters were typed, not used as movement
  app.press('\x15'); // ctrl-u
  for (const key of 'cache') app.press(key);
  assert.deepEqual(app.selectable().map((x) => x.key), ['b1', 'r#8']);
  assert.ok(app.selectable()[1].score > app.selectable()[0].score);
  app.press('\x1b[A'); // arrows still select while typing
  assert.ok(app.frame().some((row) => row.includes('▸')));
  app.press('\r'); // keep filter
  app.press('j');
  assert.ok(app.frame().some((row) => row.includes('▸')));
  app.press('\x1b'); // clear kept filter
  assert.deepEqual(app.selectable().map((x) => x.key), ['b1', 'b2', 'r#7', 'r#8']);
  app.press('/'); app.press('\x7f');
  assert.ok(app.frame()[1].includes('[j/k]')); // backspace on an empty filter exits editing
  state.prs = { review: { issueCount: 1, nodes: [pr(3)] }, mine: { issueCount: 12, nodes: Array.from({ length: 12 }, (_, k) => pr(20 + k)) } };
  assert.deepEqual(app.selectable().map((x) => `${x.kind} ${x.key}`),
    ['agent b1', 'agent b2', 'pr r#3', ...Array.from({ length: 10 }, (_, k) => `pr r#${20 + k}`), 'issue r#7', 'issue r#8']);
  app.setQuery('a pr');
  assert.deepEqual(app.page(), { key: 'r#3', url: 'https://github.com/o/r/pull/3' });
  app.setQuery('fix it');
  assert.deepEqual(app.page(), { why: 'no link yet: wait for the refresh' });
  state.issues.nodes[0].url = 'file:///etc/passwd';
  assert.deepEqual(app.page(), { why: 'no link yet: wait for the refresh' });
  state.prsErr = 'offline';
  app.setQuery('');
  assert.deepEqual(app.selectable().map((x) => x.kind), ['agent', 'agent', 'issue', 'issue']);
});

test('once renders its four sections without interactive controls or settings effects', () => {
  const app = createApp({ once: true });
  const text = app.frame().map(vis).join('\n');
  for (const section of ['FLEET', 'USAGE', 'PRS', 'ISSUES']) assert.ok(text.includes(section));
  assert.ok(!text.includes('[j/k]'));
});
