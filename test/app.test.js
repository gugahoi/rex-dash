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

test('your PRs with replies waiting are selected first, and Rex hears how many when the pane comes back from wt', async () => {
  const writes = [];
  const integrations = { runWorktree: async (kind, number, { onHandoff }) => { onHandoff(true); onHandoff(false); return { code: 0 }; } };
  const repo = { roots: ['/r'], gh: 'o/r', name: 'o/r' };
  const app = createApp({ stdout: { columns: 300, rows: 40, write: (s) => writes.push(s) }, repo, integrations }), { state } = app;
  state.prs = { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 3, nodes: [pr(1), { ...pr(2), replies: 2 }, { ...pr(3), replies: 1 }] } };
  assert.deepEqual(app.selectable().map((x) => x.key), ['r#2', 'r#3', 'r#1']);
  app.press('j');
  await app.press('\r');
  const status = writes.map((s) => s.match(/\x1b\]7501;state=(\w+)[^\x07]*?(?::msg=([^\x07]+))?\x07/)).filter(Boolean).at(-1);
  assert.equal(status[1], 'blocked');
  assert.equal(Buffer.from(status[2], 'base64').toString(), '2 PRs need your reply');
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

test('keys 1 to 5 hide and show sections for the session, starting from the config, and hidden ones are not selected', () => {
  const writes = [];
  const config = parseConfig({ hide: ['usage', 'issues'] });
  const app = createApp({ stdout: { columns: 300, rows: 60, write: (s) => writes.push(s) }, config }), { state } = app;
  state.fleet = [{ label: 'web', panes: [pane('b1', 'coding', 'web')] }];
  state.usage = { daily: [1], models: [['claude-x', 5, 3]] };
  state.prs = { review: { issueCount: 1, nodes: [pr(3)] }, mine: { issueCount: 1, nodes: [{ ...pr(4), replies: 1 }] } };
  state.issues = { issueCount: 1, nodes: [issue(7, 'fix it')] };
  const text = () => app.frame().map(vis).join('\n');
  const headings = () => ['FLEET', 'USAGE', 'REVIEW REQUESTS', 'MY PRS', 'ISSUES'].filter((h) => text().includes(h));
  const status = () => writes.map((s) => s.match(/\x1b\]7501;state=(\w+)/)).filter(Boolean).at(-1)?.[1];

  assert.deepEqual(headings(), ['FLEET', 'REVIEW REQUESTS', 'MY PRS']);
  assert.match(vis(app.frame()[0]), /hidden \[2\] usage \[5\] issues/);
  assert.match(vis(app.frame()[1]), /\[\/\] filter {2}\[1-5\] hide {2}\[s\] shader/);
  assert.deepEqual(app.selectable().map((x) => x.key), ['b1', 'r#3', 'r#4']);

  app.press('5'); app.press('1'); app.press('3');
  assert.deepEqual(headings(), ['MY PRS', 'ISSUES']);
  assert.match(vis(app.frame()[0]), /hidden \[1\] fleet \[2\] usage \[3\] review requests/);
  assert.deepEqual(app.selectable().map((x) => x.key), ['r#4', 'r#7']);

  // with my PRs hidden, Rex doesn't hear of their replies; nor are they on screen to select
  assert.equal(status(), 'blocked'); // any key that hides or shows tells Rex what shows
  app.press('4');
  assert.deepEqual(headings(), ['ISSUES']);
  assert.deepEqual(app.selectable().map((x) => x.key), ['r#7']);
  assert.equal(status(), 'idle');
  app.press('4');
  assert.equal(status(), 'blocked');
  app.press('4');
  assert.equal(status(), 'idle');

  // a hidden section's error stays hidden too, and the filter only looks through what shows
  state.prsErr = 'offline';
  app.press('3');
  assert.match(text(), /PRS {2}\n {2}offline/);
  app.press('3');
  assert.doesNotMatch(text(), /offline/);
  delete state.prsErr;
  app.setQuery('coding');
  assert.deepEqual(app.selectable(), []);
  app.setQuery('');

  // while typing a filter, digits are text
  app.press('/'); app.press('2'); app.press('\r');
  assert.deepEqual(headings(), ['ISSUES']);
  assert.match(vis(app.frame()[1]), /^\/2 /);
  app.press('\x1b');

  for (const key of '1234') app.press(key);
  assert.deepEqual(headings(), ['FLEET', 'USAGE', 'REVIEW REQUESTS', 'MY PRS', 'ISSUES']);
  assert.doesNotMatch(vis(app.frame()[0]), /hidden/);
});

