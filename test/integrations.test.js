'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { fleet, focusPane, withEnv, openTab, paneName } = require('../lib/integrations/rex');
const { prs, issues, replies, details, detailQuery, prStatus, support, STACK_REFS, http, stackList, stackMembers, stacks, stack } = require('../lib/integrations/github');
const { runWorktree, prepareWorktree } = require('../lib/integrations/wt');

test('Rex adapter uses the existing JSON CLI commands, ranks status, and filters by worktree', async () => {
  const calls = [];
  const runJson = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === 'ls') return { sessions: [{ session_id: 's1', label: 'web' }] };
    if (args[0] === 'block' && args[1] === 'ls') return { blocks: [{ block_id: 'b1', window_id: 'w1', label: 'pi' }, { block_id: 'b2', window_id: 'w2', label: 'shell' }] };
    const [,, , , , blockId, method] = args;
    if (method === 'process') return { foreground: { name: 'pi', cwd: blockId === 'b1' ? '/repo/wt' : '/other' } };
    if (method === 'program_status') return { records: [{ state: 'idle' }, { state: 'blocked', title: 'waiting' }] };
    return { title: 'Build' };
  };
  const result = await fleet({ roots: ['/repo'] }, runJson);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].panes.map((p) => [p.blockId, p.windowId, p.rec.state]), [['b1', 'w1', 'blocked']]);
  assert.deepEqual(calls[0], ['rex', ['ls', '--json']]);
  assert.deepEqual(calls[1], ['rex', ['block', 'ls', '-s', 's1', '--json']]);
  assert.ok(calls.some(([cmd, args]) => cmd === 'rex' && args.join(' ') === 'block call -s s1 -b b1 program_status'));
});

test('Rex adapter leaves the dashboard\'s own pane out of the fleet', async () => {
  const calls = [];
  const runJson = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'ls') return { sessions: [{ session_id: 's1', label: 'web' }] };
    if (args[0] === 'block' && args[1] === 'ls') return { blocks: [{ block_id: 'b1', window_id: 'w1' }, { block_id: 'b2', window_id: 'w1' }] };
    if (args.at(-1) === 'process') return { foreground: { name: 'node', cwd: '/repo' } };
    if (args.at(-1) === 'program_status') return { records: [{ state: 'idle', app: 'rex' }] };
    return { title: 'Rex Dash' };
  };
  const result = await fleet({ roots: ['/repo'] }, runJson, 'b2');
  assert.deepEqual(result[0].panes.map((p) => p.blockId), ['b1']);
  assert.ok(!calls.some((c) => c.includes('-b b2')));
});

test('Rex focus selects the session/window before the block, inheriting REX_CLIENT', async () => {
  const calls = [], original = process.env.REX_CLIENT;
  process.env.REX_CLIENT = 'client-2';
  try {
    await focusPane({ sessionId: 's', windowId: 'w', blockId: 'b' }, async (cmd, args) => calls.push([cmd, args, process.env.REX_CLIENT]));
    assert.deepEqual(calls, [
      ['rex', ['do', 'session.select', 'session_id=s', 'window_id=w'], 'client-2'],
      ['rex', ['focus', '-s', 's', 'b'], 'client-2'],
    ]);
  } finally {
    if (original === undefined) delete process.env.REX_CLIENT;
    else process.env.REX_CLIENT = original;
  }
});

test('GitHub queries preserve repo and global scopes and reject repos without a remote', async () => {
  const calls = [], run = async (cmd, args) => {
    calls.push([cmd, args]);
    return { data: { mine: {}, review: {}, issues: { issueCount: 0, nodes: [] } } };
  };
  await prs({ gh: 'owner/repo' }, run);
  await issues({ gh: 'owner/repo' }, run);
  await prs(null, run);
  await issues(null, run);
  assert.ok(calls.every(([cmd, args]) => cmd === 'gh' && args.slice(0, 3).join(' ') === 'api graphql -f'));
  assert.match(calls[0][1][3], /repo:owner\/repo/);
  assert.match(calls[1][1][3], /repo:owner\/repo/);
  assert.doesNotMatch(calls[2][1][3], /repo:owner\/repo/);
  assert.match(calls[3][1][3], /assignee:@me/);
  await assert.rejects(() => prs({ gh: null }, run), /no GitHub remote/);
  await assert.rejects(() => issues({ gh: null }, run), /no GitHub remote/);
});

