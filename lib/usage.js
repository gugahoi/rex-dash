'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PROJECTS, DAYS } = require('./utils');
const { inRepo, within } = require('./repo');

function parseUsage(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message, u = m?.usage;
    if (!u || !m.model || m.model === '<synthetic>') continue;
    const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    rows.push([m.id || e.uuid, m.model, (e.timestamp || '').slice(0, 10), total, u.output_tokens || 0, e.cwd]);
  }
  return rows;
}

// A message with several content blocks repeats its usage on each line, so
// count each message id once. keep(folder) picks the sessions to count.
function aggregate(rowLists, now = Date.now(), keep = () => true) {
  const days = Array.from({ length: DAYS }, (_, i) => new Date(now - (DAYS - 1 - i) * 864e5).toISOString().slice(0, 10));
  const seen = new Set(), models = {}, daily = Object.fromEntries(days.map((d) => [d, 0]));
  for (const rows of rowLists) {
    for (const [id, model, day, total, out, cwd] of rows) {
      if (!(day in daily) || seen.has(id) || !keep(cwd)) continue;
      seen.add(id);
      const m = (models[model] ||= [model, 0, 0]);
      m[1] += total; m[2] += out;
      daily[day] += total;
    }
  }
  return { models: Object.values(models).sort((a, b) => b[1] - a[1]), daily: days.map((d) => daily[d]) };
}

// The rows of a transcript worth keeping: in the repo, not before the window's first day (which only
// moves on), and each message once. aggregate() counts the same rows from these as from all of them.
function cacheRows(rows, first, keep = () => true) {
  const seen = new Set();
  return rows.filter(([id, , day, , , cwd]) => day >= first && keep(cwd) && !seen.has(id) && seen.add(id));
}

function createUsage(repo, cache, dir = PROJECTS) {
  let transcripts = null;
  function usage() {
    const now = Date.now(), since = now - DAYS * 864e5, first = new Date(now - (DAYS - 1) * 864e5).toISOString().slice(0, 10);
    if (!transcripts) {
      const c = cache.read('transcripts.json');
      transcripts = new Map(c && (!repo || repo.roots.every((r) => within(c.roots || [], r))) ? Object.entries(c.files) : []);
    }
    const next = new Map(), lists = [];
    let reread = false;
    for (const rel of fs.readdirSync(dir, { recursive: true })) {
      if (!rel.endsWith('.jsonl')) continue;
      const file = path.join(dir, rel);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      let hit = transcripts.get(file);
      if (!hit || hit[0] !== st.mtimeMs) { hit = [st.mtimeMs, cacheRows(parseUsage(fs.readFileSync(file, 'utf8')), first, (cwd) => inRepo(repo, cwd))]; reread = true; }
      next.set(file, hit);
      lists.push(hit[1]);
    }
    if (reread || next.size !== transcripts.size) cache.write('transcripts.json', { roots: repo?.roots, files: Object.fromEntries(next) });
    transcripts = next; // transcripts gone, or out of the window, drop out
    return aggregate(lists, now, (cwd) => inRepo(repo, cwd));
  }
  return usage;
}
module.exports = { parseUsage, aggregate, cacheRows, createUsage };
