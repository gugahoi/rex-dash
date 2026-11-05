'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../lib/app');
const { parseConfig } = require('../lib/config');
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

test('a keymap runs its command for the selected issue or PR in a background tab of the worktree wt makes', async () => {
  const config = parseConfig({
    keymaps: {
      a: { label: 'agent', command: { issue: 'claude "fix #$REX_DASH_NUMBER"', pr: 'claude "review #$REX_DASH_NUMBER"' } },
      h: { label: 'here', command: { issue: 'pi' }, session: 'current', background: false },
    },
    keymap: {},
  });
  const wtCalls = [], tabs = [], handoffs = [];
  let worktree = { path: '/r/7-fix-it', branch: '7-fix-it', session: 'r-7-fix-it-0123abcd' };
  const integrations = {
    prepareWorktree: async (kind, number, { onHandoff }) => {
      wtCalls.push([kind, number]);
      onHandoff(true); handoffs.push(app.press('a')); onHandoff(false); // another launch while one is starting
      return { end: { code: 0, signal: null }, worktree };
    },
    openTab: async (options) => { tabs.push(options); return { sessionId: 's', windowId: 'w' }; },
  };
  const repo = { roots: ['/r'], gh: 'o/r', name: 'o/r' };
  const app = createApp({ stdout: { columns: 300, rows: 40, write() {} }, config, repo, integrations }), { state } = app;
  state.issues = { issueCount: 1, nodes: [{ ...issue(7, "fix it; $(rm -rf ~)"), url: 'https://github.com/o/r/issues/7' }] };
  state.prs = { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 1, nodes: [pr(3)] } };
  const header = () => vis(app.frame()[0]);

  assert.match(vis(app.frame()[1]), /\[o\] browser {2}\[a\] agent {2}\[h\] here {2}\[\/\] filter/);
  assert.match(header(), /config: unknown field "keymap"/);

  await app.press('a'); // nothing selected
  assert.match(header(), /\[a\] agent: pick an issue or a PR with j\/k first/);
  app.setQuery('a pr');
  await app.press('h'); // h is for issues only
  assert.match(header(), /\[h\] here: pick an issue with j\/k first/);
  assert.deepEqual(wtCalls, []);

  app.setQuery('fix it');
  await app.press('a');
  assert.deepEqual(wtCalls, [['issue', 7]]);
  await Promise.all(handoffs);
  assert.deepEqual(wtCalls, [['issue', 7]]); // the one pressed while it started didn't start another
  assert.equal(tabs.length, 1);
  const { argv, ...tab } = tabs[0];
  assert.deepEqual(tab, { sessionLabel: 'r-7-fix-it-0123abcd', name: 'agent #7', cwd: '/r/7-fix-it', keepOpen: true, background: true });
  assert.deepEqual(argv.slice(3), ['rex-dash', 'issue', '7', 'fix it; $(rm -rf ~)', 'https://github.com/o/r/issues/7', 'o/r', '/r/7-fix-it', '7-fix-it', 'claude "fix #$REX_DASH_NUMBER"']);
  assert.match(header(), /⇢ agent r#7 in r-7-fix-it-0123abcd/);

  // a branch prompt cancelled in wt: nothing starts
  worktree = null;
  await app.press('a');
  assert.equal(tabs.length, 1);
  assert.match(header(), /agent r#7: no worktree, so not started/);

  // in this session, and shown, which needs rex-dash in Rex
  worktree = { path: '/r/7-fix-it', branch: '7-fix-it', session: 'r-7' };
  const original = process.env.REX_SESSION;
  try {
    delete process.env.REX_SESSION;
    await app.press('h');
    assert.match(header(), /\[h\] here opens its tab in this session, so needs rex-dash in Rex/);
    process.env.REX_SESSION = 'mine';
    await app.press('h');
    assert.deepEqual({ ...tabs[1], argv: tabs[1].argv.at(-1) }, { sessionId: 'mine', name: 'here #7', cwd: '/r/7-fix-it', keepOpen: true, background: false, argv: 'pi' });
    assert.match(header(), /→ here r#7 in this session/);
  } finally {
    if (original === undefined) delete process.env.REX_SESSION;
    else process.env.REX_SESSION = original;
  }

  // wt missing, and a Rex failure, are said
  const failing = (prepareWorktree) => {
    const broken = createApp({ stdout: { columns: 300, rows: 40, write() {} }, config, repo, integrations: { prepareWorktree, openTab: async () => { throw new Error('rex: no server\nmore'); } } });
    broken.state.issues = state.issues;
    broken.setQuery('fix it');
    return broken;
  };
  let broken = failing(async () => ({ end: { error: Object.assign(new Error('spawn wt ENOENT'), { code: 'ENOENT' }) }, worktree: null }));
  await broken.press('a');
  assert.match(vis(broken.frame()[0]), /wt not found: brew install gugahoi\/tap\/wt/);
  broken = failing(async () => ({ end: { code: 0, signal: null }, worktree }));
  await broken.press('a');
  assert.match(vis(broken.frame()[0]), /  rex: no server  config:/);
  await broken.press('a'); // and the next launch isn't blocked by it
  assert.match(vis(broken.frame()[0]), /  rex: no server  config:/);
});

test('a keymap needs the repo, as wt does', async () => {
  const config = parseConfig({ keymaps: { a: { label: 'agent', command: 'claude' } } });
  let called = false;
  const app = createApp({ stdout: { columns: 300, rows: 40, write() {} }, config, integrations: { prepareWorktree: async () => { called = true; } } });
  app.state.issues = { issueCount: 1, nodes: [issue(7, 'fix it')] };
  app.setQuery('fix it');
  await app.press('a');
  assert.equal(called, false);
  assert.match(vis(app.frame()[0]), /start rex-dash in the repo to run \[a\] agent in a worktree/);
});