test('a PR\'s or issue\'s details are fetched by its URL, passed as a variable, not in the query', async () => {
  const calls = [];
  const run = (resource) => async (cmd, args) => { calls.push([cmd, args]); return { data: { viewer: { login: 'me' }, resource } }; };
  const url = 'https://github.com/o/r/pull/3"){ x }';
  assert.deepEqual(await details(url, run({ __typename: 'PullRequest', number: 3 })), { __typename: 'PullRequest', number: 3, viewer: 'me' });
  const [cmd, args] = calls[0];
  assert.equal(cmd, 'gh');
  assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '-f']);
  assert.equal(args[3], `query=${detailQuery}`);
  assert.deepEqual(args.slice(4), ['-f', `url=${url}`]);
  assert.match(detailQuery, /query\(\$url: URI!\)/);
  assert.match(detailQuery, /reviewThreads\(first: 100\) \{ totalCount nodes \{\s+isResolved/);
  assert.equal((await details('u', run({ __typename: 'Issue', number: 7 }))).number, 7);
  await assert.rejects(() => details('https://github.com/o/r', run(null)), /GitHub has no PR or issue at https:\/\/github.com\/o\/r/);
  await assert.rejects(() => details('https://github.com/o', run({ __typename: 'User' })), /no PR or issue/);
});

const me = { login: 'me', __typename: 'User' }, ann = { login: 'ann', __typename: 'User' }, bot = { login: 'copilot', __typename: 'Bot' };
const thread = (author, isResolved = false) => ({ isResolved, comments: { nodes: [{ author, createdAt: '2026-01-01T00:00:00Z' }] } });
const said = (author, day) => ({ author, createdAt: `2026-01-0${day}T00:00:00Z` });
const review = (author, day, state = 'COMMENTED', inline = 0) => ({ author, state, submittedAt: `2026-01-0${day}T00:00:00Z`, comments: { totalCount: inline } });
const activity = ({ threads = [], reviews = [], comments = [], commit = 5 }) => ({
  reviewThreads: { nodes: threads }, reviews: { nodes: reviews }, comments: { nodes: comments },
  commits: { nodes: [{ commit: { committedDate: `2026-01-0${commit}T00:00:00Z` } }] },
});

test('a reply waits on you in an unresolved thread where someone else has the last word, or after your last move', () => {
  // threads: open with theirs last, resolved, open with yours last, a bot's, and one with no comments
  assert.equal(replies(activity({ threads: [thread(ann), thread(ann, true), thread(me), thread(bot), { isResolved: false, comments: { nodes: [] } }] }), 'me'), 1);
  // comments and reviews count after your last commit (day 5), comment or review, and not a bot's
  assert.equal(replies(activity({ comments: [said(ann, 4), said(ann, 6), said(bot, 7)] }), 'me'), 1);
  assert.equal(replies(activity({ comments: [said(ann, 6), said(me, 7)] }), 'me'), 0);
  assert.equal(replies(activity({ comments: [said(ann, 6)], reviews: [review(me, 7)] }), 'me'), 0);
  // a deleted account's comment counts
  assert.equal(replies(activity({ comments: [said(null, 6)] }), 'me'), 1);
  // reviews: changes and comments count, approvals don't, and inline comments count through their threads
  assert.equal(replies(activity({ reviews: [review(ann, 6, 'CHANGES_REQUESTED'), review(ann, 6), review(ann, 6, 'APPROVED'), review(ann, 6, 'COMMENTED', 2)] }), 'me'), 2);
  assert.equal(replies(activity({ commit: 8, reviews: [review(ann, 6, 'CHANGES_REQUESTED')] }), 'me'), 0);
  // without knowing who you are, nothing counts
  assert.equal(replies(activity({ threads: [thread(ann)] }), undefined), 0);
});

