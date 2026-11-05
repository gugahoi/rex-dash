'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HOME } = require('./utils');

// The user's own settings, beside wt's: what the dashboard writes itself is in storage.js.
const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'rex-dash', 'config.json');
// The dashboard's own keys (press() in app.js). Enter, Esc, the arrows and Ctrl keys aren't printable, so
// they can't be mapped anyway.
const BUILT_IN = [...'jkoqrse/'];
const KINDS = ['issue', 'pr'];
const SESSIONS = ['worktree', 'current'];
const FIELDS = ['command', 'label', 'on', 'background', 'keep_open', 'session'];

const isText = (s) => typeof s === 'string' && s.trim() !== '' && !s.includes('\0'); // argv can't carry NUL

// One keymap, or why it's wrong. command is a shell snippet, for every kind or one per kind ({issue, pr});
// on narrows the kinds; label names it in the key bar and its tabs. A keymap opens its tab in the background,
// kept open after the command exits, in the worktree's session (the one wt opens), unless it says otherwise.
function keymap(key, v) {
  if ([...key].length !== 1 || /[\s\x00-\x1f\x7f-\x9f]/.test(key)) return { error: `"${key}" isn't a single printable character` };
  if (BUILT_IN.includes(key)) return { error: `"${key}" is one of the dashboard's own keys` };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `"${key}" needs an object with a command` };
  const unknown = Object.keys(v).find((f) => !FIELDS.includes(f));
  if (unknown) return { error: `"${key}" has an unknown field "${unknown}"` };
  let commands;
  if (isText(v.command)) commands = Object.fromEntries(KINDS.map((k) => [k, v.command]));
  else if (v.command && typeof v.command === 'object' && !Array.isArray(v.command)) {
    const bad = Object.keys(v.command).find((k) => !KINDS.includes(k) || !isText(v.command[k]));
    if (bad || !Object.keys(v.command).length) return { error: `"${key}": command's keys are issue and pr, each a non-empty command` };
    commands = { ...v.command };
  } else return { error: `"${key}" needs a non-empty command` };
  let on = Object.keys(commands);
  if (v.on !== undefined) {
    if (!Array.isArray(v.on) || !v.on.length || v.on.some((k) => !KINDS.includes(k))) return { error: `"${key}": on is a list of issue and pr` };
    const missing = v.on.find((k) => !commands[k]);
    if (missing) return { error: `"${key}" is on ${missing} but has no command for it` };
    on = KINDS.filter((k) => v.on.includes(k));
  }
  if (v.label !== undefined && !isText(v.label)) return { error: `"${key}": label is non-empty text` };
  for (const f of ['background', 'keep_open']) if (v[f] !== undefined && typeof v[f] !== 'boolean') return { error: `"${key}": ${f} is true or false` };
  if (v.session !== undefined && !SESSIONS.includes(v.session)) return { error: `"${key}": session is "worktree" or "current"` };
  return {
    keymap: {
      key, on, commands: Object.fromEntries(on.map((k) => [k, commands[k]])),
      label: v.label?.trim() || commands[on[0]].trim().split(/\s+/)[0], // the program, by default
      background: v.background ?? true, keepOpen: v.keep_open ?? true, session: v.session ?? 'worktree',
    },
  };
}

// The config as JSON, checked. Keymaps that are wrong are left out and reported; the others still work.
function parseConfig(data) {
  const keymaps = new Map(), errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { keymaps, errors: ['the config is a JSON object'] };
  for (const f of Object.keys(data)) if (f !== 'keymaps') errors.push(`unknown field "${f}"`);
  const maps = data.keymaps ?? {};
  if (!maps || typeof maps !== 'object' || Array.isArray(maps)) return { keymaps, errors: [...errors, 'keymaps is an object of keys'] };
  for (const [key, v] of Object.entries(maps)) {
    const r = keymap(key, v);
    if (r.error) errors.push(`keymaps ${r.error}`);
    else keymaps.set(key, r.keymap);
  }
  return { keymaps, errors };
}

// No file is no keymaps. A file that can't be read or parsed is reported, never fatal.
function loadConfig(file = CONFIG) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? parseConfig({}) : { keymaps: new Map(), errors: [`can't read ${file}: ${e.code || e.message}`] };
  }
  try { return parseConfig(JSON.parse(text)); } catch (e) { return { keymaps: new Map(), errors: [`${path.basename(file)}: ${e.message}`] }; }
}

module.exports = { CONFIG, BUILT_IN, parseConfig, loadConfig };
