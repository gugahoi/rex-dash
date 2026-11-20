'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEffects, SHADERS, BAND, SCANLINE, bg, shaded } = require('../lib/ui/effects');
const { createFilter } = require('../lib/ui/filter');
const { createSections, MARK } = require('../lib/ui/sections');
const { fit } = require('../lib/ui/screen');
const { red, green, blue, dim, vis, clip, pad } = require('../lib/utils');

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
  const rows = ['title', 'keys', BAND, 'a', 'b', 'c', `${MARK}x`, 'y', 'z'];
  assert.deepEqual(fit([...rows], 8), ['title', 'keys', BAND, 'a', 'b', 'c', `${MARK}x`]); // the app scrolls
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