test('your PRs keep only their count of replies; review requests fetch none', async () => {
  let query;
  const run = async (cmd, args) => {
    query = args[3];
    return { data: {
      viewer: { login: 'me' },
      mine: { issueCount: 1, nodes: [{ number: 1, title: 't', ...activity({ threads: [thread(ann), thread(ann)] }) }] },
      review: { issueCount: 1, nodes: [{ number: 2, title: 'u', commits: { nodes: [] } }] },
    } };
  };
  const d = await prs(null, run);
  assert.match(query, /viewer \{ login \}/);
  assert.match(query, /mine: search\([^)]*\) \{ issueCount nodes \{ \.\.\.pr \.\.\.replies \} \}/);
  assert.match(query, /review: search\([^)]*\) \{ issueCount nodes \{ \.\.\.pr \} \}/);
  assert.deepEqual(Object.keys(d.mine.nodes[0]), ['number', 'title', 'commits', 'status', 'replies']);
  assert.equal(d.mine.nodes[0].replies, 2);
  assert.deepEqual(d.review.nodes[0], { number: 2, title: 'u', commits: { nodes: [] }, status: 'review' });
});

test('the pane\'s Rex status is blocked, with a base64 message, while replies wait on you', () => {
  assert.equal(paneName(0), '\x1b]2;Rex Dash\x07\x1b]7501;state=idle:id=rex-dash:app=rex\x07');
  const status = (n) => paneName(n).match(/7501;state=(\w+):id=rex-dash:app=rex(?::msg=([^\x07]+))?\x07$/);
  assert.equal(status(2)[1], 'blocked');
  assert.equal(Buffer.from(status(2)[2], 'base64').toString(), '2 PRs need your reply');
  assert.equal(Buffer.from(status(1)[2], 'base64').toString(), '1 PR needs your reply');
});

test('wt takes and restores the terminal on success, failure, and missing executable', async () => {
  for (const outcome of [0, 7, 'ENOENT']) {
    const stdin = new EventEmitter(), writes = [], modes = [], handoff = [];
    stdin.setRawMode = (mode) => { modes.push(mode); return stdin; };
    stdin.pause = stdin.resume = () => stdin;
    const stdout = { write: (text) => writes.push(text) };
    const spawned = [];
    const spawnCommand = (cmd, args, options) => {
      spawned.push([cmd, args, options]);
      const child = new EventEmitter();
      process.nextTick(() => {
        if (outcome === 'ENOENT') child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
        else {
          child.emit('exit', outcome, null);
          if (outcome) setImmediate(() => stdin.emit('data', Buffer.from(' ')));
        }
      });
      return child;
    };
    const result = await runWorktree('pr', 42, { stdin, stdout, spawnCommand, onHandoff: (value) => handoff.push(value) });
    assert.deepEqual(spawned, [['wt', ['pr', '42'], { stdio: 'inherit' }]]);
    assert.deepEqual(handoff, [true, false]);
    assert.equal(writes[0], '\x1b[0m\x1b[?25h\x1b[?1049l');
    assert.equal(writes.at(-1), '\x1b[?1049h\x1b[?25l');
    assert.equal(modes.at(-1), true);
    if (outcome === 'ENOENT') assert.equal(result.error.code, 'ENOENT');
    else assert.equal(result.code, outcome);
    if (outcome === 7) assert.ok(writes.some((text) => text.includes('press a key')));
  }
});

// A terminal for wt, and a wt that ends as outcome says, after doing what act does with its options.
function fakeTerminal() {
  const stdin = new EventEmitter();
  stdin.setRawMode = () => stdin;
  stdin.pause = stdin.resume = () => stdin;
  return { stdin, stdout: { write() {} } };
}
const fakeWt = (stdin, outcome, act = () => {}) => (cmd, args, options) => {
  const child = new EventEmitter();
  process.nextTick(() => {
    act(options);
    child.emit('exit', outcome, null);
    if (outcome) setImmediate(() => stdin.emit('data', Buffer.from(' ')));
  });
  return child;
};

