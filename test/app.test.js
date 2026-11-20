'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { parseConfig } = require('../lib/config');
const { vis, dim } = require('../lib/utils');
const { BAND } = require('../lib/ui/effects');

// The keys ? shows, as text, at most w columns by h rows; ? again closes them.
const keysOf = (app, w = 100, h = 40) => {
  app.press('?');
  const box = app.popup(w, h);
  app.press('?');
  return box.map(vis).join('\n');
};

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
  assert.equal(app.frame()[1], BAND); // backspace on an empty filter exits editing, and takes its row away
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

test('? shows the keys over the dashboard, for what shows, and the next key only closes them', async () => {
  const config = parseConfig({ keymaps: { a: { label: 'agent', command: 'claude' }, R: { label: 'review', command: { pr: 'claude' } } } });
  const integrations = { details: async () => { throw new Error('offline'); } };
  const app = createApp({ stdout: { columns: 100, rows: 40, write() {} }, config, integrations }), { state } = app;
  state.issues = { issueCount: 1, nodes: [{ ...issue(7, 'fix it'), url: 'https://github.com/o/r/issues/7' }] };
  const text = () => app.frame().map(vis), shown = () => app.popup(100, 40)?.map(vis).join('\n') ?? null;
  assert.match(text()[0], / {2}\[\?\] keys$/);
  assert.equal(text()[1], BAND); // no key bar
  assert.equal(shown(), null);

  app.press('?');
  const keys = shown();
  assert.match(keys, /^╭─ keys ─+╮$/m);
  for (const k of [/│ j\/k ↑\/↓ +select +│/, /│ \^D \^U +half a screen down, up +│/, /│ \/ +filter +│/, /│ s e +shader aurora · effects bloom\+scanlines +│/, /│ a +agent {2}issue, PR +│/, /^├─ your keys ─+┤$/m, /│ R +review {2}PR +│/, /^╰─ any key closes this ─+╯$/m]) {
    assert.match(keys, k);
  }
  assert.doesNotMatch(keys, /5 stacks/); // outside a repo
  assert.ok(app.popup(40, 12).every((l) => vis(l).length === 38), 'a small pane cuts it');
  assert.match(app.popup(40, 12).map(vis).at(-2), /│ … +│/);

  // the key that closes them does nothing else: not move, quit or launch
  app.press('j');
  assert.equal(shown(), null);
  assert.ok(!text().some((l) => l.startsWith('▸')));
  app.press('?'); app.press('q');
  assert.equal(shown(), null);
  app.press('?'); await app.press('a');
  assert.doesNotMatch(text()[0], /agent/);

  // while typing a filter, ? is text, in the filter's row
  app.press('/'); app.press('?');
  assert.equal(shown(), null);
  assert.match(text()[1], /^\/\? +\[⏎\] keep/); // and the cursor
  app.press('\x1b');
  assert.equal(text()[1], BAND);

  // on a page, the page's keys, and yours for its kind
  app.press('j');
  await app.press('l');
  app.press('?');
  assert.match(shown(), /keys · issue[^]*│ ← esc ⌫ +back +│[^]*│ a +agent +│/);
  assert.doesNotMatch(shown(), /review/);
  app.press('\x1b');
  assert.equal(text()[4], 'ISSUE r#7  '); // esc closed the keys, and left the page as it was

  const once = createApp({ once: true });
  once.press('?');
  assert.equal(once.popup(100, 40), null);
  assert.doesNotMatch(vis(once.frame()[0]), /keys/);
});

