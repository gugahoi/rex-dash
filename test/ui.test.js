'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEffects, SHADERS, BAND, SCANLINE, bg, shaded } = require('../lib/ui/effects');
const { createFilter } = require('../lib/ui/filter');
const { createSections, MARK } = require('../lib/ui/sections');
const { fit, createScreen } = require('../lib/ui/screen');
const { DIVIDER, helpLines, boxed, overlay } = require('../lib/ui/help');
const { parseConfig } = require('../lib/config');
const { red, green, blue, dim, bold, vis, clip, pad, sliceCols } = require('../lib/utils');

test('terminal effects preserve styling, clipping and saved settings; once mode stays plain', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-fx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state', 'settings.json');
  const effects = createEffects({ settingsFile: file });
  Object.assign(effects.fx, { shader: 'ember', effect: 'scanlines' });
  effects.saveFx();
  const other = createEffects({ settingsFile: file });
  other.loadFx();
  assert.deepEqual(other.fx, { shader: 'ember', effect: 'scanlines' });
  fs.writeFileSync(file, '{"shader":"toString","effect":["bloom"]}');
  other.loadFx();
  assert.deepEqual(other.fx, { shader: 'ember', effect: 'scanlines' });
  assert.equal(vis(clip(red('hello') + ' world', 3)), 'hel');
  assert.equal(vis(pad(green('ok'), 4)), 'ok  ');
  assert.ok(other.paint(red('a') + 'b', 1, 80, 0).includes('\x1b[0m' + bg(SCANLINE) + 'b'));
  const plain = createEffects({ once: true });
  assert.equal(plain.fx.shader, 'off');
  assert.equal(vis(plain.paint(BAND, 0, 10, 0)).includes('─────────'), true);
  assert.equal(vis(effects.paint(`x${shaded('ab')}`, 0, 80, 0)), 'xab\x1b[K');
  for (const shader of Object.values(SHADERS)) if (shader) {
    assert.ok(shader(37, 5, 12.3).every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
  }
});

test('filter scores word starts, applies every term, and underlines matched columns', () => {
  const filter = createFilter();
  assert.deepEqual(filter.fuzzy('ab', 'a xab').cols, [3, 4]);
  assert.deepEqual(filter.fuzzy('ca', 'claude cache').cols, [7, 8]);
  assert.equal(filter.fuzzy('Ab', 'ab'), null);
  assert.deepEqual(filter.fuzzy('ab', 'AB').cols, [0, 1]);
  assert.ok(filter.fuzzy('log', 'login page').score > filter.fuzzy('log', 'catalog').score);
  assert.ok(filter.fuzzy('fix', 'fix it').score > filter.fuzzy('fix', 'f i x').score);
  filter.setQuery('it fix');
  assert.ok(filter.match('fix it') && !filter.match('fix'));
  assert.equal(filter.underline(red('ab'), new Set([3]), 2), red('a\x1b[4mb\x1b[24m'));
  const rows = filter.shown([{ title: 'fix it' }, { title: 'other' }], (x) => [red(x.title)]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].lines[0].includes('\x1b[4m'));
});

const issue = (links = []) => ({
  number: 7, title: 'fix it', updatedAt: new Date().toISOString(), repository: { name: 'r' }, author: { login: 'ann' },
  comments: { totalCount: 0 }, milestone: null, assignees: { nodes: [] }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: links },
});
test('issue link precedence, selected rows, repo heading, and screen scrolling', () => {
  let selected = null, repo = null;
  const sections = createSections({ getRepo: () => repo, getSel: () => selected, filter: createFilter() });
  const linked = [{ number: 3, state: 'CLOSED' }, { number: 2, state: 'OPEN', isDraft: true }, { number: 1, state: 'MERGED' }];
  const starts = (links, glyph) => assert.ok(sections.issueLines(issue(links))[0].startsWith(`  ${glyph} ${blue('r#7')} `));
  starts(linked, '\x1b[33m⇄\x1b[0m');
  starts([...linked, { number: 4, state: 'OPEN' }], green('⇄'));
  starts([], dim('·'));
  selected = 'r#7';
  assert.ok(sections.issueLines(issue([]))[0].startsWith(MARK + dim('·')));
  const rows = ['title', BAND, 'a', 'b', 'c', `${MARK}x`, 'y', 'z'];
  assert.deepEqual(fit([...rows], 7), ['title', BAND, 'a', 'b', 'c', `${MARK}x`]); // the app scrolls
  assert.deepEqual(fit([...rows], 20), rows);
  repo = { roots: ['/r'] };
  assert.ok(vis(sections.renderIssues({ issueCount: 1, nodes: [issue()] })[0]).includes('1 open'));
});

