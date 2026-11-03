'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fleet, focusPane } = require('../lib/integrations/rex');
const { prs, issues } = require('../lib/integrations/github');
const { runWorktree } = require('../lib/integrations/wt');

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
