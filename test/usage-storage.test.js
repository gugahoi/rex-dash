'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseUsage, aggregate, cacheRows, createUsage } = require('../lib/usage');
const { cacheKey, createCache, CACHE_VERSION } = require('../lib/storage');
const { within, inRepo, detectRepo } = require('../lib/repo');
const { sh } = require('../lib/utils');

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const line = (id, cwd, ts = '2026-11-01T01:00:00Z') => JSON.stringify({ timestamp: ts, cwd, message: { id, model: 'claude-x', usage: { input_tokens: 1, output_tokens: 2 } } });

test('transcript parser deduplicates messages and aggregates only the last 30 days in scope', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const rows = parseUsage([line('a', '/r/a'), line('a', '/r/a'), line('b', '/r/b'), line('old', '/r/a', '2026-01-01T01:00:00Z'), 'not json "usage"'].join('\n'));
  assert.deepEqual(aggregate([rows], now, (cwd) => cwd === '/r/a').models, [['claude-x', 3, 2]]);
  assert.deepEqual(aggregate([rows], now).models, [['claude-x', 6, 4]]);
  assert.equal(aggregate([rows], now).daily.at(-1), 6);
  assert.deepEqual(cacheRows(rows, '2026-10-03', (cwd) => cwd === '/r/a'), [rows[0]]);
});

test('worktrees share a cache; cached JSON retains its version and invalid files are ignored', (t) => {
  const dir = temp(t);
  const first = cacheKey({ roots: ['/r/wt', '/r/wt/main'] });
  assert.equal(first, cacheKey({ roots: ['/r/wt', '/r/wt/other'] }));
  assert.notEqual(first, cacheKey({ roots: ['/s/wt'] }));
  assert.equal(cacheKey(null), 'all');
  const cache = createCache({ roots: ['/r/wt'] }, dir);
  cache.write('state.json', { gh: 'o/r', state: { fleet: [] } });
  assert.deepEqual(cache.read('state.json'), { version: CACHE_VERSION, gh: 'o/r', state: { fleet: [] } });
  fs.writeFileSync(path.join(cache.dir, 'old.json'), '{"version":0}');
  assert.equal(cache.read('old.json'), null);
  assert.equal(cache.read('../missing.json'), null);
});

test('repo scope respects path boundaries; git detection handles a bare-plus-worktrees layout', async (t) => {
  assert.deepEqual(['/r/wt', '/r/wt/main', '/r/wt-other', undefined].map((p) => inRepo({ roots: ['/r/wt'] }, p)), [true, true, false, false]);
  assert.ok(within(['/r/wt'], '/r/wt/child'));
  assert.ok(inRepo(null, '/anywhere'));
  const dir = temp(t), bare = path.join(dir, '.bare');
  await sh('git', ['init', '--bare', bare]);
  const repo = await detectRepo(bare);
  assert.deepEqual(repo.roots, [fs.realpathSync(dir)]);
  assert.equal(await detectRepo(path.join(dir, 'missing')), null);
});

test('usage cache reuses unchanged transcripts but rescan is required when the repo gains another root', (t) => {
  const dir = temp(t), projects = path.join(dir, 'projects'), log = path.join(projects, 'p', 's.jsonl');
  const cache = createCache({ roots: ['/r/a'] }, path.join(dir, 'cache'));
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const today = new Date().toISOString();
  fs.writeFileSync(log, [line('p', '/r/a', today), line('q', '/r/b', today)].join('\n'));
  const at = Math.floor(Date.now() / 1000);
  fs.utimesSync(log, at, at);
  assert.deepEqual(createUsage({ roots: ['/r/a'] }, cache, projects)().models, [['claude-x', 3, 2]]);
  fs.writeFileSync(log, '');
  fs.utimesSync(log, at, at);
  assert.deepEqual(createUsage({ roots: ['/r/a'] }, cache, projects)().models, [['claude-x', 3, 2]]);
  assert.deepEqual(createUsage({ roots: ['/r/a', '/r/b'] }, cache, projects)().models, []);
});
