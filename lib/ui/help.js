'use strict';
const { dim, bold, plain, pad, vis, cols, sliceCols } = require('../utils');
const { SECTIONS } = require('../config');
const { shaded } = require('./effects');

// The keys `?` shows, as [keys, what they do]: press()'s for the lists, and pageKey()'s for a page, in app.js.
const BACK = ['← esc ⌫', 'back'];
const SCREEN = [['space ^F PgDn', 'a screen down'], ['^B PgUp', 'a screen up'], ['^D ^U', 'half a screen down, up']];
const looks = (fx) => [['s e', `shader ${shaded(fx.shader)} · effects ${shaded(fx.effect)}`]];
const END = [['r', 'refresh, and read the config again'], ['q', 'quit']];
const KIND = { pr: 'PR', issue: 'issue' };
// A line that starts with DIVIDER divides the box, with the rest of the line in the divider. plain() keeps labels
// from forging it.
const DIVIDER = '\x05';

// What keys 1 to 6 do, and the sections they hide and show, shown ones bright and hidden ones dim, in lines of up
// to w columns. Outside a repo there's no stacks section.
function sectionLines(hidden, repo, w) {
  const out = ['hide or show:'];
  for (const s of SECTIONS.filter((x) => x !== 'stacks' || repo)) {
    const name = `${SECTIONS.indexOf(s) + 1} ${s.replace('_', ' ')}`, item = hidden.has(s) ? dim(name) : name;
    const sep = out.at(-1).endsWith(':') ? ' ' : '  ';
    if (vis(out.at(-1)).length + sep.length + name.length <= w) out[out.length - 1] += sep + item;
    else out.push(item);
  }
  return out;
}

// The popup's lines for a view: 'lists', or the kind of page that shows ('pr', 'issue' or 'stack'). stacked: the
// PR's page is of a PR in a stack, which t opens. Your keys show with their kinds on the lists, and on a page only
// if they act on its kind. Esc isn't here: the filter's row says what it does.
function helpLines({ view, stacked = false, keymaps = new Map(), fx, hidden = new Set(), repo = false, configPath }) {
  const rows = view === 'lists' ? [
    ['j/k ↑/↓', 'select'],
    ['^D ^U', 'half a screen down, up'],
    ['^F ^B', 'a screen down, up (PgDn, PgUp)'],
    ['home end', 'the first, the last'],
    ['l →', 'details, in the dashboard'],
    ['⏎', 'open: pane, worktree, or stack in browser'],
    ['o', 'open in the browser'],
    ['t', 'stack page'],
    ['/', 'filter'],
    ...sectionLines(hidden, repo, 49).map((l, i) => [i ? '' : `1-${SECTIONS.length}`, l]),
  ] : view === 'stack' ? [
    BACK,
    ['j/k ↑/↓', 'select a PR'],
    ['home end', 'the first or last PR'],
    ['l →', 'the PR\'s page'],
    ...SCREEN,
    ['⏎ o', 'open in the browser'],
  ] : [
    BACK,
    ['j/k ↑/↓', 'scroll'],
    ...SCREEN,
    ['home end', 'top, bottom'],
    ['⏎', 'worktree'],
    ['o', 'open in the browser'],
    ...(stacked ? [['t', 'stack page']] : []),
  ];
  rows.push(...looks(fx), ...END);
  const mine = [...keymaps.values()].filter((k) => view === 'lists' || k.on.includes(view))
    .map((k) => [plain(k.key), view === 'lists' ? `${plain(k.label)}  ${dim(k.on.map((x) => KIND[x]).join(', '))}` : plain(k.label)]);
  const width = Math.max(...[...rows, ...mine].map(([k]) => vis(k).length));
  const line = ([k, what]) => `${bold(pad(k, width))}  ${what}`;
  return [
    ...rows.map(line),
    ...(mine.length ? [`${DIVIDER}your keys`, ...mine.map(line)] : view === 'lists' ? [`${DIVIDER}your keys`, dim(`add them in ${configPath}`)] : []),
  ];
}

// The lines in a box with a shaded border, with a title in its top edge and a note in its bottom edge, at most
// maxW columns wide and maxH rows tall: longer lines are cut, and lines that don't fit end in a … row. Lines are
// padded, so the box hides what's under it. No room is no box.
function boxed(lines, title, maxW, maxH, note = '') {
  const need = (l) => (l.startsWith(DIVIDER) ? cols(l.slice(1)) + 1 : cols(vis(l))); // edges' text needs a ─ after it
  const w = Math.min(Math.max(cols(title) + 1, cols(note) + 1, ...lines.map(need)), maxW - 4);
  if (w < 1 || maxH < 3) return [];
  const body = lines.length > maxH - 2 ? [...lines.slice(0, maxH - 3), dim('…')] : lines;
  const fit = (l) => { const s = sliceCols(l, 0, w); return s + ' '.repeat(w - cols(vis(s))); };
  const edge = (text) => (text && cols(text) + 1 <= w ? `─ ${text} ${'─'.repeat(w - cols(text) - 1)}` : '─'.repeat(w + 2));
  const row = (l) => (l.startsWith(DIVIDER) ? shaded(`├${edge(l.slice(1))}┤`) : `${shaded('│')} ${fit(l)} ${shaded('│')}`);
  return [shaded(`╭${edge(title)}╮`), ...body.map(row), shaded(`╰${edge(note)}╯`)];
}

// Draws the box over rows[top..bottom), centred both ways in w columns, keeping what's either side of it.
function overlay(rows, box, w, top, bottom) {
  if (!box.length) return rows;
  const bw = cols(vis(box[0])), x = Math.max(0, (w - bw) >> 1), y = top + Math.max(0, (bottom - top - box.length) >> 1);
  box.slice(0, Math.max(0, bottom - y)).forEach((line, i) => {
    const row = rows[y + i] ?? '', left = sliceCols(row, 0, x);
    rows[y + i] = `${left}${' '.repeat(x - cols(vis(left)))}\x1b[0m${line}\x1b[0m${sliceCols(row, x + bw)}`;
  });
  return rows;
}

module.exports = { DIVIDER, helpLines, boxed, overlay };
