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
  assert.deepEqual(fit([...rows], 8), ['title', 'keys', BAND, 'b', 'c', `${MARK}x`, 'y']);
  assert.deepEqual(fit([...rows], 6), ['title', 'keys', BAND, `${MARK}x`, 'y']);
  repo = { roots: ['/r'] };
  assert.ok(vis(sections.renderIssues({ issueCount: 1, nodes: [issue()] })[0]).includes('1 open'));
});