test('wt hands the worktree back through WT_OPEN_COMMAND, with no path or branch in a command', async () => {
  const { stdin, stdout } = fakeTerminal(), seen = [];
  const worktree = "/tmp/it's $(echo pwn) `id`; x", branch = '42-fix "it"';
  const opened = (options) => {
    seen.push(options);
    // what wt does with WT_MULTIPLEXER=command, once the worktree is ready
    execFileSync('sh', ['-c', options.env.WT_OPEN_COMMAND], { env: { ...options.env, WT_WORKTREE: worktree, WT_BRANCH: branch, WT_SESSION: 'r-42-fix-0123abcd', WT_COMMAND: 'claude' } });
  };
  const ready = await prepareWorktree('issue', 42, { stdin, stdout, spawnCommand: fakeWt(stdin, 0, opened) });
  assert.deepEqual(ready, { end: { code: 0, signal: null }, worktree: { path: worktree, branch, session: 'r-42-fix-0123abcd' } });
  const { env, stdio } = seen[0];
  assert.equal(stdio, 'inherit');
  assert.equal(env.WT_MULTIPLEXER, 'command');
  assert.equal(env.PATH, process.env.PATH);
  assert.ok(!fs.existsSync(env.REX_DASH_HANDOFF)); // cleaned up

  // a cancelled branch prompt: wt exits 0 without opening anything
  assert.deepEqual(await prepareWorktree('issue', 42, { stdin, stdout, spawnCommand: fakeWt(stdin, 0) }), { end: { code: 0, signal: null }, worktree: null });
  // a failed setup: wt says why, and the dashboard waits for a key
  assert.equal((await prepareWorktree('pr', 7, { stdin, stdout, spawnCommand: fakeWt(stdin, 3, opened) })).worktree, null);
});

test('withEnv passes values to the command as data, however they are quoted', () => {
  const vars = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`V${i + 1}`, `v${i + 1}`]));
  Object.assign(vars, { V1: '$(echo pwn)', V2: "it's \"quoted\"", V3: 'a;b && c', V4: '`id`', V5: '', V6: 'line\nbreak' });
  const argv = withEnv(vars, 'printf "%s|" "$V1" "$V2" "$V3" "$V4" "$V5" "$V6" "$V9" "$V10"');
  assert.equal(argv[0], '/bin/sh');
  assert.ok(!argv[2].includes('pwn')); // the script is fixed
  assert.equal(execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' }),
    "$(echo pwn)|it's \"quoted\"|a;b && c|`id`||line\nbreak|v9|v10|");
  assert.throws(() => withEnv({ 'A;B': 'x' }, 'true'), /bad variable name/);
});

test('openTab adds a background window to the worktree session, or creates the session, without showing it', async () => {
  const argv = ['/bin/sh', '-c', 'claude'];
  const call = (sessions, created = {}) => {
    const calls = [];
    const io = {
      runJson: async (cmd, args) => { calls.push(args); return args[0] === 'ls' ? { sessions } : created; },
      run: async (cmd, args) => { calls.push(args); },
    };
    return { calls, io };
  };

  let t = call([{ session_id: 's1', label: 'r-7-fix-abc' }, { session_id: 's2', label: 'other' }], { window_id: 'w9' });
  assert.deepEqual(await openTab({ sessionLabel: 'r-7-fix-abc', name: 'agent #7', cwd: '/r/7-fix', argv }, t.io), { sessionId: 's1', windowId: 'w9' });
  assert.deepEqual(t.calls, [
    ['ls', '--json'],
    ['window', 'new', '-s', 's1', 'agent #7', '-c', '/r/7-fix', '--keep-open', '--focus=false', '--json', '--', ...argv],
  ]);

  t = call([], { session_id: 'new', initial_windows: [{ window_id: 'w1' }] });
  assert.deepEqual(await openTab({ sessionLabel: 'r-7-fix-abc', name: 'agent #7', cwd: '/r/7-fix', argv, keepOpen: false }, t.io), { sessionId: 'new', windowId: 'w1' });
  assert.deepEqual(t.calls, [['ls', '--json'], ['new', 'r-7-fix-abc', '-c', '/r/7-fix', '--window', 'agent #7', '--json', '--', ...argv]]);

  t = call([], {}); // rex new may have started it: never make another
  await assert.rejects(() => openTab({ sessionLabel: 'r-7', name: 'n', cwd: '/', argv }, t.io), /can't read rex new's response/);
  assert.equal(t.calls.length, 2);

  t = call([{ session_id: 's1', label: 'r-7' }, { session_id: 's3', label: 'r-7' }]);
  await assert.rejects(() => openTab({ sessionLabel: 'r-7', name: 'n', cwd: '/', argv }, t.io), /several sessions are labelled r-7: s1, s3/);

  // this session, shown
  t = call([], { window_id: 'w2' });
  await openTab({ sessionId: 'here', name: 'agent #7', cwd: '/r/7-fix', argv, background: false }, t.io);
  assert.deepEqual(t.calls, [
    ['window', 'new', '-s', 'here', 'agent #7', '-c', '/r/7-fix', '--keep-open', '--focus=false', '--json', '--', ...argv],
    ['do', 'session.select', 'session_id=here', 'window_id=w2'],
  ]);
});

