'use strict';
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const DAYS = 30;

// ---- helpers
const sh = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 64 << 20, ...opts }, (err, out, errOut) => err ? reject(new Error(errOut || err.message)) : resolve(out)));
const json = async (cmd, args) => JSON.parse(await sh(cmd, args));
// A command's exit code and output, even when it exits non-zero, as gh api does on a 304. Only a command that
// can't start, or is killed, rejects.
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 64 << 20, ...opts }, (err, out, errOut) =>
    (err && typeof err.code !== 'number' ? reject(err) : resolve({ code: err ? err.code : 0, out, err: errOut }))));

const style = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const [dim, bold, red, green, yellow, blue, magenta, cyan] = [2, 1, 31, 32, 33, 34, 35, 36].map(style);
const ANSI = /(\x1b\[[0-9;]*m)/;
const vis = (s) => s.split(ANSI).filter((p) => !ANSI.test(p)).join('').replace(/[\x01\x02]/g, '');
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - vis(s).length));
// Text from programs and GitHub. Stripping control characters also keeps it
// from forging the \x01..\x04 markers paint() reads.
const plain = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const tilde = (p) => plain(p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p || '');
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const ago = (t) => {
  const s = Math.max(0, ((Date.now() - new Date(t)) / 1000) | 0);
  return s < 60 ? `${s}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`;
};

// Cut a styled line to w visible columns, keeping its escape codes.
function clip(s, w) {
  let out = '', n = 0;
  for (const part of s.split(ANSI)) {
    if (ANSI.test(part)) { out += part; continue; }
    for (const ch of part) {
      if (n >= w) return out + '\x1b[0m';
      out += ch; n++;
    }
  }
  return out;
}

// The columns a character takes: two for emoji and East Asian wide characters, none for combining marks, joiners
// and variation selectors.
const WIDE = /\p{Emoji_Presentation}|[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const ZERO = /[\p{Mn}\p{Me}\u200b-\u200f\ufe00-\ufe0f]/u;
const charCols = (ch) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1);
const cols = (s) => { let n = 0; for (const ch of s) n += charCols(ch); return n; };

// The visible columns [from, to) of a styled line. It keeps the escape codes before from, so the slice starts in
// the style the line has there. A shaded() run cut at either end is opened or closed again, so paint() still
// pairs its markers, and half of a wide character is a space. A run opens at its first character in the slice,
// and closes as it ends, before any escape code: paint() colours what's inside character by character.
function sliceCols(s, from, to = Infinity) {
  let out = '', n = 0, run = false, open = false, styled = false;
  const put = (text) => {
    if (run && !open) { out += '\x01'; open = true; }
    out += text;
  };
  for (const part of s.split(ANSI)) {
    if (ANSI.test(part)) { if (n < to) { out += part; styled = true; } continue; }
    for (const ch of part) {
      if (ch === '\x01') { run = true; continue; }
      if (ch === '\x02') { run = false; if (open) out += '\x02'; open = false; continue; }
      const c = charCols(ch);
      if (!c) { if (n > from && n <= to) put(ch); continue; }
      if (n + c > from && n < to) put(n < from || n + c > to ? ' '.repeat(Math.min(n + c, to) - Math.max(n, from)) : ch);
      n += c;
    }
  }
  if (open) out += '\x02';
  return styled ? out + '\x1b[0m' : out;
}

const firstLine = (e) => String(e.message || e).trim().split('\n')[0];
module.exports = {
  HOME, PROJECTS, DAYS, sh, json, run, dim, bold, red, green, yellow, blue, magenta, cyan, ANSI, vis, pad, plain, tilde, fmt, ago, clip,
  charCols, cols, sliceCols, firstLine,
};
