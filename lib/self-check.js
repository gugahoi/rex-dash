'use strict';
const assert = require('node:assert/strict');
const { parseUsage, aggregate } = require('./usage');
const { createFilter } = require('./ui/filter');
const { createEffects } = require('./ui/effects');
const { vis, red } = require('./utils');
const { createApp } = require('./app');
const { parseConfig } = require('./config');
const { renderDetail } = require('./ui/detail');
const { joinStacks, summary } = require('./ui/stacks');

// Runs in the installed Homebrew tree without Rex, gh, wt, or test fixtures.
function run() {
  const line = JSON.stringify({ timestamp: '2026-11-01T01:00:00Z', message: { id: 'm', model: 'claude-x', usage: { input_tokens: 2, output_tokens: 3 } } });
  assert.deepEqual(aggregate([parseUsage(line)], Date.parse('2026-11-01T12:00:00Z')).models, [['claude-x', 5, 3]]);
  const filter = createFilter();
  filter.setQuery('fx lg');
  assert.ok(filter.match('fix login') && !filter.match('fix issue'));
  const effects = createEffects({ once: true });
  assert.equal(effects.fx.shader, 'off');
  assert.equal(vis(effects.paint(red('hello'), 0, 3, 0)), 'he\x1b[K');
  assert.ok(createApp({ once: true }).frame().some((row) => row.includes('FLEET')));
  assert.equal(parseConfig({ keymaps: { a: { command: 'claude' } } }).keymaps.get('a').label, 'claude');
  assert.deepEqual(renderDetail({ kind: 'issue', key: 'r#1', item: { title: 'fix it' } }, 40).map(vis), ['', 'ISSUE r#1  ', '  fix it', '  asking GitHub…']);
  const stack = { number: 9, repo: 'r', members: [{ number: 1, state: 'MERGED' }, { number: 2, state: 'OPEN', isDraft: true }] };
  assert.deepEqual(summary(joinStacks({ pages: [{ stacks: [stack] }] })[0]).parts.map(vis), ['0/2 approved', '1 draft', '1 merged']);
  console.log('ok');
}
module.exports = { run };
