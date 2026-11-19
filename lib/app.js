'use strict';
const { spawn } = require('node:child_process');
const { PROJECTS, dim, bold, red, green, cyan, plain, tilde, ago, firstLine } = require('./utils');
const { detectRepo, githubName, named } = require('./repo');
const { createCache } = require('./storage');
const { loadConfig, SECTIONS, rehide } = require('./config');
const rex = require('./integrations/rex');
const wt = require('./integrations/wt');
const { prs, issues, details } = require('./integrations/github');
const { createUsage } = require('./usage');
const { createEffects, SHADERS, EFFECTS, BAND, shaded, cycle } = require('./ui/effects');
const { createFilter } = require('./ui/filter');
const { createSections, PR_ROWS, ghKey, awaiting, head } = require('./ui/sections');
const { createScreen } = require('./ui/screen');
const { renderDetail } = require('./ui/detail');

const CURSOR = '\x1b[7m \x1b[27m';

// config, repo and integrations (fleet, focusPane, openTab, runWorktree, prepareWorktree, details) stand in for
// the config file, the detected repo and the real commands, in tests.
function createApp({ once = false, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, config: givenConfig, repo: givenRepo, integrations = {} } = {}) {
  const { fleet, focusPane, openTab, runWorktree, prepareWorktree, details: fetchDetails } = { ...rex, ...wt, details, ...integrations };
  let repo = givenRepo ?? null, cache = null, usageClient = null;
  let config = givenConfig ?? { keymaps: new Map(), hide: new Set(), errors: [] }, launching = null;
  const state = {}, busy = new Map(), fetched = {}, stale = new Set();
  const effects = createEffects({ once }), filter = createFilter();
  let typing = false, sel = null, flash = null, handedOver = false, reported = 0, live = false;
  // The PR or issue whose page shows in place of the lists ({ kind, key, item, scroll }), and the details fetched
  // for each this session: a page shows them at once when it opens again, while they're fetched anew.
  let detail = null, drawn = null;
  const got = new Map(), fetching = new Map();
  // What's hidden: the config's hide to begin with, then what keys 1 to 5 make of it for the session.
  let hidden = new Set(config.hide);
  const shows = (section) => !hidden.has(section);
  // The sections each source fills. Sources whose sections are all hidden aren't fetched.
  const FILLS = { fleet: ['fleet'], usage: ['usage'], prs: ['review_requests', 'my_prs'], issues: ['issues'] };
  const needed = (key) => FILLS[key].some(shows);
  const { paneLines, paneSession, renderFleet, shownPRs, renderPRs, issueLines, renderIssues, renderUsage } =
    createSections({ getRepo: () => repo, getSel: () => sel, filter });
  const showing = (key) => (state[key + 'Err'] ? null : state[key]);
  const agents = () => (showing('fleet') || []).flatMap((s) => s.panes).filter((p) => p.rec);
  const shownAgents = () => filter.shown(agents(), paneLines, paneSession);
  const shownIssues = () => filter.shown(showing('issues')?.nodes || [], issueLines);
  const screen = createScreen({ frame, effects, output: stdout, isPaused: () => handedOver, once });
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
    if (filter.terms.length && best) sel = best.key;
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

  // A PR's or issue's repo#number is unique since they share one number sequence.
  // What j/k select, in screen order: the agents, PRs and issues on screen that the filter keeps.
  const selectable = () => [
    ...(shows('fleet') ? shownAgents() : []).map((x) => ({ ...x, kind: 'agent', key: x.item.blockId })),
    ...[shows('review_requests') && showing('prs')?.review, shows('my_prs') && showing('prs')?.mine].filter(Boolean)
      .flatMap((l) => shownPRs(l).slice(0, PR_ROWS)).map((x) => ({ ...x, kind: 'pr', key: ghKey(x.item) })),
    ...(shows('issues') ? shownIssues() : []).map((x) => ({ ...x, kind: 'issue', key: ghKey(x.item) })),
  ];

  function move(d) {
    const keys = selectable().map((x) => x.key);
    if (!keys.length) return;
    const i = keys.indexOf(sel);
    sel = keys[i < 0 ? 0 : Math.min(keys.length - 1, Math.max(0, i + d))];
  }

  // What keys act on: the PR or issue whose page shows, or else the selection.
  const chosen = () => detail || selectable().find((y) => y.key === sel);

  function open() {
    const x = chosen();
    if (!x) return say(dim('pick an agent, PR or issue with j/k first'));
    return x.kind === 'agent' ? jump(x.item) : worktree(x.kind, x.item.number);
  }

  // The GitHub web page of the PR or issue keys act on, or why there's none: data cached before URLs were
  // fetched has no link until it refreshes. Only web pages, since the opener would run anything else.
  function page() {
    const x = chosen();
    if (x?.kind !== 'pr' && x?.kind !== 'issue') return { why: 'pick a PR or issue with j/k first' };
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
  // from GitHub, by its URL, when it opens, on [r] and every minute while it shows. Returns the fetch, for tests.
  function drill() {
    const x = chosen(), p = page();
    if (!p.url) return say(dim(p.why));
    detail = { kind: x.kind, key: x.key, item: x.item, scroll: 0 };
    return fetchDetail();
  }
  function fetchDetail() {
    const { key, item } = detail;
    if (!fetching.has(key)) fetching.set(key, (async () => {
      try { got.set(key, { data: await fetchDetails(item.url) }); } catch (e) { got.set(key, { ...got.get(key), err: firstLine(e) }); }
      fetching.delete(key);
      screen.draw();
    })());
    return fetching.get(key);
  }
  // The page's lines, w columns wide. They're kept until its details or the width change: wrapping them at 10
  // frames a second would be slow.
  function pageLines(w) {
    const g = got.get(detail.key);
    if (drawn?.detail !== detail || drawn.got !== g || drawn.w !== w) drawn = { detail, got: g, w, lines: renderDetail({ ...detail, got: g }, w) };
    return drawn.lines;
  }
  // The rows the page has on screen, between the key bar's band and the band at the bottom.
  const room = () => Math.max(1, (stdout.rows || 50) - 4);
  const scrollTo = (top) => { detail.scroll = Math.max(0, Math.min(top, pageLines(stdout.columns || 100).length - room())); };
  // On a page, keys scroll it, and ←, esc or backspace go back to the lists, with the same selection.
  function pageKey(s) {
    const { scroll } = detail, rows = room();
    if (LEFT.includes(s) || s === '\x1b' || s === '\x7f' || s === '\b') detail = null;
    else if (s === 'j' || DOWN.includes(s)) scrollTo(scroll + 1);
    else if (s === 'k' || UP.includes(s)) scrollTo(scroll - 1);
    else if (s === ' ' || s === '\x06' || s === '\x1b[6~') scrollTo(scroll + rows - 1); // space, ctrl-f, page down
    else if (s === '\x02' || s === '\x1b[5~') scrollTo(scroll - rows + 1); // ctrl-b, page up
    else if (s === '\x04') scrollTo(scroll + (rows >> 1)); // ctrl-d
    else if (s === '\x15') scrollTo(scroll - (rows >> 1)); // ctrl-u
    else if (HOME.includes(s)) scrollTo(0);
    else if (END.includes(s)) scrollTo(Infinity);
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

  // The dashboard's rows: the header, the key bar and a band, then the sections, or else the page that shows,
  // from where it's scrolled to.
  function frame() {
    const custom = [...config.keymaps.values()].filter((k) => !detail || k.on.includes(detail.kind))
      .map((k) => `[${plain(k.key)}] ${plain(k.label)}  `).join('');
    let lines = [], top = 0, keys;
    const section = (key, render, loading) =>
      state[key + 'Err'] ? [head(key.toUpperCase()), red('  ' + plain(state[key + 'Err']))] : state[key] ? render(state[key]) : [head(key.toUpperCase()), dim('  ' + loading)];
    const off = SECTIONS.filter((s) => hidden.has(s)), old = [...stale].filter(needed); // a hidden section's cache stays old
    if (detail) {
      lines = pageLines(stdout.columns || 100);
      const end = Math.max(0, lines.length - room());
      top = detail.scroll = Math.min(detail.scroll, end); // the pane may have grown
      keys = dim(`[←] back  [j/k] scroll${end ? ` ${top + 1}-${Math.min(lines.length, top + room())} of ${lines.length}` : ''}  ` +
        `[⏎] worktree  [o] browser  ${custom}[r] refresh  [q] quit`);
    } else {
      keys = typing ? `${cyan('/')}${bold(plain(filter.query))}${CURSOR}  ${dim('[⏎] keep  [→] details  [esc] clear  [↑/↓] select')}`
        : `${filter.query ? `${cyan('/')}${bold(plain(filter.query))}  ${dim('[esc] clear')}  ` : ''}${dim(`[j/k] select  [⏎] open  [l/→] details  [o] browser  ${custom}[/] filter  [1-${SECTIONS.length}] hide  [s] shader`)} ${shaded(effects.fx.shader)}  ${dim('[e] fx')} ${shaded(effects.fx.effect)}  ${dim('[r] refresh  [q] quit')}`;
    }
    return [
      `${bold(shaded('REX // COCKPIT'))} ${dim('·')} ${repo ? `${bold(plain(repo.name))} ${dim('·')} ` : ''}${new Date().toString().slice(0, 21)}` +
        (old.length ? `  ${dim(`cached ${ago(Math.min(...old.map((k) => fetched[k])))}`)}` : '') +
        (off.length && !once ? `  ${dim(`hidden ${off.map((s) => `[${SECTIONS.indexOf(s) + 1}] ${s.replace('_', ' ')}`).join(' ')}`)}` : '') +
        (flash && Date.now() < flash.until ? `  ${flash.text}` : '') +
        (config.errors.length ? `  ${red(`config: ${plain(config.errors[0])}`)}${config.errors.length > 1 ? dim(` (+${config.errors.length - 1} more)`) : ''}` : ''),
      ...(once ? [] : [keys, BAND]),
      ...(detail ? lines.slice(top) : [
        ...(needed('fleet') ? section('fleet', renderFleet, 'asking Rex…') : []),
        ...(needed('usage') ? section('usage', renderUsage, `reading ${tilde(PROJECTS)}…`) : []),
        ...(needed('prs') ? section('prs', (d) => renderPRs(d, { review: shows('review_requests'), mine: shows('my_prs') }), 'asking GitHub…') : []),
        ...(needed('issues') ? section('issues', renderIssues, 'asking GitHub…') : []),
      ]),
    ].flatMap((l) => l.split('\n'));
  }

  // Hides and shows sections. A source that a section shows again is fetched at once, once the dashboard runs.
  function setHidden(next) {
    const was = Object.keys(SOURCES).filter(needed);
    hidden = next;
    if (live) for (const [k, [fn]] of Object.entries(SOURCES)) if (needed(k) && !was.includes(k)) refresh(k, fn);
  }
  // Keys 1 to 5 hide and show a section, for the session only.
  const toggle = (s) => { setHidden(new Set(SECTIONS.filter((x) => (x === s) !== hidden.has(x)))); report(); };

  const quit = () => { save(); stdout.write(`\x1b[0m\x1b[?25h\x1b[?1049l${rex.PANE_FORGET}`); process.exit(0); };
  // Reading the config again changes only the sections whose hide changed in it.
  function reloadConfig() {
    if (givenConfig) return;
    const was = config.hide;
    config = loadConfig();
    setHidden(rehide(hidden, was, config.hide));
  }
  // One key: a character, or an arrow's (or another key's) escape code. The caller draws. A keymap's key
  // returns its launch, and [l] the page's fetch, for tests to wait on; keymaps never have the dashboard's own
  // keys. On a page, keymaps, q, r, o, Enter, s and e act on its PR or issue as on the selection; the rest move.
  function press(s) {
    if (typing) return filterKey(s);
    if (config.keymaps.has(s)) return launch(config.keymaps.get(s));
    if (s === 'q' || s === '\x03') quit();
    if (s === 'r') { reloadConfig(); report(); refreshAll(); if (detail) fetchDetail(); }
    if (s === 'o') browse();
    if (s === '\r') open();
    if (s === 's') { effects.fx.shader = cycle(Object.keys(SHADERS), effects.fx.shader); effects.saveFx(); }
    if (s === 'e') { effects.fx.effect = cycle(EFFECTS, effects.fx.effect); effects.saveFx(); }
    if (detail) return pageKey(s);
    if (s === 'j' || DOWN.includes(s)) move(1);
    if (s === 'k' || UP.includes(s)) move(-1);
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

  const SOURCES = { fleet: [() => fleet(repo), 3e3], prs: [() => prs(repo), 60e3], issues: [() => issues(repo), 60e3], usage: [() => usageClient(), 300e3] };
  const refreshAll = () => Object.entries(SOURCES).map(([k, [fn]]) => refresh(k, fn));

  const save = () => cache.write('state.json', {
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
      // A cached GitHub name is used at once and checked behind it. If it changed, PRs and issues are
      // fetched again, after any fetch for the old name finishes.
      const check = githubName(dir);
      named(repo, saved && 'gh' in saved ? saved.gh : await check);
      check.then((gh) => {
        if (gh === repo.gh) return;
        named(repo, gh);
        for (const k of ['prs', 'issues']) Promise.resolve(busy.get(k)).then(() => refresh(k, SOURCES[k][0]));
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

  return { main, frame, press, selectable, setQuery, page, refreshAll, state };
}
module.exports = { createApp };