test('a PR\'s status: merged, closed, draft, then its review decision, or its latest reviews without bots\' when it has none', () => {
  const reviews = (...states) => ({ nodes: states.map(([state, bot]) => ({ state, author: { __typename: bot ? 'Bot' : 'User' } })) });
  assert.equal(prStatus({ state: 'MERGED', isDraft: true }), 'merged');
  assert.equal(prStatus({ state: 'CLOSED' }), 'closed');
  assert.equal(prStatus({ state: 'OPEN', isDraft: true, reviewDecision: 'APPROVED' }), 'draft');
  assert.equal(prStatus({ reviewDecision: 'CHANGES_REQUESTED' }), 'changes');
  assert.equal(prStatus({ reviewDecision: 'APPROVED' }), 'approved');
  assert.equal(prStatus({ reviewDecision: 'REVIEW_REQUIRED', latestOpinionatedReviews: reviews(['APPROVED']) }), 'review'); // needs more approvals
  // a stacked PR's base isn't protected, so it has no review decision: its reviews decide
  assert.equal(prStatus({ reviewDecision: null, latestOpinionatedReviews: reviews(['APPROVED'], ['APPROVED', true]) }), 'approved');
  assert.equal(prStatus({ reviewDecision: null, latestOpinionatedReviews: reviews(['APPROVED'], ['CHANGES_REQUESTED']) }), 'changes');
  assert.equal(prStatus({ reviewDecision: null, latestOpinionatedReviews: reviews(['APPROVED', true]) }), 'review'); // a bot's approval
  assert.equal(prStatus({}), 'review');
});

test('PRs and their pages ask where they are in a stack, and ask again without it where GitHub has no stacks', async () => {
  const queries = [];
  const run = async (cmd, args) => {
    queries.push(args[3]);
    if (queries.length === 1) throw new Error("gh: Field 'stack' doesn't exist on type 'PullRequest'");
    return { data: { mine: { nodes: [] }, review: { nodes: [{ number: 2, reviewDecision: null, latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: {} }] } }] } } };
  };
  assert.ok(detailQuery.includes(STACK_REFS));
  try {
    const d = await prs(null, run);
    assert.equal(queries.length, 2);
    assert.ok(queries[0].includes(STACK_REFS) && queries[0].includes('latestOpinionatedReviews(first: 10)'));
    assert.ok(!queries[1].includes('stack') && queries[1].includes('latestOpinionatedReviews'));
    assert.deepEqual(d.review.nodes[0], { number: 2, reviewDecision: null, status: 'approved' }); // the reviews go once they've decided
    assert.equal(support.stacks, false);
    await details('u', async (cmd, args) => { queries.push(args[3]); return { data: { resource: { __typename: 'PullRequest' } } }; });
    assert.ok(!queries[2].includes('stack')); // and from then on
    await assert.rejects(() => prs(null, async () => { throw new Error("Field 'stack' doesn't exist"); }), /doesn't exist/); // once
  } finally { support.stacks = true; }
  await assert.rejects(() => prs(null, async () => { throw new Error('HTTP 502'); }), /502/);
  assert.equal(support.stacks, true);
});

