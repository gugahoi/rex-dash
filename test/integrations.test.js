'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { fleet, focusPane, withEnv, openTab } = require('../lib/integrations/rex');
const { prs, issues } = require('../lib/integrations/github');
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
