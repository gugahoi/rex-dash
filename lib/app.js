'use strict';
const { spawn } = require('node:child_process');
const { PROJECTS, dim, bold, red, green, cyan, plain, tilde, ago, firstLine } = require('./utils');
const { detectRepo, githubName, named } = require('./repo');
const { createCache } = require('./storage');
const { loadConfig, CONFIG, SECTIONS, rehide } = require('./config');
const rex = require('./integrations/rex');
const wt = require('./integrations/wt');
const { prs, issues, details, stacks, stack } = require('./integrations/github');
const { createUsage } = require('./usage');
const { createEffects, SHADERS, EFFECTS, BAND, shaded, cycle } = require('./ui/effects');
const { createFilter } = require('./ui/filter');
const { createSections, MARK, EVERY, PR_ROWS, STACK_ROWS, STACK_PRS, ghKey, memberId, awaiting, head } = require('./ui/sections');
const { joinStacks } = require('./ui/stacks');
const { createScreen } = require('./ui/screen');
const { renderDetail } = require('./ui/detail');
const { helpLines, boxed } = require('./ui/help');

const CURSOR = '\x1b[7m \x1b[27m';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
const VIEWS = { lists: 'keys', pr: 'keys · PR', issue: 'keys · issue', stack: 'keys · stack' }; // the keys' titles