test('once leaves out the sections the config hides, without the keys to show them', () => {
  const app = createApp({ once: true, config: parseConfig({ hide: ['fleet', 'review_requests'] }) });
  app.state.prs = { review: { issueCount: 1, nodes: [pr(3)] }, mine: { issueCount: 0, nodes: [] } };
  const text = app.frame().map(vis).join('\n');
  for (const section of ['USAGE', 'MY PRS', 'ISSUES']) assert.ok(text.includes(section), section);
  for (const section of ['FLEET', 'REVIEW REQUESTS', 'hidden']) assert.ok(!text.includes(section), section);
});

test('l or → opens the selected PR\'s or issue\'s page, which scrolls, and ←, esc or backspace go back to the same selection', async () => {
  const fetched = [];
  let fail = null, release;
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n');
  const integrations = {
    details: async (url) => {
      fetched.push(url);
      if (release) await new Promise((r) => { release = r; });
      if (fail) throw new Error(fail);
      return { __typename: 'Issue', viewer: 'me', number: 7, title: 'fix it', url, state: 'OPEN', body, author: { login: 'ann' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', assignees: { nodes: [] }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, comments: { totalCount: 0, nodes: [] } };
    },
  };
  const config = parseConfig({ keymaps: { a: { label: 'agent', command: 'claude' }, R: { label: 'review', command: { pr: 'claude' } } } });
  const app = createApp({ stdout: { columns: 100, rows: 20, write() {} }, config, integrations }), { state } = app;
  state.fleet = [{ label: 'web', panes: [pane('b1', 'coding', 'web')] }];
  state.prs = { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 1, nodes: [{ ...pr(3), url: null }] } };
  state.issues = { issueCount: 1, nodes: [{ ...issue(7, 'fix it'), url: 'https://github.com/o/r/issues/7' }] };
  const text = () => app.frame().map(vis);
  const header = () => text()[0];

  assert.match(text()[1], /\[⏎\] open {2}\[l\/→\] details {2}\[o\] browser/);
  await app.press('l'); // nothing selected
  assert.match(header(), /pick a PR or issue with j\/k first/);
  app.press('j');
  await app.press('\x1b[C'); // an agent
  assert.match(header(), /pick a PR or issue with j\/k first/);
  app.press('j');
  await app.press('l'); // a PR cached before URLs were fetched
  assert.match(header(), /no link yet: wait for the refresh/);
  assert.deepEqual(fetched, []);

  app.press('j');
  await app.press('l');
  assert.deepEqual(fetched, ['https://github.com/o/r/issues/7']);
  let rows = text();
  assert.match(rows[1], /^\[←\] back {2}\[j\/k\] scroll 1-16 of \d+ {2}\[⏎\] worktree {2}\[o\] browser {2}\[a\] agent {2}\[r\] refresh {2}\[q\] quit$/);
  const of = () => text()[1].match(/scroll (\d+)-(\d+) of (\d+)/).slice(1).map(Number);
  assert.equal(rows.length, 3 + of()[2]); // the page goes on below the screen, from where it's scrolled to
  assert.deepEqual(rows.slice(4, 6), ['ISSUE r#7  ', '  fix it']);
  assert.ok(!rows.some((l) => /FLEET|ISSUES/.test(l)));
  assert.deepEqual(app.page(), { key: 'r#7', url: 'https://github.com/o/r/issues/7' }); // o and keymaps act on it

  app.press('j'); app.press('j');
  assert.equal(text()[3], '  fix it');
  assert.deepEqual(of().slice(0, 2), [3, 18]);
  app.press('k');
  assert.equal(text()[3], 'ISSUE r#7  ');
  app.press(' ');
  assert.deepEqual(of().slice(0, 2), [17, 32]);
  app.press('\x1b[F'); // end
  const total = of()[2];
  assert.deepEqual(of(), [total - 15, total, total]);
  assert.deepEqual(text().slice(-4), ['  line 39', '', 'COMMENTS  0', '  none']);
  app.press('j'); // no further
  assert.deepEqual(of(), [total - 15, total, total]);
  app.press('\x1b[H'); // home
  assert.deepEqual(of().slice(0, 2), [1, 16]);
  app.press('/'); app.press('1'); // the lists' keys don't act on a page
  assert.match(text()[1], /^\[←\] back/);

  for (const back of ['\x1b[D', '\x1b', '\x7f']) {
    app.press(back);
    assert.ok(text().some((l) => l.startsWith('▸ ·') && l.includes('r#7 fix it')), 'the issue stays selected');
    await app.press('l');
  }

  // the page shows what was fetched before at once, while it's fetched again; a failed fetch keeps it, and says so
  app.press('\x1b');
  fail = 'HTTP 502';
  release = true;
  const again = app.press('l');
  assert.ok(text().some((l) => l === '  line 0'));
  release();
  await again;
  assert.match(text()[3], /^ {2}couldn't refresh: HTTP 502$/);
  assert.ok(text().some((l) => l === '  line 0'));
  release = null;
  fail = null;
  app.press('\x1b');
  await app.press('l');
  assert.ok(!text().some((l) => l.includes("couldn't")));
  assert.equal(fetched.length, 6);

  // → keeps a typed filter, and opens the best match's page
  app.press('\x1b'); app.press('/');
  for (const key of 'fix') app.press(key);
  await app.press('\x1b[C');
  assert.match(text()[1], /^\[←\] back/);
  app.press('\x1b');
  assert.match(text()[1], /^\/fix {2}\[esc\] clear/);
});

test('Ctrl-D/U, Ctrl-F/B, Page Down/Up, Home and End scroll the lists as in Vim, and j/k only to keep the selection on screen', async () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n');
  const integrations = {
    details: async (url) => ({ __typename: 'Issue', viewer: 'me', number: 73, title: 'bug 3', url, state: 'OPEN', body, author: { login: 'ann' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', assignees: { nodes: [] }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, comments: { totalCount: 0, nodes: [] } }),
  };
  const stdout = { columns: 100, rows: 20, write() {} }; // 16 rows for the lists: half a screen is 8, a screen 15
  const config = { keymaps: new Map(), hide: new Set(['usage', 'review_requests']), errors: [] };
  const app = createApp({ stdout, config, integrations }), { state } = app;
  const agents = (from, n) => Array.from({ length: n }, (_, k) => pane(`b${from + k}`, `agent ${from + k}`, 'web'));
  state.fleet = [{ label: 'web', panes: agents(0, 10) }];
  state.prs = { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 10, nodes: Array.from({ length: 10 }, (_, k) => pr(20 + k)) } };
  state.issues = { issueCount: 5, nodes: Array.from({ length: 5 }, (_, k) => ({ ...issue(70 + k, `bug ${k}`), url: `https://github.com/o/r/issues/${70 + k}` })) };

  const shown = () => app.frame().slice(3).map(vis); // the lists, from the top of the screen down
  let total = shown().length;
  // FLEET: its heading, its session's label and 10 agents of 2 rows, at rows 3 to 22. MY PRS: its heading and
  // 10 PRs of a row, at 25 to 34. ISSUES: its heading and 5 issues of 2 rows, at 37 to 46.
  assert.equal(total, 47);
  const at = () => shown().findIndex((l) => l.startsWith('▸ ')); // the selection's row on screen
  const where = () => [shown()[at()]?.match(/agent \d+|r#\d+/)[0], total - shown().length, at()]; // and the scroll
  const press = (...keys) => keys.forEach((k) => app.press(k));
  const [D, U, F, B, HOME, END] = ['\x04', '\x15', '\x06', '\x02', '\x1b[H', '\x1b[F'];

  press(D); // with nothing selected, from the top of the screen: agent 2 is at rows 7-8, so the view keeps row 7
  assert.deepEqual(where(), ['agent 2', 7, 0]);
  press(HOME);
  assert.deepEqual(where(), ['agent 0', 0, 3]);

  // j/k scroll only as far as it takes to keep the whole selection on screen
  press(...'jjjjj');
  assert.deepEqual(where(), ['agent 5', 0, 13]);
  press('j');
  assert.deepEqual(where(), ['agent 6', 1, 14]);
  press(...'kkkkkk');
  assert.deepEqual(where(), ['agent 0', 1, 2]);

  // Ctrl-D and Ctrl-U scroll half a screen, and the selection keeps its row on screen
  press(D);
  assert.deepEqual(where(), ['agent 4', 9, 2]);
  press('k');
  assert.deepEqual(where(), ['agent 3', 9, 0]);
  press('k');
  assert.deepEqual(where(), ['agent 2', 7, 0]);
  press(U); // the view stops at the top, the selection at the first agent
  assert.deepEqual(where(), ['agent 0', 0, 3]);
  press(U);
  assert.deepEqual(where(), ['agent 0', 0, 3]);
  for (const step of [['agent 4', 8, 3], ['agent 8', 16, 3], ['r#22', 24, 3], ['r#29', 31, 3], ['r#72', 31, 10], ['r#74', 31, 14], ['r#74', 31, 14]]) {
    press(D); // PRs count a row each; at the bottom, the view stops and the selection goes on, to the last issue
    assert.deepEqual(where(), step);
  }
  press(U);
  assert.deepEqual(where(), ['r#70', 23, 14]);

  // Ctrl-F and Ctrl-B, Page Down and Page Up, scroll a screen less a row; a selection they scroll off goes to
  // the first row on screen, or the last; where they can't scroll, to the last or the first
  press(HOME);
  for (const [key, step] of [[F, ['agent 6', 15, 0]], [F, ['r#25', 30, 0]], ['\x1b[6~', ['r#26', 31, 0]], [F, ['r#74', 31, 14]],
    [B, ['r#26', 16, 15]], ['\x1b[5~', ['agent 6', 1, 14]], [B, ['agent 5', 0, 13]], [B, ['agent 0', 0, 3]]]) {
    press(key);
    assert.deepEqual(where(), step);
  }
  press(...'jjjjjjjj', ...'kkkkk');
  assert.deepEqual(where(), ['agent 3', 5, 4]);
  press(B); // a selection still on screen stays, here where the view stops at the top
  assert.deepEqual(where(), ['agent 3', 0, 9]);
  press(END);
  assert.deepEqual(where(), ['r#74', 31, 14]);

  // with a filter kept, they move among its matches
  press('/', ...'agent', '\r');
  press(END);
  assert.deepEqual(where().filter((_, i) => i !== 1), ['agent 9', 10]);
  press(D);
  assert.deepEqual(where().filter((_, i) => i !== 1), ['agent 9', 10]);
  press(U);
  assert.deepEqual(where().filter((_, i) => i !== 1), ['agent 5', 10]);
  press('\x1b');

  // while typing a filter, they don't act, and Ctrl-U clears it
  press('/', ...'agent');
  const typed = [where()[0], at()];
  press(D, F, B, '\x1b[6~', END, HOME);
  assert.deepEqual([where()[0], at()], typed);
  assert.match(vis(app.frame()[1]), /^\/agent {3}\[⏎\] keep/);
  press(U);
  assert.match(vis(app.frame()[1]), /^\/ {3}\[⏎\] keep/);
  press('\x1b');

  // on a page, Ctrl-D scrolls the page; back, the lists are as they were
  press(END, 'k');
  assert.deepEqual(where(), ['r#73', 31, 12]);
  await app.press('l');
  press(D);
  assert.match(vis(app.frame()[1]), /scroll 9-24 of \d+/);
  press('\x1b[D');
  assert.deepEqual(where(), ['r#73', 31, 12]);

  // when the lists grow above the selection, or the pane shrinks, the view moves only to keep it on screen
  state.fleet[0].panes.unshift(...agents(10, 3));
  total += 6;
  assert.deepEqual(where(), ['r#73', 35, 14]);
  stdout.rows = 10;
  assert.deepEqual(where(), ['r#73', 45, 4]);
});