const pr = (number, replies) => ({ number, title: `pr ${number}`, isDraft: false, reviewDecision: null, updatedAt: new Date().toISOString(), repository: { name: 'r' }, commits: { nodes: [] }, replies });
test('your PRs with replies waiting show how many, go first, count in the heading, and filter as reply', () => {
  const filter = createFilter();
  const sections = createSections({ getRepo: () => null, getSel: () => null, filter });
  assert.match(vis(sections.prLine(pr(1, 3))), /r#1 ↩3 pr 1 /);
  assert.doesNotMatch(vis(sections.prLine(pr(2, 0))), /↩/);
  const mine = { issueCount: 4, nodes: [pr(1), pr(2, 2), pr(3, 0), pr(4, 1)] };
  const rows = (d) => sections.renderPRs({ review: { issueCount: 0, nodes: [] }, mine: d }).map(vis);
  const out = rows(mine);
  assert.match(out.find((l) => l.includes('MY PRS')), /4 open · 2 need your reply/);
  assert.deepEqual(out.filter((l) => /r#\d/.test(l)).map((l) => l.match(/r#(\d)/)[1]), ['2', '4', '1', '3']);
  assert.match(rows({ issueCount: 1, nodes: [pr(4, 1)] }).find((l) => l.includes('MY PRS')), /1 open · 1 needs your reply/);
  assert.doesNotMatch(rows({ issueCount: 1, nodes: [pr(1)] }).find((l) => l.includes('MY PRS')), /reply/);
  filter.setQuery('reply');
  assert.deepEqual(sections.shownPRs(mine).map((x) => x.item.number), [2, 4]);
});

const { renderDetail, prose, wrap, cut, flow, cols, checks } = require('../lib/ui/detail');
test('page text wraps to the pane, by columns, hanging under list items, and cuts what mustn\'t wrap', () => {
  assert.deepEqual(wrap('- one two three four', 12), ['- one two', '  three four']);
  assert.deepEqual(wrap('  > quoted words here', 14), ['  > quoted', '    words here']);
  assert.deepEqual(wrap('abcdefghijklmnopqrstuvwxyz', 10), ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
  assert.deepEqual(wrap('', 10), ['']);
  assert.equal(cols('🚀ab'), 4);
  assert.equal(cols('e\u0301'), 1);
  assert.deepEqual(wrap('🚀🚀🚀🚀🚀🚀', 10), ['🚀🚀🚀🚀🚀', '🚀']);
  assert.equal(cut('abcdefgh', 5), 'abcd…');
  assert.equal(cut('abc', 5), 'abc');
  assert.deepEqual(flow(['aaaa', red('bbbb'), '', 'cccc'], 16).map(vis), ['  aaaa · bbbb', '  cccc']);
});

test('markdown reads as text: comments, tags and control characters go, code stays as written', () => {
  const body = [
    '<!-- template: fill this in -->', '## Steps', '', '', '<details><summary>More</summary>', 'Run it &amp; see\x1b[31m red\x07',
    '![shot](https://x/y.png) <img src="z">', '```js', 'const x = <div>&amp;</div>;', '', '```', '> a quote', '---', 'end',
  ].join('\r\n');
  const out = prose(body, 40);
  assert.deepEqual(out.map(vis), [
    '  Steps', '', '  More', '  Run it & see[31m red', '  [image: shot] [image]', '  ```js', '  const x = <div>&amp;</div>;', '  ', '  ```',
    '  > a quote', '  ' + '─'.repeat(38), '  end',
  ]);
  assert.ok(!out.join('').includes('\x07') && !out.join('').includes('\x1b[31m red'));
  assert.equal(out[0], '  ' + '\x1b[1mSteps\x1b[0m');
  assert.equal(out[9], '  ' + dim('> a quote'));
  const long = prose(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n\n'), 40, '    ', 5);
  assert.equal(long.length, 6);
  assert.equal(vis(long[5]), '    … 54 more lines: [o] opens it in the browser');
  assert.deepEqual(prose('', 40), []);
});

const ann = { login: 'ann', __typename: 'User' }, me = { login: 'me', __typename: 'User' }, bot = { login: 'ci', __typename: 'Bot' };
const comment = (author, body, day) => ({ author, body, createdAt: `2026-01-0${day}T00:00:00Z` });
const thread = (comments, more = {}) => ({ isResolved: false, isOutdated: false, path: 'src/a.js', line: 12, startLine: null, originalLine: 12, originalStartLine: null, subjectType: 'LINE', hunk: { nodes: [{ diffHunk: '@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d' }] }, comments: { totalCount: comments.length, nodes: comments }, ...more });
const prDetails = (more = {}) => ({
  __typename: 'PullRequest', viewer: 'me', number: 3, title: 'fix the login', url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false,
  body: 'Fixes it.', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', reviewDecision: 'CHANGES_REQUESTED',
  author: me, baseRefName: 'main', headRefName: 'fix-login', additions: 10, deletions: 2, changedFiles: 1,
  commits: { nodes: [{ commit: { committedDate: '2026-01-04T00:00:00Z', statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }, { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'ci/x', state: 'ERROR' },
  ] } } } }] },
  reviewThreads: { totalCount: 4, nodes: [
    thread([comment(ann, 'theirs, answered', 1), comment(me, 'done', 2)]),
    thread([comment(ann, 'resolved one', 1)], { isResolved: true }),
    thread([comment(ann, 'please rename', 1)], { path: 'src/b.js', line: null, originalLine: 20, originalStartLine: 18, isOutdated: true }),
    thread([comment(bot, 'a bot nit', 1)]),
  ] },
  reviews: { nodes: [
    { author: ann, state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-01-05T00:00:00Z' },
    { author: ann, state: 'COMMENTED', body: '', submittedAt: '2026-01-05T00:00:00Z' }, // only inline comments
    { author: me, state: 'PENDING', body: 'draft', submittedAt: null },
  ] },
  comments: { totalCount: 25, nodes: [comment(ann, 'before your commit', 3), comment(ann, 'after it', 6)] },
  ...more,
});
test('a PR\'s page puts its unresolved threads first, the ones waiting on you on top, then its description and conversation', () => {
  const text = renderDetail({ kind: 'pr', key: 'r#3', item: {}, got: { data: prDetails() } }, 120).map(vis);
  const at = (s) => text.findIndex((l) => l.includes(s));
  assert.deepEqual(text.slice(1, 6).map((l) => l.replace(/\d+[smhd] ago/g, 'ago')), [
    'PR r#3  ', '  fix the login', '  open · changes · by me · fix-login → main · +10 −2 in 1 file · opened ago · updated ago',
    '  checks · ✗ lint · ✗ ci/x · ◐ 1 pending · ✓ 1 passed', '  https://github.com/o/r/pull/3',
  ]);
  assert.match(text[at('UNRESOLVED THREADS')], /3 of 4 · 1 waits on you/);
  assert.ok(at('↩ src/b.js:18-20 · outdated') < at('src/a.js:12') && at('src/a.js:12') < at('a bot nit'));
  assert.equal(at('resolved one'), -1);
  assert.deepEqual(text.slice(at('src/b.js') + 1, at('src/b.js') + 4), ['    -b', '    +c', '    +d']);
  assert.match(text[at('please rename') - 1], /^ {4}ann · \S+$/);
  assert.match(text[at('a bot nit') - 1], /^ {4}ci \(bot\) · /);
  assert.ok(at('UNRESOLVED') < at('DESCRIPTION') && at('DESCRIPTION') < at('Fixes it.') && at('Fixes it.') < at('CONVERSATION'));
  assert.match(text[at('CONVERSATION')], /25 comments, the latest 2 shown/);
  // after your last commit (day 4): ann's comment on day 6 and her review on day 5 wait on you; the pending draft and a review of only inline comments don't show
  assert.deepEqual(text.slice(at('CONVERSATION') + 1).filter((l) => /^ {2}\S/.test(l)).map((l) => l.replace(/ · \S+$/, '')),
    ['  ann commented', '  ↩ ann requested changes', '  ↩ ann commented']);
  assert.equal(at('draft'), -1);
  // at 40 columns, every line but the headings, which paint() clips as in the lists, fits, with the last column left empty
  const narrow = renderDetail({ kind: 'pr', key: 'r#3', item: {}, got: { data: prDetails() } }, 40).map(vis);
  assert.ok(narrow.length > text.length);
  assert.ok(narrow.filter((l) => !/^[A-Z]/.test(l)).every((l) => cols(l) <= 39));
  // nothing unresolved, and a review request rather than yours: nothing waits on you
  const none = renderDetail({ kind: 'pr', key: 'r#3', item: {}, got: { data: prDetails({ author: ann, reviewThreads: { totalCount: 0, nodes: [] } }) } }, 80).map(vis);
  assert.equal(none[none.findIndex((l) => l.startsWith('UNRESOLVED')) + 1], '  none');
  assert.ok(!none.some((l) => l.includes('↩')));
});

test('an issue\'s page shows its people, labels, linked PRs, text and comments; before its details, its row\'s title', () => {
  const data = {
    __typename: 'Issue', viewer: 'me', number: 7, title: 'login fails', url: 'https://github.com/o/r/issues/7', state: 'CLOSED', stateReason: 'NOT_PLANNED',
    body: 'It fails\n\nevery time.', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', author: null, milestone: { title: 'v2' },
    assignees: { nodes: [ann, me] }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
    closedByPullRequestsReferences: { nodes: [{ number: 9, title: 'old try', state: 'CLOSED', isDraft: false }, { number: 10, title: 'new try', state: 'OPEN', isDraft: true }] },
    comments: { totalCount: 1, nodes: [comment(ann, 'same here', 2)] },
  };
  const text = renderDetail({ kind: 'issue', key: 'r#7', item: {}, got: { data } }, 120).map(vis);
  assert.match(text[3], /^ {2}closed as not planned · by ghost · assigned ann, me · milestone v2 · opened \d+d ago · updated \d+d ago$/);
  assert.equal(text[4], '   bug ');
  assert.deepEqual(text.slice(5, 7), ['  ⇄ #10 new try · draft', '  ⇄ #9 old try · closed']);
  assert.deepEqual(text.slice(text.indexOf('DESCRIPTION  ') + 1, text.indexOf('DESCRIPTION  ') + 4), ['  It fails', '', '  every time.']);
  assert.match(text.at(-2), /^ {2}ann · /);
  assert.equal(text.at(-1), '    same here');
  const item = { title: 'login fails' };
  assert.deepEqual(renderDetail({ kind: 'issue', key: 'r#7', item }, 80).map(vis), ['', 'ISSUE r#7  ', '  login fails', '  asking GitHub…']);
  assert.deepEqual(renderDetail({ kind: 'issue', key: 'r#7', item, got: { err: 'offline' } }, 80).map(vis), ["  couldn't fetch it: offline", '', 'ISSUE r#7  ', '  login fails']);
  assert.equal(vis(renderDetail({ kind: 'issue', key: 'r#7', item, got: { data, err: 'offline' } }, 80)[0]), "  couldn't refresh: offline");
  assert.deepEqual(checks(null), []);
});

const { joinStacks, summary } = require('../lib/ui/stacks');
const stackPR = (number, more = {}) => ({ number, title: `pr ${number}`, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, reviewDecision: null, updatedAt: '2026-01-02T00:00:00Z', repository: { name: 'r' }, author: { login: 'ann' }, commits: { nodes: [] }, status: 'review', ...more });
const member = (number, state = 'OPEN', isDraft = false) => ({ number, state, isDraft, head: `b${number}` });
const stacksData = (more = {}) => ({
  pages: [{ stacks: [{ id: 'S9', number: 9, repo: 'r', base: 'main', url: 'https://github.com/o/r/stack/9', members: [member(1), member(2), member(3), member(4), member(5, 'MERGED')] }] }],
  prs: { 2: stackPR(2, { status: 'changes' }), 3: stackPR(3, { status: 'approved', updatedAt: '2026-01-05T00:00:00Z' }), 5: stackPR(5) },
  ...more,
});
test('stacks join your PRs, else what was fetched with them; the stack\'s list says which are merged; the rest show as their branch', () => {
  const listed = { mine: { nodes: [stackPR(1, { status: 'approved', title: 'yours' }), stackPR(5, { title: 'listed, but merged since' })] }, review: { nodes: [] } };
  const [s] = joinStacks(stacksData(), listed);
  assert.equal(s.key, 'r#9');
  assert.deepEqual(s.members.map((m) => [m.position, m.number, m.status, m.known]), [[1, 1, 'approved', true], [2, 2, 'changes', true], [3, 3, 'approved', true], [4, 4, 'review', false], [5, 5, 'merged', true]]);
  assert.equal(s.members[0].pr.title, 'yours');
  assert.deepEqual(s.members[3].pr, { number: 4, title: 'b4', url: 'https://github.com/o/r/pull/4', repository: { name: 'r' }, isDraft: false, commits: { nodes: [] } });
  assert.equal(s.updatedAt, '2026-01-05T00:00:00Z');
  assert.deepEqual(joinStacks(null, listed), []);
  // a PR cached before PRs had a status: its review decision says
  assert.equal(joinStacks(stacksData({ prs: { 1: { ...stackPR(1), status: undefined, reviewDecision: 'APPROVED' } } }))[0].members[0].status, 'approved');
});

test('a stack\'s summary counts out of the whole stack, has a glyph for each PR in order, the next to merge, and whether it\'s stale', () => {
  const [s] = joinStacks(stacksData(), { mine: { nodes: [stackPR(1, { status: 'approved' })] } });
  const { parts, strip, next, stale } = summary(s);
  assert.deepEqual(parts.map(vis), ['2/5 approved', '1 needs changes', '1 needs review', '1 merged']);
  assert.equal(strip, [green('●'), red('●'), green('●'), '\x1b[33m○\x1b[0m', '\x1b[35m✓\x1b[0m'].join(''));
  assert.equal(next.number, 1);
  assert.equal(stale, false);
  const drafts = joinStacks({ pages: [{ stacks: [{ number: 3, repo: 'r', members: [member(1, 'OPEN', true), member(2, 'MERGED'), member(3, 'OPEN', true)] }] }] })[0];
  assert.deepEqual(summary(drafts).parts.map(vis), ['0/3 approved', '2 drafts', '1 merged']);
  assert.equal(summary(drafts).stale, true);
  assert.equal(vis(summary({ members: [{ status: 'approved', state: 'OPEN' }] }).parts[0]), '1/1 approved');
});

test('a stacked PR\'s row shows where it is, its status shows as reviews say, and the filter finds a stack\'s PRs by its number', () => {
  const filter = createFilter();
  const sections = createSections({ getRepo: () => null, getSel: () => null, filter });
  const p = stackPR(6, { status: 'approved', stack: { id: 'S9', number: 9, size: 5 }, stackEntry: { position: 2 } });
  assert.match(vis(sections.prLine(p)), /^ {2}· approved r#6 ⧉2\/5 pr 6 /);
  assert.match(vis(sections.prLine({ ...pr(7), isDraft: true })), /^ {2}· draft {4}r#7 pr 7 /); // cached without a status
  filter.setQuery('stack r#9');
  assert.deepEqual(sections.shownPRs({ nodes: [p, stackPR(7)] }).map((x) => x.item.number), [6]);
});

test('the stacks section shows each stack, then its PRs in order, dim when stale, and a stack\'s PR selects apart from its row in your PRs', () => {
  let selected = null;
  const filter = createFilter();
  const sections = createSections({ getRepo: () => ({}), getSel: () => selected, filter });
  const stale = { id: 'S7', number: 7, repo: 'r', base: 'main', url: 'https://github.com/o/r/stack/7', members: [member(10, 'OPEN', true)] };
  const data = stacksData({ pages: [{ stacks: [stacksData().pages[0].stacks[0], stale] }] });
  const list = joinStacks(data, { mine: { nodes: [stackPR(1, { status: 'approved', replies: 2 })] } });
  const rows = sections.renderStacks(list).map(vis);
  assert.match(rows[0], /^\nSTACKS {2}2 open in the repo$/);
  assert.match(rows[1], /^ {2}⧉ r#9 → main {2}●●●○✓ {2}2\/5 approved · 1 needs changes · 1 needs review · 1 merged · next #1 \S+$/);
  assert.deepEqual(rows.slice(2, 7).map((l) => l.replace(/ \d+[smhd]$/, '')), [
    '     1 · approved r#1 ↩2 pr 1', '     2 · changes  r#2 pr 2', '     3 · approved r#3 pr 3', '     4 · review   r#4 b4', '     5 · merged   r#5 pr 5',
  ]);
  const staleRow = sections.renderStacks(list)[7];
  assert.ok(staleRow.startsWith('  \x1b[2m⧉ r#7') && vis(staleRow).includes('1 draft'));
  assert.match(vis(sections.renderStacks(list, 'HTTP 502')[0]), /2 open in the repo · couldn't fetch their PRs: HTTP 502/);

  // a stack's row and its PRs' select by their own ids
  selected = 'r#9';
  assert.ok(sections.renderStacks(list)[1].startsWith(MARK));
  selected = 'r#9/r#2';
  assert.deepEqual(sections.renderStacks(list).map((l, i) => [i, l.startsWith(MARK)]).filter(([, m]) => m).map(([i]) => i), [3]);
  selected = 'r#2';
  assert.ok(!sections.renderStacks(list).some((l) => l.startsWith(MARK)));

  // the filter keeps a stack whole, by any of its rows, or by "stack" and its number
  filter.setQuery('b4');
  assert.deepEqual(sections.shownStacks(list).map((x) => x.item.key), ['r#9']);
  filter.setQuery('stack r#7');
  assert.deepEqual(sections.shownStacks(list).map((x) => x.item.key), ['r#7']);

  // long stacks show their first 20 PRs
  filter.setQuery('');
  const long = joinStacks({ pages: [{ stacks: [{ ...stale, members: Array.from({ length: 23 }, (_, i) => member(100 + i)) }] }] });
  const longRows = sections.renderStacks(long).map(vis);
  assert.equal(longRows.length, 1 + 1 + 20 + 1);
  assert.equal(longRows.at(-1), '      … 3 more');
});

test('a stacked PR\'s page shows its stack, marked where it is, or where it is when the dashboard hasn\'t the stack; a stack\'s page shows its PRs', () => {
  const [s] = joinStacks(stacksData(), { mine: { nodes: [stackPR(1, { status: 'approved' })] } });
  const data = prDetails({ number: 2, repository: { name: 'r' }, stack: { id: 'S9', number: 9, size: 5 }, stackEntry: { position: 2 } });
  const text = renderDetail({ kind: 'pr', key: 'r#2', item: {}, got: { data }, stack: s }, 120).map(vis);
  const at = text.findIndex((l) => l.startsWith('STACK r#9'));
  assert.ok(at > text.findIndex((l) => l.includes('https://github.com/o/r/pull/3')) && at < text.findIndex((l) => l.startsWith('UNRESOLVED')));
  assert.equal(text[at], 'STACK r#9  2 of 5 → main  ●●●○✓  2/5 approved · 1 needs changes · 1 needs review · 1 merged');
  assert.deepEqual(text.slice(at + 1, at + 7), [
    '     1 ● approved #1 pr 1', '  ▸  2 ● changes  #2 pr 2', '     3 ● approved #3 pr 3', '     4 ○ review   #4 b4', '     5 ✓ merged   #5 pr 5',
    '  https://github.com/o/r/stack/9 · [t] opens it',
  ]);
  const without = renderDetail({ kind: 'pr', key: 'r#2', item: {}, got: { data } }, 120).map(vis);
  assert.ok(without.includes('  ⧉ 2 of 5 in stack r#9  [t] opens it'));
  assert.ok(!renderDetail({ kind: 'pr', key: 'r#3', item: {}, got: { data: prDetails() } }, 120).map(vis).some((l) => l.includes('⧉')));

  const page = renderDetail({ kind: 'stack', key: 'r#9', item: {}, stack: s, sel: 1 }, 120).map(vis);
  assert.deepEqual(page.slice(0, 6), ['', 'STACK r#9  ', '  5 PRs → main · ●●●○✓ · 2/5 approved · 1 needs changes · 1 needs review · 1 merged',
    '  next to merge: #1, approved', '  https://github.com/o/r/stack/9', '']);
  assert.equal(page[6], 'PULL REQUESTS  5');
  assert.deepEqual(page.slice(7, 11).map((l) => l.replace(/\d+d ago/, 'ago')), [
    '   1 · approved #1 pr 1', '        b1 → main · by ann · updated ago', '▸  2 · changes  #2 pr 2', '        b2 → b1 · by ann · updated ago',
  ]);
  assert.ok(renderDetail({ kind: 'stack', key: 'r#9', item: {}, stack: s, sel: 1 }, 120)[9].startsWith(MARK));
  assert.deepEqual(renderDetail({ kind: 'stack', key: 'r#9', item: {} }, 80).map(vis), ['', 'STACK r#9  ', '  asking GitHub…']);
  assert.deepEqual(renderDetail({ kind: 'stack', key: 'r#9', item: {}, got: { err: 'offline' } }, 80).map(vis), ["  couldn't fetch it: offline", '', 'STACK r#9  ']);
});

test('a styled line slices by columns, keeping its style, its shaded runs paired, and half a wide character as a space', () => {
  assert.equal(sliceCols('abcdef', 2, 4), 'cd');
  assert.equal(sliceCols(`${red('abcd')}ef`, 1, 3), red('bc'));
  assert.equal(sliceCols(`${red('ab')}cd`, 2), '\x1b[31m\x1b[0mcd\x1b[0m'); // the style it starts in
  const line = `x${shaded('abcd')}y`;
  assert.equal(sliceCols(line, 0, 2), 'x\x01a\x02');
  assert.equal(sliceCols(line, 2, 4), '\x01bc\x02');
  assert.equal(sliceCols(line, 4), '\x01d\x02y');
  // a run closes before the codes after it, which paint() would colour character by character
  assert.equal(sliceCols(`${bold(shaded('AB'))}  ${shaded('xy')}`, 0, 5), '\x1b[1m\x01AB\x02\x1b[0m  \x01x\x02\x1b[0m');
  assert.equal(sliceCols('a🚀b', 2), ' b');
  assert.equal(sliceCols('a🚀b', 0, 2), 'a ');
  assert.equal(sliceCols('a🚀b', 1, 3), '🚀');
  assert.equal(sliceCols('e\u0301x', 1), 'x'); // a combining mark stays with its character
});

test('the keys box fits its lines, cut to the room it has, and lies over the rows with what\'s either side of it', () => {
  assert.deepEqual(boxed(['one', red('three'), 'a longer line than fits'], 'keys', 14, 10).map(vis),
    ['╭─ keys ─────╮', '│ one        │', '│ three      │', '│ a longer l │', '╰────────────╯']);
  assert.deepEqual(boxed(['1', '2', '3', '4'], 'k', 20, 5).map(vis), ['╭─ k ╮', '│ 1  │', '│ 2  │', '│ …  │', '╰────╯']);
  assert.deepEqual(boxed(['a long line'], 'a long title', 9, 5).map(vis), ['╭───────╮', '│ a lon │', '╰───────╯']); // no room for the title
  assert.deepEqual(boxed(['x', `${DIVIDER}more`, 'y'], 'k', 20, 6, 'a note').map(vis), ['╭─ k ─────╮', '│ x       │', '├─ more ──┤', '│ y       │', '╰─ a note ╯']);
  assert.deepEqual(boxed(['x'], 'k', 4, 10), []);
  assert.deepEqual(boxed(['x'], 'k', 20, 2), []);

  const rows = ['0123456789', red('abcdefghij'), 'short', `${bold(shaded('HEADING'))}  x`];
  overlay(rows, ['[--]', '[xx]', '[__]'], 10, 1, 4);
  assert.deepEqual(rows.map(vis), ['0123456789', 'abc[--]hij', 'sho[xx]', 'HEA[__]  x']);
  assert.ok(rows[1].includes('\x1b[31mhij'), 'the row\'s style goes on after the box');
  const painted = createEffects({ settingsFile: '/nonexistent' }).paint(rows[3], 3, 20, 0);
  assert.ok(!/[\x01\x02]/.test(painted) && vis(painted).startsWith('HEA[__]  x'));

  // the screen draws it in the body, under the header's band, for as long as the popup has one
  const out = [];
  let box = ['[]'], room;
  const screen = createScreen({
    frame: () => ['title', BAND, 'a', 'b', 'c', 'd'], popup: (w, h) => { room = [w, h]; return box; },
    effects: createEffects({ once: true }), output: { columns: 10, rows: 8, write: (s) => out.push(s) },
  });
  screen.draw();
  const drawn = () => out.join('').split(/\x1b\[(\d+);1H/).slice(1).reduce((m, s, i, a) => (i % 2 ? m : { ...m, [a[i]]: vis(a[i + 1]).replace('\x1b[K', '') }), {});
  assert.deepEqual(room, [9, 5]);
  assert.equal(drawn()[5], 'c  []');
  out.length = 0;
  box = null;
  screen.draw();
  assert.equal(drawn()[5], 'c');
});

test('the keys show what acts on the view: the lists\' or a page\'s, your keys that act on it, and the shader and effects', () => {
  const { keymaps } = parseConfig({ keymaps: { a: { label: 'agent', command: 'claude' }, R: { label: 'review', command: { pr: 'claude' } } } });
  const fx = { shader: 'plasma', effect: 'bloom' };
  const text = (opts) => helpLines({ fx, keymaps, configPath: '~/c.json', ...opts }).map(vis).join('\n');
  const lists = text({ view: 'lists', hidden: new Set(['usage']) });
  for (const k of [/^j\/k ↑\/↓ +select$/m, /^\^D \^U +half a screen down, up$/m, /^\^F \^B +a screen down, up \(PgDn, PgUp\)$/m, /^home end {2}the first, the last$/m,
    /^⏎ +open/m, /^\/ +filter$/m, /^1-6 +hide or show: 1 fleet {2}2 usage {2}3 review requests$/m, /^ +4 my prs {2}6 issues$/m,
    /^s e +shader plasma · effects bloom$/m, /^a +agent {2}issue, PR$/m, /^R +review {2}PR$/m]) assert.match(lists, k);
  assert.ok(helpLines({ view: 'lists', fx, hidden: new Set(['usage']) }).some((l) => l.includes(dim('2 usage')))); // hidden ones dim
  assert.match(text({ view: 'lists', repo: true }), /3 review requests\n +4 my prs {2}5 stacks {2}6 issues/);
  assert.match(helpLines({ view: 'lists', fx, configPath: '~/c.json' }).map(vis).join('\n'), /^\x05your keys\nadd them in ~\/c\.json$/m);
  assert.doesNotMatch(lists, /^esc/m); // the filter's row says what esc does

  const issue = text({ view: 'issue' });
  for (const k of [/^← esc ⌫ +back$/m, /^space \^F PgDn {2}a screen down$/m, /^⏎ +worktree$/m, /^a +agent$/m]) assert.match(issue, k);
  assert.doesNotMatch(issue, /review|^t |add them/m);
  assert.doesNotMatch(text({ view: 'pr' }), /^t /m);
  assert.match(text({ view: 'pr', stacked: true }), /^t +stack page$/m);
  assert.match(text({ view: 'pr' }), /^R +review$/m);
  const stack = text({ view: 'stack' });
  for (const k of [/^j\/k ↑\/↓ +select a PR$/m, /^l → +the PR's page$/m, /^⏎ o +open in the browser$/m]) assert.match(stack, k);
  assert.doesNotMatch(stack, /agent|your keys|add them/);
});