// config, repo and integrations (fleet, prs, stacks, issues, focusPane, openTab, runWorktree, prepareWorktree,
// details, stack) stand in for the config file, the detected repo and the real commands, in tests.
function createApp({ once = false, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, config: givenConfig, repo: givenRepo, integrations = {} } = {}) {
  const { fleet, focusPane, openTab, runWorktree, prepareWorktree, prs: fetchPRs, issues: fetchIssues, details: fetchDetails, stacks: fetchStacks, stack: fetchStack } =
    { ...rex, ...wt, prs, issues, details, stacks, stack, ...integrations };
  let repo = givenRepo ?? null, cache = null, usageClient = null;
  let config = givenConfig ?? { keymaps: new Map(), hide: new Set(), errors: [] }, launching = null;
  const state = {}, busy = new Map(), fetched = {}, stale = new Set();
  const effects = createEffects({ once }), filter = createFilter();
  let typing = false, sel = null, flash = null, handedOver = false, reported = 0, live = false, help = false;
  // The lists' scroll: the first of their rows on screen. As in Vim, it's the view's own: j/k move it only as far
  // as it takes to keep the selection on screen, and Ctrl-D, Ctrl-U, Ctrl-F and Ctrl-B scroll it. markAll draws
  // every row j/k select as selected, to find them.
  let listTop = 0, markAll = false;
  // The PR's, issue's or stack's page that shows in place of the lists ({ kind, key, item, scroll }, and for a
  // stack its id and the PR selected on it, sel), with the page it was opened from, back. And the details fetched
  // for each this session: a page shows them at once when it opens again, while they're fetched anew.
  let detail = null, drawn = null;
  const got = new Map(), fetching = new Map();
  // What's hidden: the config's hide to begin with, then what keys 1 to 6 make of it for the session. Stacks show
  // only in repo mode: outside a repo, there's no section for them.
  let hidden = new Set(config.hide);
  const shows = (section) => !hidden.has(section) && (section !== 'stacks' || !!repo);
  // The sections each source fills. Sources whose sections are all hidden aren't fetched.
  const FILLS = { fleet: ['fleet'], usage: ['usage'], prs: ['review_requests', 'my_prs'], stacks: ['stacks'], issues: ['issues'] };
  const needed = (key) => FILLS[key].some(shows);
  const { paneLines, paneSession, renderFleet, shownPRs, renderPRs, shownStacks, renderStacks, issueLines, renderIssues, renderUsage } =
    createSections({ getRepo: () => repo, getSel: () => (markAll ? EVERY : sel), filter });
  const showing = (key) => (state[key + 'Err'] ? null : state[key]);
  const agents = () => (showing('fleet') || []).flatMap((s) => s.panes).filter((p) => p.rec);
  const shownAgents = () => filter.shown(agents(), paneLines, paneSession);
  const shownIssues = () => filter.shown(showing('issues')?.nodes || [], issueLines);
  // Stacks as fetched, joined with your PRs and review requests, which their rows are drawn from. Each join is kept
  // until the PRs change: joining at 10 frames a second would be slow.
  const joins = new WeakMap();
  function joined(d) {
    if (!d) return [];
    const j = joins.get(d);
    if (j && j.prs === state.prs) return j.list;
    const list = joinStacks(d, state.prs);
    joins.set(d, { prs: state.prs, list });
    return list;
  }
  // A stack, joined, by its key: from the repo's stacks while they're fetched, else as its page fetched it, else as
  // the cache had them.
  function stackFor({ key }) {
    const find = (d) => joined(d).find((s) => s.key === key);
    return (needed('stacks') && find(showing('stacks'))) || find(got.get(key)?.data) || find(state.stacks) || null;
  }
  const screen = createScreen({ frame, popup, effects, output: stdout, isPaused: () => handedOver, once });
  const say = (text) => { flash = { text, until: Date.now() + 4e3 }; screen.draw(); };
  // Rex shows the pane as blocked, waiting on you, while your PRs have replies waiting on you: as of the last
  // fetch, even one that failed since. It's told when that changes, and when the pane comes back from wt. With
  // my PRs hidden, it isn't: there'd be nothing to see.
  function report(always = false) {
    const n = shows('my_prs') ? awaiting(state.prs?.mine) : 0;
    if (once || handedOver || (n === reported && !always)) return;
    reported = n;
    stdout.write(rex.paneName(n));
  }
  // wt has the pane while it runs. When the dashboard gets it back, the pane gets back its name in Rex too.
  const handoff = (value) => { handedOver = value; if (!value) report(true); };

  function setQuery(q) {
    filter.setQuery(q);
    const best = selectable().reduce((b, x) => (!b || x.score > b.score ? x : b), null); // the first of equals
    if (filter.terms.length && best) sel = best.id;
  }

  const DOWN = ['\x1b[B', '\x1bOB', '\x0e', '\n'], UP = ['\x1b[A', '\x1bOA', '\x10', '\x0b']; // arrows, ctrl-n/p, ctrl-j/k
  const RIGHT = ['\x1b[C', '\x1bOC'], LEFT = ['\x1b[D', '\x1bOD'];
  const HOME = ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~'], END = ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~'];
  // While the filter is typed, keys edit it and the arrows select. Enter keeps it, esc or ctrl-c clears it,
  // and backspace on an empty query leaves it. → keeps it too, and opens the selection's page.
  function filterKey(s) {
    if (s === '\r') typing = false;
    else if (RIGHT.includes(s)) { typing = false; return drill(); }
    else if (s === '\x1b' || s === '\x03') { typing = false; setQuery(''); }
    else if (DOWN.includes(s)) move(1);
    else if (UP.includes(s)) move(-1);
    else if (s === '\x7f' || s === '\b') { if (filter.query) setQuery([...filter.query].slice(0, -1).join('')); else typing = false; }
    else if (s === '\x15') setQuery(''); // ctrl-u
    else if (s === '\x17') setQuery(filter.query.replace(/\S*\s*$/, '')); // ctrl-w: the last word
    else if (!/[\x00-\x1f\x7f-\x9f]/.test(s)) setQuery(filter.query + s); // not other keys' escape codes
  }

  // A PR's, issue's or stack's repo#number is unique since they share one number sequence: it's an item's key.
  // What j/k select, in screen order: the agents, PRs, stacks and their PRs, and issues on screen that the filter
  // keeps. A PR can show in your PRs and in a stack, so each row has an id of its own, which sel is. A stack's row
  // and each of its PRs' have their own line of the stack's lines.
  const selectable = () => [
    ...(shows('fleet') ? shownAgents() : []).map((x) => ({ ...x, kind: 'agent', key: x.item.blockId, id: x.item.blockId })),
    ...[shows('review_requests') && showing('prs')?.review, shows('my_prs') && showing('prs')?.mine].filter(Boolean)
      .flatMap((l) => shownPRs(l).slice(0, PR_ROWS)).map((x) => ({ ...x, kind: 'pr', key: ghKey(x.item), id: ghKey(x.item) })),
    ...(shows('stacks') ? shownStacks(joined(showing('stacks'))).slice(0, STACK_ROWS) : []).flatMap((x) => [
      { ...x, lines: x.lines.slice(0, 1), kind: 'stack', key: x.item.key, id: x.item.key },
      ...x.item.members.slice(0, STACK_PRS).map((m, k) => ({
        item: m.pr, score: x.score, lines: [x.lines[k + 1]], kind: 'pr', key: ghKey(m.pr), id: memberId(x.item, m), stack: { key: x.item.key, id: x.item.id },
      })),
    ]),
    ...(shows('issues') ? shownIssues() : []).map((x) => ({ ...x, kind: 'issue', key: ghKey(x.item), id: ghKey(x.item) })),
  ];

  function move(d) {
    const ids = selectable().map((x) => x.id);
    if (!ids.length) return;
    const i = ids.indexOf(sel);
    sel = ids[i < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, i + d))];
  }

  // What keys act on: the PR, issue or stack whose page shows, or else the selection.
  const chosen = () => (detail?.kind === 'stack' ? { ...detail, item: stackFor(detail) ?? detail.item } : detail) ||
    selectable().find((y) => y.id === sel);

  // Enter: an agent's pane in Rex, a PR's or issue's worktree, or a stack's page in the browser.
  function open() {
    const x = chosen();
    if (!x) return say(dim('pick an agent, PR, stack or issue with j/k first'));
    return x.kind === 'agent' ? jump(x.item) : x.kind === 'stack' ? browse() : worktree(x.kind, x.item.number);
  }

  // The GitHub web page of the PR, issue or stack keys act on, or why there's none: data cached before URLs were
  // fetched has no link until it refreshes. Only web pages, since the opener would run anything else.
  function page() {
    const x = chosen();
    if (!['pr', 'issue', 'stack'].includes(x?.kind)) return { why: 'pick a PR, stack or issue with j/k first' };
    if (!/^https?:\/\//.test(x.item.url || '')) return { why: 'no link yet: wait for the refresh' };
    return { key: x.key, url: x.item.url };
  }

  // [o] opens the page in the browser, with the system's opener, on the machine rex-dash runs on.
  function browse() {
    const p = page();
    if (!p.url) return say(dim(p.why));
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [p.url], { stdio: 'ignore' })
      .on('error', (e) => say(red(e.code === 'ENOENT' ? `${opener} not found` : plain(firstLine(e)))))
      .on('exit', (code) => code && say(red(`${opener} exited with ${code}`)));
    say(green(`↗ ${plain(p.key)}`));
  }

  // [l] or → opens the selected PR's or issue's page in the dashboard, in place of the lists. Its details come
  // from GitHub, by its URL, when it opens, on [r] and every minute while it shows. On a stack, it opens the
  // stack's page. Returns the fetch, for tests.
  function drill() {
    const x = chosen(), p = page();
    if (x?.kind === 'stack') return openStack(x.item);
    if (!p.url) return say(dim(p.why));
    detail = { kind: x.kind, key: x.key, item: x.item, scroll: 0, stack: x.stack };
    return fetchDetail();
  }
  // A stack's page, in front of the page it's opened from, back, with the PR it's opened for, number, selected.
  function openStack({ key, id }, back = null, number) {
    const members = stackFor({ key })?.members || [];
    detail = { kind: 'stack', key, id, item: { key }, scroll: 0, sel: Math.max(0, members.findIndex((m) => m.number === number)), back };
    follow();
    return fetchDetail();
  }
  // [t] opens the stack page of the PR keys act on, or of the selected stack: from the lists, or in front of the
  // PR's page. A PR knows its stack from its stack's rows, its own row, or its page's details.
  function toStack() {
    const x = chosen();
    if (x?.kind === 'stack') return detail ? undefined : openStack(x.item);
    if (x?.kind !== 'pr') return say(dim('pick a PR in a stack with j/k first'));
    const s = (x === detail && got.get(x.key)?.data?.stack) || x.item.stack;
    const ref = x.stack || (s && x.item.repository?.name ? { key: `${plain(x.item.repository.name)}#${s.number}`, id: s.id } : null);
    if (!ref) return say(dim(`${plain(x.key)} isn't in a stack`));
    return openStack(ref, detail, x.item.number);
  }
  // [l] or → on a stack's page opens the selected PR's page, in front of it.
  function drillMember() {
    const m = stackFor(detail)?.members[detail.sel];
    if (!m) return undefined;
    if (!/^https?:\/\//.test(m.pr.url || '')) return say(dim('no link yet: wait for the refresh'));
    detail = { kind: 'pr', key: ghKey(m.pr), item: m.pr, scroll: 0, stack: { key: detail.key, id: detail.id }, back: detail };
    return fetchDetail();
  }
  // A PR's or issue's details are fetched by its URL. A stack's page needs no fetch while the repo's stacks are
  // fetched with it in them; otherwise it's fetched by its id.
  function fetchDetail() {
    const { kind, key, item, id } = detail;
    if (kind === 'stack' && needed('stacks') && joined(showing('stacks')).some((s) => s.key === key)) return Promise.resolve();
    if (!fetching.has(key)) fetching.set(key, (async () => {
      try { got.set(key, { data: await (kind === 'stack' ? fetchStack(id) : fetchDetails(item.url)) }); } catch (e) { got.set(key, { ...got.get(key), err: firstLine(e) }); }
      fetching.delete(key);
      screen.draw();
    })());
    return fetching.get(key);
  }
  // The stack a PR's page shows, when the dashboard has it.
  const pageStack = (g) => (g?.data?.stack ? stackFor({ key: `${plain(g.data.repository?.name)}#${g.data.stack.number}` }) : null);
  // The page's lines, w columns wide. They're kept until its details, its stack, its selection or the width
  // change: wrapping them at 10 frames a second would be slow.
  function pageLines(w) {
    const g = got.get(detail.key), st = detail.kind === 'stack' ? stackFor(detail) : detail.kind === 'pr' ? pageStack(g) : null;
    if (drawn?.detail !== detail || drawn.got !== g || drawn.w !== w || drawn.stack !== st || drawn.sel !== detail.sel) {
      drawn = { detail, got: g, w, stack: st, sel: detail.sel, lines: renderDetail({ ...detail, got: g, stack: st }, w) };
    }
    return drawn.lines;
  }
  // Whether the filter has a row under the header: while it's typed or kept, on the lists.
  const filtering = () => !detail && (typing || !!filter.query);
  // The rows the lists or a page have on screen, between the band under the header and the band at the bottom,
  // less the filter's row while there's one.
  const room = () => Math.max(1, (stdout.rows || 50) - 3 - (filtering() ? 1 : 0));
  const scrollTo = (top) => { detail.scroll = Math.max(0, Math.min(top, pageLines(stdout.columns || 100).length - room())); };
  // Scrolls a stack's page to keep its selected PR on screen, with the line under it: to the top for the first.
  function follow() {
    if (!detail.sel) return scrollTo(0);
    const at = pageLines(stdout.columns || 100).findIndex((l) => l.startsWith(MARK));
    if (at >= 0 && at < detail.scroll) scrollTo(at);
    else if (at >= 0 && at + 2 > detail.scroll + room()) scrollTo(at + 2 - room());
  }
  // On a page, keys scroll it, and ←, esc or backspace go back to the page it was opened from, or the lists, with
  // the same selection. On a stack's page, j/k select its PRs, and l or → opens the one selected.
  function pageKey(s) {
    const { scroll } = detail, rows = room();
    if (LEFT.includes(s) || s === '\x1b' || s === '\x7f' || s === '\b') { detail = detail.back ?? null; return undefined; }
    if (detail.kind === 'stack') {
      const n = stackFor(detail)?.members.length || 0;
      const pick = (i) => { detail.sel = Math.max(0, Math.min(n - 1, i)); follow(); };
      if (s === 'j' || DOWN.includes(s)) return pick(detail.sel + 1);
      if (s === 'k' || UP.includes(s)) return pick(detail.sel - 1);
      if (HOME.includes(s)) return pick(0);
      if (END.includes(s)) return pick(n - 1);
      if (s === 'l' || RIGHT.includes(s)) return drillMember();
    }
    if (s === 'j' || DOWN.includes(s)) scrollTo(scroll + 1);
    else if (s === 'k' || UP.includes(s)) scrollTo(scroll - 1);
    else if (s === ' ' || s === '\x06' || s === '\x1b[6~') scrollTo(scroll + rows - 1); // space, ctrl-f, page down
    else if (s === '\x02' || s === '\x1b[5~') scrollTo(scroll - rows + 1); // ctrl-b, page up
    else if (s === '\x04') scrollTo(scroll + (rows >> 1)); // ctrl-d
    else if (s === '\x15') scrollTo(scroll - (rows >> 1)); // ctrl-u
    else if (HOME.includes(s)) scrollTo(0);
    else if (END.includes(s)) scrollTo(Infinity);
  }

  // The lists' rows, below the band: the sections that show, a row per line.
  const section = (key, render, loading) =>
    state[key + 'Err'] ? [head(key.toUpperCase()), red('  ' + plain(state[key + 'Err']))] : state[key] ? render(state[key]) : [head(key.toUpperCase()), dim('  ' + loading)];
  const listRows = () => [
    ...(needed('fleet') ? section('fleet', renderFleet, 'asking Rex…') : []),
    ...(needed('usage') ? section('usage', renderUsage, `reading ${tilde(PROJECTS)}…`) : []),
    ...(needed('prs') ? section('prs', (d) => renderPRs(d, { review: shows('review_requests'), mine: shows('my_prs') }), 'asking GitHub…') : []),
    ...(needed('stacks') ? section('stacks', (d) => renderStacks(joined(d), d.err), 'asking GitHub…') : []),
    ...(needed('issues') ? section('issues', renderIssues, 'asking GitHub…') : []),
  ].flatMap((l) => l.split('\n'));
  // The furthest the lists, of n rows, scroll: their last row at the bottom of the screen.
  const maxTop = (n) => Math.max(0, n - room());
  // Where the rows j/k select are: { rows, spans }, rows the number of the lists' rows, and spans those j/k
  // select, { id, start, end }, in screen order. Drawing the lists with every one of them marked finds them, ▸
  // starting each, where comparing their text wouldn't: the "ago" columns can tick between two drawings. It keeps
  // the scroll in range for them.
  function listLayout() {
    let rows;
    markAll = true;
    try { rows = listRows(); } finally { markAll = false; }
    const starts = rows.flatMap((l, i) => (l.startsWith(MARK) ? [i] : []));
    const spans = selectable().slice(0, starts.length).map((x, k) => ({ id: x.id, start: starts[k], end: starts[k] + x.lines.length - 1 }));
    listTop = clamp(listTop, 0, maxTop(rows.length));
    return { rows: rows.length, spans };
  }
  // The lists' scroll for these rows, as drawn: in range, and moved only as far as it takes to keep the whole of
  // the selection on screen, after j/k, and when the lists change under it or the pane resizes.
  function inView(rows) {
    const h = room(), at = rows.findIndex((l) => l.startsWith(MARK));
    const top = clamp(listTop, 0, maxTop(rows.length));
    if (at < 0) return top;
    const n = selectable().find((x) => x.id === sel)?.lines.length ?? 1;
    return Math.min(Math.max(top, at + n - h), at);
  }
  // Ctrl-D and Ctrl-U, as in Vim: the lists scroll half a screen, and the selection moves as far, to the row j/k
  // select nearest the row it would reach, past the one selected; with nothing selected, from the top of the
  // screen. Where the lists can't scroll, the selection still moves, to the first or the last row at most.
  function half(d) {
    const { rows, spans } = listLayout(), n = Math.max(1, room() >> 1);
    const i = spans.findIndex((x) => x.id === sel), to = (i < 0 ? listTop : spans[i].start) + d * n;
    listTop = clamp(listTop + d * n, 0, maxTop(rows));
    const ahead = d > 0 ? spans.slice(i + 1) : spans.slice(0, i < 0 ? spans.length : i).reverse(); // in the direction it moves
    const off = (x) => Math.max(x.start - to, to - x.end, 0); // rows from the one it would reach
    const best = ahead.reduce((b, x) => (!b || off(x) <= off(b) ? x : b), null); // a tie goes further
    if (best) sel = best.id;
  }
  // Ctrl-F and Ctrl-B, or Page Down and Page Up: the lists scroll a screen, less a row, as a page does. A selection
  // they scroll off goes to the first row j/k select on screen, or for Ctrl-B the last. Where they can't scroll,
  // it goes to the last row, or the first.
  function screenful(d) {
    const { rows, spans } = listLayout(), h = room(), was = listTop;
    if (!spans.length) return;
    listTop = clamp(listTop + d * Math.max(1, h - 1), 0, maxTop(rows));
    if (listTop === was) { sel = spans.at(d > 0 ? -1 : 0).id; return; }
    const s = spans.find((x) => x.id === sel);
    if (s && s.start >= listTop && s.end < listTop + h) return;
    const on = spans.filter((x) => x.start >= listTop && x.end < listTop + h); // none, under a long section
    sel = (d > 0 ? on[0] ?? spans.find((x) => x.start >= listTop) ?? spans.at(-1) : on.at(-1) ?? spans.findLast((x) => x.end < listTop + h) ?? spans[0]).id;
  }
  // Home and End: the top or the bottom of the lists, and the first or the last row j/k select.
  function ends(d) {
    const items = selectable();
    listTop = d < 0 ? 0 : maxTop(listRows().length);
    if (items.length) sel = items.at(d < 0 ? 0 : -1).id;
  }

  async function jump(p) {
    try {
      await focusPane(p); // REX_CLIENT selects the connected app.
      say(green(`→ ${plain(p.session)}`));
    } catch (e) {
      say(red(plain(firstLine(e))));
    }
  }

  // `wt issue <number>` and `wt pr <number>` open the issue's or PR's worktree by wt's rules. For an issue, wt
  // offers its <number>-* branches, or a new one named in a prompt; for a PR, it takes the PR's branch, fetched
  // from GitHub when there's no local one (a fork's as pr-<number>). Then it creates the worktree, runs
  // wt.setupCommand and opens the worktree's session (in Rex, inside Rex). Its prompts and setup need the
  // terminal, so the dashboard hands it over until wt exits, and keeps what a failing wt printed on screen
  // until a key. kind: 'issue' or 'pr'.
  async function worktree(kind, number) {
    if (!repo) return say(dim(`start rex-dash in the repo to open a worktree for its ${kind === 'pr' ? 'PR' : 'issue'}`));
    try {
      const end = await runWorktree(kind, number, { stdin, stdout, onHandoff: handoff });
      screen.repaint();
      if (end.error) say(red(end.error.code === 'ENOENT' ? 'wt not found: brew install gugahoi/tap/wt' : plain(firstLine(end.error))));
    } catch (e) {
      screen.repaint();
      say(red(plain(firstLine(e))));
    }
  }

  // A keymap's key runs its command for the selected PR or issue, in the worktree wt makes for it, in a new
  // tab: in the worktree's session (the one Enter opens), or in this one. The item and the worktree reach the
  // command in REX_DASH_* and WT_* variables, never in its text. As for Enter, wt has the terminal while it
  // prompts and sets up; then the tab opens behind the dashboard, unless the keymap has background: false.
  async function launch(km) {
    const x = chosen(), name = `[${plain(km.key)}] ${plain(km.label)}`;
    if (!km.on.includes(x?.kind)) return say(dim(`${name}: pick ${km.on.map((k) => (k === 'pr' ? 'a PR' : 'an issue')).join(' or ')} with j/k first`));
    if (!repo) return say(dim(`start rex-dash in the repo to run ${name} in a worktree`));
    const here = process.env.REX_SESSION;
    if (km.session === 'current' && !here) return say(red(`${name} opens its tab in this session, so needs rex-dash in Rex`));
    if (launching) return say(dim(`still starting ${launching}`));
    launching = `${plain(km.label)} ${x.key}`;
    try {
      let got;
      try {
        got = await prepareWorktree(x.kind, x.item.number, { stdin, stdout, onHandoff: handoff });
      } finally { screen.repaint(); }
      const { end, worktree: w } = got;
      if (end.error) return say(red(end.error.code === 'ENOENT' ? 'wt not found: brew install gugahoi/tap/wt' : plain(firstLine(end.error))));
      if (end.code !== 0) return; // wt said why, and waited for a key
      if (!w) return say(dim(`${launching}: no worktree, so not started`));
      const vars = {
        REX_DASH_KIND: x.kind, REX_DASH_NUMBER: x.item.number, REX_DASH_TITLE: plain(x.item.title),
        REX_DASH_URL: /^https?:\/\//.test(x.item.url || '') ? plain(x.item.url) : '', REX_DASH_REPO: repo.gh || '',
        WT_WORKTREE: w.path, WT_BRANCH: w.branch,
      };
      await openTab({
        ...(km.session === 'current' ? { sessionId: here } : { sessionLabel: w.session }),
        name: `${plain(km.label)} #${x.item.number}`, cwd: w.path, argv: rex.withEnv(vars, km.commands[x.kind]),
        keepOpen: km.keepOpen, background: km.background,
      });
      say(green(`${km.background ? '⇢' : '→'} ${launching}`) + dim(` in ${km.session === 'current' ? 'this session' : plain(w.session)}`));
    } catch (e) {
      say(red(plain(firstLine(e))));
    } finally {
      launching = null;
    }
  }

  // The dashboard's rows: the header, the filter's row while there's one, and a band, then the sections, or else
  // the page that shows, from where it's scrolled to. The header says which of the page's lines show, and that ?
  // shows the keys. --once prints all of the sections.
  function frame() {
    let lines = [], top = 0, range = '';
    const off = SECTIONS.filter((s) => hidden.has(s) && (s !== 'stacks' || repo)), old = [...stale].filter(needed); // a hidden section's cache stays old
    if (detail) {
      lines = pageLines(stdout.columns || 100);
      const end = Math.max(0, lines.length - room());
      top = detail.scroll = Math.min(detail.scroll, end); // the pane may have grown
      if (end) range = `lines ${top + 1}-${Math.min(lines.length, top + room())} of ${lines.length}`;
    } else {
      lines = listRows();
      if (!once) top = listTop = inView(lines);
    }
    const query = `${cyan('/')}${bold(plain(filter.query))}`;
    const bar = !filtering() ? [] : typing ? [`${query}${CURSOR}  ${dim('[⏎] keep  [→] details  [esc] clear  [↑/↓] select')}`] : [`${query}  ${dim('[esc] clear')}`];
    return [
      `${bold(shaded('REX // COCKPIT'))} ${dim('·')} ${repo ? `${bold(plain(repo.name))} ${dim('·')} ` : ''}${new Date().toString().slice(0, 21)}` +
        (range ? `  ${dim(range)}` : '') + (once ? '' : `  ${dim('[?] keys')}`) +
        (old.length ? `  ${dim(`cached ${ago(Math.min(...old.map((k) => fetched[k])))}`)}` : '') +
        (off.length && !once ? `  ${dim(`hidden ${off.map((s) => `[${SECTIONS.indexOf(s) + 1}] ${s.replace('_', ' ')}`).join(' ')}`)}` : '') +
        (flash && Date.now() < flash.until ? `  ${flash.text}` : '') +
        (config.errors.length ? `  ${red(`config: ${plain(config.errors[0])}`)}${config.errors.length > 1 ? dim(` (+${config.errors.length - 1} more)`) : ''}` : ''),
      ...(once ? [] : [...bar, BAND]),
      ...lines.slice(top),
    ].flatMap((l) => l.split('\n'));
  }

  // The box of keys ? shows over the body, for the lists or the page that shows, w columns wide and h rows tall at
  // most; or null, while it's closed. t shows on a PR's page only when the PR is in a stack.
  function popup(w, h) {
    if (!help || once) return null;
    const view = detail?.kind ?? 'lists';
    const stacked = view === 'pr' && !!(detail.stack || detail.item.stack || got.get(detail.key)?.data?.stack);
    const lines = helpLines({ view, stacked, keymaps: config.keymaps, fx: effects.fx, hidden, repo: !!repo, configPath: tilde(CONFIG) });
    return boxed(lines, VIEWS[view], w - 2, h, 'any key closes this');
  }

  // Hides and shows sections. A source that a section shows again is fetched at once, once the dashboard runs.
  function setHidden(next) {
    const was = Object.keys(SOURCES).filter(needed);
    hidden = next;
    if (live) for (const [k, [fn]] of Object.entries(SOURCES)) if (needed(k) && !was.includes(k)) refresh(k, fn);
  }
  // Keys 1 to 6 hide and show a section, for the session only. Outside a repo, there's no stacks section.
  function toggle(s) {
    if (s === 'stacks' && !repo) return say(dim('stacks show in repo mode: start rex-dash in a repo'));
    setHidden(new Set(SECTIONS.filter((x) => (x === s) !== hidden.has(x))));
    return report();
  }

  const quit = () => { save(); stdout.write(`\x1b[0m\x1b[?25h\x1b[?1049l${rex.PANE_FORGET}`); process.exit(0); };
  // Reading the config again changes only the sections whose hide changed in it.
  function reloadConfig() {
    if (givenConfig) return;
    const was = config.hide;
    config = loadConfig();
    setHidden(rehide(hidden, was, config.hide));
  }
  // One key: a character, or an arrow's (or another key's) escape code. The caller draws. A keymap's key
  // returns its launch, and [l] and [t] the page's fetch, for tests to wait on; keymaps never have the dashboard's
  // own keys. On a page, keymaps, q, r, o, t, Enter, s and e act on its PR, issue or stack as on the selection; the
  // rest move. As in Vim, the lists scroll after each key to keep the selection on screen: keys typed quickly, or
  // held, can arrive together, and all be pressed before the next drawing. ? shows the keys, until the next key,
  // which does nothing else, but for ctrl-c.
  function press(s) {
    const r = act(s);
    if (!detail) listTop = inView(listRows());
    return r;
  }
  function act(s) {
    if (help) { help = false; if (s !== '\x03') return undefined; }
    if (typing) return filterKey(s);
    if (s === '?') { help = true; return undefined; }
    if (config.keymaps.has(s)) return launch(config.keymaps.get(s));
    if (s === 'q' || s === '\x03') quit();
    if (s === 'r') { reloadConfig(); report(); refreshAll(); if (detail) fetchDetail(); }
    if (s === 'o') browse();
    if (s === '\r') open();
    if (s === 's') { effects.fx.shader = cycle(Object.keys(SHADERS), effects.fx.shader); effects.saveFx(); say(`${dim('shader')} ${shaded(effects.fx.shader)}`); }
    if (s === 'e') { effects.fx.effect = cycle(EFFECTS, effects.fx.effect); effects.saveFx(); say(`${dim('effects')} ${shaded(effects.fx.effect)}`); }
    if (s === 't') return toStack();
    if (detail) return pageKey(s);
    if (s === 'j' || DOWN.includes(s)) move(1);
    if (s === 'k' || UP.includes(s)) move(-1);
    if (s === '\x04') half(1); // ctrl-d
    if (s === '\x15') half(-1); // ctrl-u
    if (s === '\x06' || s === '\x1b[6~') screenful(1); // ctrl-f, page down
    if (s === '\x02' || s === '\x1b[5~') screenful(-1); // ctrl-b, page up
    if (HOME.includes(s)) ends(-1);
    if (END.includes(s)) ends(1);
    if (s === 'l' || RIGHT.includes(s)) return drill();
    if (s === '/') typing = true; // a kept filter is edited
    if (s === '\x1b') setQuery('');
    if (/^[1-9]$/.test(s) && SECTIONS[s - 1]) toggle(SECTIONS[s - 1]);
  }
  const KEY = /\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|[\s\S]/gu;

  // A source whose sections are all hidden isn't fetched: refresh() leaves it, and its cache, as they are.
  function refresh(key, fn) {
    if (!needed(key)) return undefined;
    if (!busy.has(key)) busy.set(key, (async () => {
      try { state[key] = await fn(); fetched[key] = Date.now(); delete state[key + 'Err']; } catch (e) { state[key + 'Err'] = firstLine(e); }
      busy.delete(key);
      stale.delete(key);
      report();
      if (key !== 'fleet') save(); // the fleet changes every few seconds: the others' saves, and quitting, take it along
      screen.draw();
    })());
    return busy.get(key);
  }

  // The repo's stacks take their PRs from your PRs and review requests where they can, so they wait for a PR
  // refresh in flight. stacks comes after prs, so refreshAll() starts that first.
  async function loadStacks() {
    await busy.get('prs');
    return fetchStacks(repo, { prs: state.prs, cached: state.stacks });
  }
  const SOURCES = {
    fleet: [() => fleet(repo), 3e3], prs: [() => fetchPRs(repo), 60e3], stacks: [loadStacks, 60e3], issues: [() => fetchIssues(repo), 60e3],
    usage: [() => usageClient(), 300e3],
  };
  const refreshAll = () => Object.entries(SOURCES).map(([k, [fn]]) => refresh(k, fn));

  const save = () => cache?.write('state.json', {
    gh: repo?.gh, fetched, state: Object.fromEntries(Object.keys(SOURCES).filter((k) => state[k]).map((k) => [k, state[k]])),
  });
  function restore(saved) {
    for (const k of Object.keys(SOURCES)) {
      if (!saved?.state?.[k] || !saved.fetched?.[k]) continue;
      state[k] = saved.state[k]; fetched[k] = saved.fetched[k]; stale.add(k);
    }
  }

  async function main() {
    const dir = cwd;
    repo = await detectRepo(dir);
    cache = createCache(repo);
    usageClient = createUsage(repo, cache);
    const saved = cache.read('state.json');
    if (repo) {
      // A cached GitHub name is used at once and checked behind it. If it changed, PRs, stacks and issues are
      // fetched again, after any fetch for the old name finishes.
      const check = githubName(dir);
      named(repo, saved && 'gh' in saved ? saved.gh : await check);
      check.then((gh) => {
        if (gh === repo.gh) return;
        named(repo, gh);
        for (const k of ['prs', 'stacks', 'issues']) Promise.resolve(busy.get(k)).then(() => refresh(k, SOURCES[k][0]));
      });
    }
    restore(saved);
    reloadConfig(); // before fetching, so hidden sections aren't fetched, in --once too
    if (once) {
      await Promise.all(refreshAll());
      save();
      return stdout.write(frame().map((l) => effects.paint(l, 0, Infinity, 0)).join('\n') + '\n');
    }
    effects.loadFx(); // --once prints plain
    stdout.write(`${rex.PANE_PUSH}\x1b[?1049h\x1b[?25l`);
    report(true);
    live = true; // sections shown again are fetched from now on
    process.on('SIGINT', () => handedOver || quit()).on('SIGTERM', quit).on('SIGHUP', quit); // Ctrl-C in wt's setup is wt's
    stdout.on('resize', () => handedOver || screen.repaint());
    if (stdin.isTTY) {
      stdin.setRawMode(true).resume().on('data', (chunk) => {
        // Keys typed quickly, or pasted, arrive in one chunk, so handle them one at a time, until wt takes the terminal.
        for (const s of chunk.toString().match(KEY) || []) {
          if (handedOver) break;
          press(s);
        }
        screen.draw();
      });
    }
    screen.draw();
    await refresh('fleet', SOURCES.fleet[0]); // the usage scan blocks the event loop, so show the fleet first
    refreshAll();
    for (const [k, [fn, every]] of Object.entries(SOURCES)) setInterval(() => refresh(k, fn), every);
    setInterval(() => detail && !handedOver && fetchDetail(), 60e3); // a page's details, like PRs and issues
    setInterval(() => screen.draw(), 100); // 10 fps for the shader, and it keeps the clock and "ago" columns moving
  }

  return { main, frame, popup, press, selectable, setQuery, page, refreshAll, state };
}
module.exports = { createApp };
