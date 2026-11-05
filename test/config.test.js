'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseConfig, loadConfig, BUILT_IN } = require('../lib/config');

test('keymaps take a command for both kinds or per kind, with background tabs in the worktree session by default', () => {
  const { keymaps, errors } = parseConfig({
    keymaps: {
      a: { label: 'agent', command: { issue: 'claude "fix $REX_DASH_NUMBER"', pr: 'claude "review $REX_DASH_NUMBER"' } },
      R: { command: '  claude -p "/review $REX_DASH_NUMBER"', on: ['pr'], background: false, keep_open: false, session: 'current' },
      i: { command: { issue: 'pi' } },
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(keymaps.get('a'), {
    key: 'a', on: ['issue', 'pr'], label: 'agent', background: true, keepOpen: true, session: 'worktree',
    commands: { issue: 'claude "fix $REX_DASH_NUMBER"', pr: 'claude "review $REX_DASH_NUMBER"' },
  });
  assert.deepEqual(keymaps.get('R'), {
    key: 'R', on: ['pr'], label: 'claude', background: false, keepOpen: false, session: 'current',
    commands: { pr: '  claude -p "/review $REX_DASH_NUMBER"' },
  });
  assert.deepEqual(keymaps.get('i').on, ['issue']);
  assert.equal(keymaps.get('i').label, 'pi');
});

test('wrong keymaps are reported and left out, and the right ones still load', () => {
  const { keymaps, errors } = parseConfig({
    keymap: {},
    keymaps: {
      ok: { command: 'x' }, ' ': { command: 'x' }, '\x01': { command: 'x' }, j: { command: 'x' }, '/': { command: 'x' },
      a: 'claude', b: { command: '' }, c: { command: { issue: 'x', branch: 'y' } }, d: { command: { issue: 'x' }, on: ['pr'] },
      m: { command: 'x', on: ['agent'] }, f: { command: 'x', background: 'no' }, g: { command: 'x', session: 'new' },
      h: { command: 'x', focus: true }, i: { command: 'a\0b' }, l: { command: 'x', label: ' ' },
      '\u21e2': { command: 'x' },
    },
  });
  assert.deepEqual([...keymaps.keys()], ['\u21e2']); // one character, if not one byte
  assert.equal(errors.length, 16);
  for (const [i, pattern] of [
    /unknown field "keymap"/, /"ok" isn't a single/, /" " isn't a single/, /isn't a single/, /"j" is one of the dashboard's own keys/,
    /"\/" is one/, /"a" needs an object/, /"b" needs a non-empty command/, /"c": command's keys are issue and pr/,
    /"d" is on pr but has no command/, /"m": on is a list/, /"f": background is true or false/, /"g": session is/,
    /"h" has an unknown field "focus"/, /"i" needs a non-empty command/, /"l": label/,
  ].entries()) assert.match(errors[i], pattern);
  assert.deepEqual(parseConfig([]).errors, ['the config is a JSON object']);
  assert.deepEqual(parseConfig({ keymaps: [] }).errors, ['keymaps is an object of keys']);
  for (const key of 'jkoqrse/') assert.ok(BUILT_IN.includes(key));
});

test('a missing config is no keymaps, and an unreadable one is an error rather than a crash', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-dash-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  assert.deepEqual(loadConfig(file), { keymaps: new Map(), errors: [] });
  fs.writeFileSync(file, '{"keymaps": {"a": ');
  const broken = loadConfig(file);
  assert.equal(broken.keymaps.size, 0);
  assert.match(broken.errors[0], /^config\.json: /);
  fs.writeFileSync(file, JSON.stringify({ keymaps: { a: { command: 'claude' } } }));
  assert.equal(loadConfig(file).keymaps.get('a').label, 'claude');
  assert.match(loadConfig(dir).errors[0], /can't read/); // a folder
});
