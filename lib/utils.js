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

const firstLine = (e) => String(e.message || e).trim().split('\n')[0];
module.exports = { HOME, PROJECTS, DAYS, sh, json, dim, bold, red, green, yellow, blue, magenta, cyan, ANSI, vis, pad, plain, tilde, fmt, ago, clip, firstLine };