// gh api -i's output: a status line ending in \n, headers ending in \r\n, a blank line, then the body.
const response = (status, headers = {}, body = '') => `HTTP/2.0 ${status}\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${body}`;
const restStack = (number, open, prs) => ({
  number, node_id: `S${number}`, url: `https://api.github.com/repos/o/r/stacks/${number}`, base: { ref: 'main' }, open,
  pull_requests: prs.map(([n, state = 'open', merged = false, draft = false]) => ({ number: n, state, draft, merged_at: merged ? '2026-01-01T00:00:00Z' : null, head: { ref: `b${n}` } })),
});
test('a gh api -i response gives its status, headers and body', () => {
  assert.deepEqual(http(response('200 OK', { ETag: 'W/"x"', Link: '<u>; rel="next"' }, '[]')), { status: 200, headers: { etag: 'W/"x"', link: '<u>; rel="next"' }, body: '[]' });
  assert.deepEqual(http(response('304 Not Modified', { ETag: 'W/"x"' })), { status: 304, headers: { etag: 'W/"x"' }, body: '' });
  assert.equal(http('').status, 0);
});

test('a repo\'s open stacks come page by page, each with its ETag, and a page that hasn\'t changed comes from the cache', async () => {
  const calls = [];
  let pages = {
    1: response('200 OK', { ETag: '"e1"', Link: '<https://api.github.com/repositories/1/stacks?page=2>; rel="next"' }, JSON.stringify([restStack(9, true, [[7], [8, 'closed', true]]), restStack(5, false, [[4, 'closed', true]])])),
    2: response('200 OK', { ETag: '"e2"' }, JSON.stringify([restStack(3, true, [[1, 'open', false, true], [2, 'closed']])])),
  };
  const run = async (cmd, args) => {
    calls.push(args);
    const page = args.at(-1).match(/page=(\d+)$/)[1];
    return { code: pages[page].startsWith('HTTP/2.0 200') ? 0 : 1, out: pages[page], err: '' };
  };
  const first = await stackList('o/r', null, run);
  assert.deepEqual(calls, [['api', '-i', 'repos/o/r/stacks?per_page=100&page=1'], ['api', '-i', 'repos/o/r/stacks?per_page=100&page=2']]);
  assert.deepEqual(first.map((p) => p.stacks.map((s) => s.number)), [[9], [3]]); // closed stack 5 left out
  assert.deepEqual(first[0].stacks[0], {
    id: 'S9', number: 9, repo: 'r', base: 'main', url: 'https://github.com/o/r/stack/9',
    members: [{ number: 7, state: 'OPEN', isDraft: false, head: 'b7' }, { number: 8, state: 'MERGED', isDraft: false, head: 'b8' }],
  });
  assert.deepEqual(first[1].stacks[0].members.map((m) => [m.state, m.isDraft]), [['OPEN', true], ['CLOSED', false]]);

  // the second time, each page goes with its ETag; an unchanged one is a 304, which gh exits 1 on
  calls.length = 0;
  pages = { 1: pages[1], 2: response('304 Not Modified', { ETag: '"e2"' }) };
  pages[1] = pages[1].replace('"e1"', '"e1b"');
  const second = await stackList('o/r', { pages: first }, run);
  assert.deepEqual(calls.map((a) => a.slice(2, 4)), [['-H', 'If-None-Match: "e1"'], ['-H', 'If-None-Match: "e2"']]);
  assert.equal(second[0].etag, '"e1b"');
  assert.equal(second[1], first[1]);

  // a server without stacks has none; another failure says why
  assert.deepEqual(await stackList('o/r', null, async () => ({ code: 1, out: response('404 Not Found'), err: 'gh: Not Found (HTTP 404)\n' })), []);
  await assert.rejects(() => stackList('o/r', null, async () => ({ code: 1, out: response('500 Server Error'), err: 'gh: Server Error (HTTP 500)\n' })), /^Error: gh: Server Error \(HTTP 500\)$/);
});

