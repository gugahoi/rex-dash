'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HOME } = require('./utils');

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'rex-dash');
const CACHE_VERSION = 1;
const SETTINGS = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'), 'rex-dash', 'settings.json');
// All worktrees of a repo list the same first root, and therefore share a cache.
const cacheKey = (repo) => !repo ? 'all'
  : `${path.basename(repo.roots[0]).replace(/[^\w.-]/g, '_')}-${crypto.createHash('sha1').update(repo.roots[0]).digest('hex').slice(0, 8)}`;

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
// Atomic rename prevents two dashboards from leaving a partially written cache.
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch { fs.rmSync(tmp, { force: true }); }
}
function createCache(repo, base = CACHE) {
  const dir = path.join(base, cacheKey(repo));
  return {
    dir,
    read(name) {
      const c = readJSON(path.join(dir, name));
      return c?.version === CACHE_VERSION ? c : null;
    },
    write(name, data) { writeJSON(path.join(dir, name), { version: CACHE_VERSION, ...data }); },
  };
}
module.exports = { CACHE_VERSION, SETTINGS, cacheKey, readJSON, writeJSON, createCache };