test('s and e say in the header which shader and effects they picked', (t) => {
  // in a process of its own, so the picks are saved apart from yours
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-fx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `const { createApp } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'app'))});
    const { vis } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'utils'))});
    const app = createApp({ stdout: { columns: 200, rows: 30, write() {} } });
    app.press('s'); console.log(vis(app.frame()[0]));
    app.press('e'); console.log(vis(app.frame()[0]));`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, XDG_STATE_HOME: dir }, encoding: 'utf8' }).trim().split('\n');
  assert.match(out[0], / {2}shader plasma$/);
  assert.match(out[1], / {2}effects bloom$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rex-dash', 'settings.json'), 'utf8')), { shader: 'plasma', effect: 'bloom' });
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

  assert.match(keysOf(app), /│ a +agent {2}issue, PR +│\n│ h +here {2}issue +│/);
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

test('keys 1 to 6 hide and show sections for the session, starting from the config, and hidden ones are not selected', () => {
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
  assert.match(vis(app.frame()[0]), /hidden \[2\] usage \[6\] issues/);
  assert.match(keysOf(app), /1-6 +hide or show: 1 fleet/);
  app.press('?');
  assert.ok(app.popup(100, 40).join('\n').includes(`1 fleet  ${dim('2 usage')}  3 review requests`)); // hidden ones dim
  app.press('?');
  assert.deepEqual(app.selectable().map((x) => x.key), ['b1', 'r#3', 'r#4']);

  app.press('6'); app.press('1'); app.press('3');
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

  assert.match(header(), /\[\?\] keys/);
  assert.equal(text()[1], BAND); // no key bar
  await app.press('l'); // nothing selected
  assert.match(header(), /pick a PR, stack or issue with j\/k first/);
  app.press('j');
  await app.press('\x1b[C'); // an agent
  assert.match(header(), /pick a PR, stack or issue with j\/k first/);
  app.press('j');
  await app.press('l'); // a PR cached before URLs were fetched
  assert.match(header(), /no link yet: wait for the refresh/);
  assert.deepEqual(fetched, []);

  app.press('j');
  await app.press('l');
  assert.deepEqual(fetched, ['https://github.com/o/r/issues/7']);
  let rows = text();
  assert.match(rows[0], / {2}lines 1-17 of \d+ {2}\[\?\] keys/);
  const of = () => header().match(/lines (\d+)-(\d+) of (\d+)/).slice(1).map(Number);
  assert.equal(rows.length, 2 + of()[2]); // the page goes on below the screen, from where it's scrolled to
  assert.deepEqual(rows.slice(3, 5), ['ISSUE r#7  ', '  fix it']);
  const keys = keysOf(app);
  assert.match(keys, /keys · issue/);
  assert.match(keys, /│ ⏎ +worktree +│/);
  assert.match(keys, /│ a +agent +│/); // keymaps for issues, without their kinds
  assert.doesNotMatch(keys, /review|│ t /);
  assert.ok(!rows.some((l) => /FLEET|ISSUES/.test(l)));
  assert.deepEqual(app.page(), { key: 'r#7', url: 'https://github.com/o/r/issues/7' }); // o and keymaps act on it

  app.press('j'); app.press('j');
  assert.equal(text()[2], '  fix it');
  assert.deepEqual(of().slice(0, 2), [3, 19]);
  app.press('k');
  assert.equal(text()[2], 'ISSUE r#7  ');
  app.press(' ');
  assert.deepEqual(of().slice(0, 2), [18, 34]);
  app.press('\x1b[F'); // end
  const total = of()[2];
  assert.deepEqual(of(), [total - 16, total, total]);
  assert.deepEqual(text().slice(-4), ['  line 39', '', 'COMMENTS  0', '  none']);
  app.press('j'); // no further
  assert.deepEqual(of(), [total - 16, total, total]);
  app.press('\x1b[H'); // home
  assert.deepEqual(of().slice(0, 2), [1, 17]);
  app.press('/'); app.press('1'); // the lists' keys don't act on a page
  assert.equal(text()[3], 'ISSUE r#7  ');

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
  assert.match(text()[2], /^ {2}couldn't refresh: HTTP 502$/);
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
  assert.equal(text()[3], 'ISSUE r#7  ');
  app.press('\x1b');
  assert.match(text()[1], /^\/fix {2}\[esc\] clear/);
});

test('Ctrl-D/U, Ctrl-F/B, Page Down/Up, Home and End scroll the lists as in Vim, and j/k only to keep the selection on screen', async () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n');
  const integrations = {
    details: async (url) => ({ __typename: 'Issue', viewer: 'me', number: 73, title: 'bug 3', url, state: 'OPEN', body, author: { login: 'ann' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', assignees: { nodes: [] }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, comments: { totalCount: 0, nodes: [] } }),
  };
  const stdout = { columns: 100, rows: 19, write() {} }; // 16 rows for the lists: half a screen is 8, a screen 15
  const config = { keymaps: new Map(), hide: new Set(['usage', 'review_requests']), errors: [] };
  const app = createApp({ stdout, config, integrations }), { state } = app;
  const agents = (from, n) => Array.from({ length: n }, (_, k) => pane(`b${from + k}`, `agent ${from + k}`, 'web'));
  state.fleet = [{ label: 'web', panes: agents(0, 10) }];
  state.prs = { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 10, nodes: Array.from({ length: 10 }, (_, k) => pr(20 + k)) } };
  state.issues = { issueCount: 5, nodes: Array.from({ length: 5 }, (_, k) => ({ ...issue(70 + k, `bug ${k}`), url: `https://github.com/o/r/issues/${70 + k}` })) };

  const shown = () => { const rows = app.frame(); return rows.slice(rows.indexOf(BAND) + 1).map(vis); }; // the lists, from the top of the screen down
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
  press(END); // the filter's row takes one of the lists' rows: 15, and half a screen is 7
  assert.deepEqual(where().filter((_, i) => i !== 1), ['agent 9', 9]);
  press(D);
  assert.deepEqual(where().filter((_, i) => i !== 1), ['agent 9', 9]);
  press(U); // the view scrolls 7 rows, and the selection 8, to the agent nearest
  assert.deepEqual(where().filter((_, i) => i !== 1), ['agent 5', 8]);
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
  assert.match(vis(app.frame()[0]), /lines 9-24 of \d+/);
  press('\x1b[D');
  assert.deepEqual(where(), ['r#73', 31, 12]);

  // when the lists grow above the selection, or the pane shrinks, the view moves only to keep it on screen
  state.fleet[0].panes.unshift(...agents(10, 3));
  total += 6;
  assert.deepEqual(where(), ['r#73', 35, 14]);
  stdout.rows = 9;
  assert.deepEqual(where(), ['r#73', 45, 4]);
});

// A repo with one stack of three: r#1 yours, r#2 fetched with the stack, r#3 merged.
const stacked = (number, position, more = {}) => ({ ...pr(number), title: `pr ${number}`, status: 'review', stack: { id: 'S9', number: 9, size: 3 }, stackEntry: { position }, ...more });
const stackState = () => ({
  pages: [{ path: 'p', etag: 'e', stacks: [{ id: 'S9', number: 9, repo: 'r', base: 'main', url: 'https://github.com/o/r/stack/9', members: [
    { number: 1, state: 'OPEN', isDraft: false, head: 'b1' }, { number: 2, state: 'OPEN', isDraft: false, head: 'b2' }, { number: 3, state: 'MERGED', isDraft: false, head: 'b3' },
  ] }] }],
  prs: { 2: stacked(2, 2, { status: 'approved' }), 3: stacked(3, 3, { state: 'MERGED', status: 'merged' }) },
});
const repoApp = (integrations = {}, config) => {
  const repo = { roots: ['/r'], gh: 'o/r', name: 'o/r' };
  const app = createApp({ stdout: { columns: 160, rows: 60, write() {} }, repo, config, integrations });
  Object.assign(app.state, { prs: { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 2, nodes: [stacked(1, 1), pr(4)] } }, stacks: stackState() });
  return app;
};

test('in a repo, the stacks section shows after your PRs, and j/k go through its stacks and their PRs, apart from your PRs\' rows', () => {
  const app = repoApp(), text = () => app.frame().map(vis);
  const at = (s) => text().findIndex((l) => l.includes(s));
  assert.ok(at('MY PRS') < at('STACKS') && at('STACKS') > 0);
  assert.match(text()[at('STACKS')], /STACKS {2}1 open in the repo/);
  assert.deepEqual(app.selectable().map((x) => `${x.kind} ${x.id}`), ['pr r#1', 'pr r#4', 'stack r#9', 'pr r#9/r#1', 'pr r#9/r#2', 'pr r#9/r#3']);
  for (let i = 0; i < 6; i++) app.press('j');
  const marked = () => text().filter((l) => l.startsWith('▸'));
  assert.equal(marked().length, 1);
  assert.match(marked()[0], /^▸ {4}3 · merged {3}r#3 pr 3/); // past r#1's row in the stack, though r#1 is in your PRs too
  app.press('k'); app.press('k');
  assert.match(marked()[0], /^▸ {4}1 · review {3}r#1 pr 1/);
  app.press('k');
  assert.match(marked()[0], /^▸ ⧉ r#9 → main/);
  assert.deepEqual(app.page(), { key: 'r#9', url: 'https://github.com/o/r/stack/9' }); // Enter and o open it in the browser
  app.press('5');
  assert.equal(at('STACKS'), -1);
  assert.match(text()[0], /hidden \[5\] stacks/);
  assert.deepEqual(app.selectable().map((x) => x.id), ['r#1', 'r#4']);
  // stacks cached without PRs: theirs show as fetched, or as their branch
  app.press('5');
  delete app.state.prs;
  assert.deepEqual(app.selectable().map((x) => x.id), ['r#9', 'r#9/r#1', 'r#9/r#2', 'r#9/r#3']);
  assert.ok(text().some((l) => / 1 · review {3}r#1 b1$/.test(l)));
});

test('l or t open a stack\'s page from the lists, where j/k select its PRs, l opens one, t opens a PR\'s stack, and ← goes back, page by page', async () => {
  const fetched = [];
  const integrations = {
    details: async (url) => { fetched.push(url); return { __typename: 'PullRequest', number: +url.split('/').at(-1), title: 'from GitHub', url, state: 'OPEN', repository: { name: 'r' }, stack: { id: 'S9', number: 9, size: 3 }, stackEntry: { position: 2 } }; },
    stack: async () => { throw new Error('the repo\'s stacks have it'); },
  };
  const app = repoApp(integrations), text = () => app.frame().map(vis);
  for (const key of 'jjj') app.press(key); // r#1 and r#4 in your PRs, then the stack's row
  await app.press('l');
  const keys = keysOf(app);
  assert.match(keys, /keys · stack/);
  for (const k of [/j\/k ↑\/↓ +select a PR/, /l → +the PR's page/, /⏎ o +open in the browser/]) assert.match(keys, k);
  assert.equal(text()[3], 'STACK r#9  ');
  assert.ok(text().some((l) => /^▸ {2}1 · review {3}#1 pr 1/.test(l)));
  assert.deepEqual(app.page(), { key: 'r#9', url: 'https://github.com/o/r/stack/9' });
  app.press('j');
  assert.ok(text().some((l) => /^▸ {2}2 · approved #2 pr 2/.test(l)));
  app.press('j'); app.press('j'); // no further than the last
  assert.ok(text().some((l) => /^▸ {2}3 · merged/.test(l)));
  app.press('k');
  await app.press('l');
  assert.deepEqual(fetched, ['https://github.com/o/r/pull/2']);
  assert.equal(text()[3], 'PR r#2  ');
  assert.match(keysOf(app), /│ t +stack page +│/); // a PR in a stack
  assert.ok(text().includes('  ▸  2 ● approved #2 pr 2')); // its stack, from the repo's
  await app.press('t'); // the stack again, in front of the PR's page
  assert.ok(text().some((l) => /^▸ {2}2 · approved #2/.test(l)));
  for (const page of ['PR r#2  ', 'STACK r#9  ']) { app.press('\x1b[D'); assert.equal(text()[3], page); }
  app.press('\x1b');
  assert.ok(text().some((l) => l.startsWith('▸ ⧉ r#9')), 'the stack stays selected');

  // t on a PR in your PRs opens its stack at it; on a PR in no stack, says so
  app.press('k'); app.press('k');
  await app.press('t');
  assert.ok(text().some((l) => /^▸ {2}1 · review/.test(l)));
  app.press('\x7f');
  app.press('j');
  app.press('t');
  assert.match(text()[0], /r#4 isn't in a stack/);
});

test('outside a repo there\'s no stacks section, but t still opens a stacked PR\'s stack, which its page fetches', async () => {
  const asked = [];
  const app = createApp({ stdout: { columns: 160, rows: 60, write() {} }, integrations: { stack: async (id) => { asked.push(id); return stackState(); } } });
  Object.assign(app.state, { prs: { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 1, nodes: [stacked(1, 1)] } }, stacks: stackState() });
  const text = () => app.frame().map(vis);
  assert.ok(!text().some((l) => l.includes('STACKS')));
  assert.deepEqual(app.selectable().map((x) => x.id), ['r#1']);
  app.press('5');
  assert.match(text()[0], /stacks show in repo mode/);
  assert.doesNotMatch(text()[0], /hidden/);
  app.press('j');
  await app.press('t');
  assert.deepEqual(asked, ['S9']);
  assert.equal(text()[3], 'STACK r#9  ');
  assert.ok(text().some((l) => /^▸ {2}1 · review/.test(l)));
});

test('the repo\'s stacks are fetched after the PRs, from their PRs, and not at all while hidden or outside a repo', async () => {
  const calls = [];
  const listed = { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 0, nodes: [] } };
  const integrations = {
    fleet: async () => [],
    prs: async () => { calls.push('prs'); await new Promise((r) => setTimeout(r, 5)); return listed; },
    stacks: async (repo, { prs, cached }) => { calls.push(['stacks', repo.gh, prs === listed, cached]); return stackState(); },
    issues: async () => ({ issueCount: 0, nodes: [] }),
  };
  const config = parseConfig({ hide: ['usage'] });
  const app = repoApp(integrations, config);
  const before = app.state.stacks;
  await Promise.all(app.refreshAll());
  assert.deepEqual(calls, ['prs', ['stacks', 'o/r', true, before]]);
  assert.equal(app.state.stacks.pages[0].stacks[0].number, 9);

  calls.length = 0;
  app.press('5'); // hidden
  await Promise.all(app.refreshAll());
  assert.deepEqual(calls, ['prs']);
  calls.length = 0;
  const outside = createApp({ stdout: { columns: 100, rows: 30, write() {} }, config, integrations });
  await Promise.all(outside.refreshAll());
  assert.deepEqual(calls, ['prs']);
});

test('Ctrl-D/U, Home and End scroll through stacks and their PRs, apart from the same PRs in your PRs', () => {
  const stdout = { columns: 160, rows: 9, write() {} }; // 6 rows for the lists
  const config = { keymaps: new Map(), hide: new Set(['fleet', 'usage', 'review_requests', 'issues']), errors: [] };
  const app = createApp({ stdout, config, repo: { roots: ['/r'], gh: 'o/r', name: 'o/r' } });
  Object.assign(app.state, { prs: { review: { issueCount: 0, nodes: [] }, mine: { issueCount: 2, nodes: [stacked(1, 1), pr(4)] } }, stacks: stackState() });
  // MY PRS: a blank row, its heading and 2 PRs, at rows 0 to 3. STACKS: a blank row, its heading, the stack and
  // its 3 PRs, at 4 to 9.
  const shown = () => app.frame().slice(2).map(vis); // under the header and the band
  const marked = () => shown().filter((l) => l.startsWith('▸ '));
  app.press('\x1b[F'); // End: the stack's last PR, at the bottom
  assert.equal(marked().length, 1);
  assert.match(marked()[0], /^▸ {4}3 · merged/);
  assert.match(shown()[1], /^STACKS/);
  app.press('k'); app.press('k');
  assert.match(marked()[0], /^▸ {4}1 · review {3}r#1/); // the stack's r#1, not your PRs'
  assert.match(shown()[1], /^STACKS/); // still on screen, so no scroll
  app.press('\x15'); // Ctrl-U: 3 rows up, from the stack's r#1 at row 7 to row 4, and r#4 at row 3 is nearest
  assert.equal(marked().length, 1);
  assert.match(marked()[0], /^▸ · review {3}r#4 a pr/);
  assert.match(shown()[0], /^MY PRS/);
  app.press('\x04'); // Ctrl-D: 3 rows down, from row 3 to row 6, the stack's row
  assert.match(marked()[0], /^▸ ⧉ r#9 → main/);
  app.press('\x1b[H'); // Home
  assert.match(marked()[0], /^▸ · review {3}r#1 ⧉1\/3/);
  assert.match(shown()[1], /^MY PRS/);
});