test('a stack\'s PRs come from your PRs and review requests, or a cache of merged and closed ones, and only the rest are fetched', async () => {
  const pr = (number, state = 'OPEN') => ({ number, state, title: `pr ${number}`, repository: { name: 'r' }, reviewDecision: 'APPROVED' });
  const list = [restStack(9, true, [[1], [2], [3, 'closed', true], [4, 'closed'], [5]])];
  const raw = async () => ({ code: 0, out: response('200 OK', { ETag: '"e"' }, JSON.stringify(list)), err: '' });
  let asked = [];
  const runJson = async (cmd, args) => {
    asked.push(args);
    const ns = [...args[3].matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => +m[1]);
    return { data: { repository: Object.fromEntries(ns.map((n) => [`p${n}`, { ...pr(n, n === 3 ? 'MERGED' : n === 4 ? 'CLOSED' : 'OPEN'), latestOpinionatedReviews: { nodes: [] } }])) } };
  };
  const listed = { mine: { nodes: [pr(1)] }, review: { nodes: [{ ...pr(2), repository: { name: 'other' } }] } };
  const repo = { gh: 'o/r' };
  const first = await stacks(repo, { prs: listed }, raw, runJson);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].slice(4), ['-f', 'owner=o', '-f', 'name=r']);
  assert.deepEqual([...asked[0][3].matchAll(/p(\d+): pullRequest/g)].map((m) => +m[1]), [2, 3, 4, 5]); // 1 is yours; 2 is another repo's
  assert.deepEqual(Object.keys(first.prs), ['2', '3', '4', '5']);
  assert.equal(first.prs[5].status, 'approved');
  assert.ok(!('latestOpinionatedReviews' in first.prs[5]));

  // the merged and closed ones are kept, the open ones fetched again
  asked = [];
  const second = await stacks(repo, { prs: listed, cached: first }, raw, runJson);
  assert.deepEqual([...asked[0][3].matchAll(/p(\d+): pullRequest/g)].map((m) => +m[1]), [2, 5]);
  assert.equal(second.prs[3], first.prs[3]);

  // a failed fetch keeps the PRs fetched before, and says why; nothing to fetch, no fetch
  const failed = await stacks(repo, { prs: listed, cached: first }, raw, async () => { throw new Error('HTTP 502\nmore'); });
  assert.deepEqual(failed.prs, first.prs);
  assert.equal(failed.err, 'HTTP 502');
  asked = [];
  await stacks(repo, { prs: { mine: { nodes: [1, 2, 5].map((n) => pr(n)) } }, cached: first }, raw, runJson);
  assert.deepEqual(asked, []);
  await assert.rejects(() => stacks({ gh: null }, {}, raw, runJson), /no GitHub remote/);
  await assert.rejects(() => stackMembers('o/r', [1, '2) { x }'], runJson), /positive integers/);
});

test('one stack is fetched by its id, passed as a variable, in the shape the repo\'s stacks have', async () => {
  let args;
  const entry = (position, number, state = 'OPEN') => ({ position, pullRequest: { number, state, isDraft: false, title: `pr ${number}`, url: `https://ghe.x/o/r/pull/${number}`, repository: { name: 'r' }, headRefName: `b${number}`, reviewDecision: null, latestOpinionatedReviews: { nodes: [] } } });
  const d = await stack('S9") { x }', async (cmd, a) => {
    args = a;
    return { data: { node: { id: 'S9', number: 9, baseRefName: 'main', entries: { nodes: [entry(2, 8, 'MERGED'), entry(1, 7)] } } } };
  });
  assert.deepEqual(args.slice(4), ['-f', 'id=S9") { x }']);
  assert.match(args[3], /^query=query\(\$id: ID!\)/);
  assert.deepEqual(d.pages[0].stacks[0], {
    id: 'S9', number: 9, repo: 'r', base: 'main', url: 'https://ghe.x/o/r/stack/9',
    members: [{ number: 7, state: 'OPEN', isDraft: false, head: 'b7' }, { number: 8, state: 'MERGED', isDraft: false, head: 'b8' }],
  });
  assert.deepEqual(Object.values(d.prs).map((p) => [p.number, p.status, 'headRefName' in p]), [[7, 'review', false], [8, 'merged', false]]);
  await assert.rejects(() => stack('S1', async () => ({ data: { node: null } })), /no such stack/);
});
