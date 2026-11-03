'use strict';
const { ANSI, vis, dim } = require('../utils');

// Each dashboard owns its own query and matching state.
function createFilter() {
  let query = '', terms = [];
  function fuzzy(term, text) {
    const hay = /\p{Lu}/u.test(term) ? text : text.toLowerCase();
    let best = null;
    for (let from = hay.indexOf(term[0]); from >= 0; from = hay.indexOf(term[0], from + 1)) {
      let end = -1;
      for (let i = 0, j = from; j < hay.length; j++) if (hay[j] === term[i] && ++i === term.length) { end = j; break; }
      if (end < 0) break; // nor will any later start
      const cols = [];
      for (let i = term.length - 1, j = end; i >= 0; j--) if (hay[j] === term[i]) { cols.unshift(j); i--; }
      const score = rate(text, cols);
      if (!best || score > best.score) best = { score, cols };
    }
    return best;
  }
  function rate(text, cols) {
    let score = 0, run = 0;
    cols.forEach((j, k) => {
      const prev = text[j - 1] ?? ' ', gap = k ? j - cols[k - 1] - 1 : 0;
      const start = !/[\p{L}\p{N}]/u.test(prev) || (/\p{Ll}/u.test(prev) && /\p{Lu}/u.test(text[j])) ? 8 : 0;
      const bonus = k && !gap ? Math.max(start, run, 4) : (run = start);
      score += 16 + bonus * (k ? 1 : 2) - (gap ? 2 + gap : 0);
    });
    return score;
  }

  // An item's score, and the columns of its text that the terms matched; null when a term doesn't match.
  function match(text) {
    let score = 0;
    const cols = new Set();
    for (const term of terms) {
      const m = fuzzy(term, text);
      if (!m) return null;
      score += m.score;
      m.cols.forEach((c) => cols.add(c));
    }
    return { score, cols };
  }

  // Underline the characters of a styled line that sit at text columns cols, the line starting at column at.
  function underline(line, cols, at) {
    let out = '', n = at;
    for (const part of line.split(ANSI)) {
      if (ANSI.test(part)) { out += part; continue; }
      for (const ch of part) { out += cols.has(n) ? `\x1b[4m${ch}\x1b[24m` : ch; n += ch.length; }
    }
    return out;
  }

  // The items of a list that the filter keeps, in order, each with its score and its lines(item), underlined
  // where they matched. The text matched is the lines', then hidden(item)'s, which isn't shown.
  function shown(items, lines, hidden = () => '') {
    return items.flatMap((item) => {
      const ls = lines(item);
      if (!terms.length) return [{ item, score: 0, lines: ls }];
      const m = match(`${vis(ls.join(' '))} ${hidden(item)}`);
      let at = 0;
      return m ? [{ item, score: m.score, lines: ls.map((l) => { const u = underline(l, m.cols, at); at += vis(l).length + 1; return u; }) }] : [];
    });
  }
  const matches = (n) => (terms.length ? dim(` · ${n} match${n === 1 ? '' : 'es'}`) : '');

  function setQuery(q) { query = q; terms = q.split(' ').filter(Boolean); }
  return { get query() { return query; }, get terms() { return terms; }, setQuery, fuzzy, rate, match, underline, shown, matches };
}
module.exports = { createFilter };
